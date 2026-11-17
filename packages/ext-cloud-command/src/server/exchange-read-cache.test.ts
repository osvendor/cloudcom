import { describe, expect, it, vi } from 'vitest';
import { createExchangeReadCache, type ExchangeReadCachePort } from './exchange-read-cache';
import type { AdministrationConnection } from './admin-execution';
import type { MicrosoftRequest } from './native-microsoft';
const binding = { orgId:'org', id:'connection', tenantId:'tenant',clientId:'client',credentialVersion:'v1',generation:1,permissionManifestVersion:'p1',enabled:true } as AdministrationConnection;
function setup() {
  const values = new Map<string, unknown>(), leases = new Map<string, string>(), pending: Array<()=>Promise<void>> = [];
  let clock = 1_000_000, serial = 0;
  const port: ExchangeReadCachePort = {
    get: async key=>values.get(key) ?? null,
    set: async (key,value)=>{values.set(key,value);}, delete: async key=>{values.delete(key);},
    claim: async key=>{if(leases.has(key))return null;const token=String(++serial);leases.set(key,token);return token;},
    release: async(key,token)=>{if(leases.get(key)===token)leases.delete(key);},
    epoch: async(key,rotate)=>{if(rotate||!values.has(key))values.set(key,String(++serial));return values.get(key) as string;},
    runDetached: (_request,work)=>{pending.push(work);}, withRequestDb: async(_request,work)=>work(),
  };
  const cache=createExchangeReadCache(port,()=>clock), request={} as MicrosoftRequest;
  const read=(refresh:()=>Promise<unknown>,force=false,b= binding,mailbox='mailbox')=>cache.read(request,b,'mailbox.forwarding.get',mailbox,undefined,force,refresh);
  return {cache,read,pending,advance:(ms:number)=>{clock+=ms;}};
}
describe('targeted Exchange read cache',()=>{
  it('retries only worker admission rejection while retaining the refresh lease',async()=>{
    vi.useFakeTimers();
    try {
      const h=setup(), refresh=vi.fn().mockRejectedValueOnce({code:'worker_busy'}).mockResolvedValue({enabled:true});
      await h.read(refresh);const task=h.pending.shift()!();
      await vi.advanceTimersByTimeAsync(2000);await task;
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(await h.read(refresh)).toMatchObject({enabled:true,cache:{refreshing:false}});
    } finally {vi.useRealTimers();}
  });
  it('bounds worker-busy retries and exposes a failed refresh without losing last good data',async()=>{
    vi.useFakeTimers();
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const h=setup(), refresh=vi.fn().mockRejectedValue({code:'worker_busy'});
      await h.read(refresh);const task=h.pending.shift()!();
      await vi.advanceTimersByTimeAsync(40000);await task;
      expect(refresh).toHaveBeenCalledTimes(20);
      expect(await h.read(refresh)).toMatchObject({pending:true,cache:{refreshing:false,refreshFailed:true}});
    } finally {warn.mockRestore();vi.useRealTimers();}
  });
  it('returns pending immediately, deduplicates and serves fresh data',async()=>{
    const h=setup(), refresh=vi.fn(async()=>({smtpAddress:'person@example.test'}));
    expect(await h.read(refresh)).toMatchObject({pending:true,cache:{refreshing:true}});
    await h.read(refresh);expect(h.pending).toHaveLength(1);expect(refresh).not.toHaveBeenCalled();
    await h.pending.shift()!();
    expect(await h.read(refresh)).toMatchObject({smtpAddress:'person@example.test',cache:{stale:false,refreshing:false}});
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('keeps last good value after stale refresh fails and backs off',async()=>{
    const h=setup();await h.read(async()=>({enabled:true}));await h.pending.shift()!();h.advance(300001);
    expect(await h.read(async()=>{throw Error('private provider details');})).toMatchObject({enabled:true,cache:{stale:true,refreshing:true}});
    await h.pending.shift()!();await h.read(async()=>({enabled:false}));expect(h.pending).toHaveLength(0);
    expect(await h.read(async()=>({enabled:false}),true)).toMatchObject({enabled:true,cache:{refreshing:true}});
  });
  it('does not resurrect an in-flight pre-mutation result',async()=>{
    const h=setup();await h.read(async()=>({old:true}));await h.cache.invalidate(binding,'mailbox');await h.pending.shift()!();
    expect(await h.read(async()=>({new:true}))).toMatchObject({pending:true});
  });
  it('isolates organization and generation while limiting global background work',async()=>{
    const h=setup();await h.read(async()=>({old:true}));
    expect(await h.read(async()=>({other:true}),false,{...binding,orgId:'other'})).toMatchObject({pending:true});
    expect(h.pending).toHaveLength(1);await h.pending.shift()!();
    expect(await h.read(async()=>({new:true}),false,{...binding,generation:2})).toMatchObject({pending:true});
  });
});
