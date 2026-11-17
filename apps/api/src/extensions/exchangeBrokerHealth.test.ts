import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeBrokerHealth } from './exchangeBrokerHealth';
function fixture(){const socket=new EventEmitter() as EventEmitter&{write:ReturnType<typeof vi.fn>;destroy:ReturnType<typeof vi.fn>};socket.write=vi.fn();socket.destroy=vi.fn();return {socket,connect:vi.fn(()=>socket as unknown as Socket)};}
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe('Exchange broker health',()=>{
  it('does not connect when unconfigured',async()=>{vi.stubEnv('CLOUDCOM_EXCHANGE_SOCKET_PATH','');const f=fixture();expect((await exchangeBrokerHealth(undefined,f.connect)).status).toBe('unknown');expect(f.connect).not.toHaveBeenCalled();});
  it('probes only invalid empty JSON and accepts bounded rejection',async()=>{
    const f=fixture(),result=exchangeBrokerHealth('/run/exchange.sock',f.connect);f.socket.emit('connect');
    expect(f.socket.write).toHaveBeenCalledWith('{}\n');
    f.socket.emit('data',Buffer.from('{"ok":false,"code":"invalid_'));f.socket.emit('data',Buffer.from('request"}\n'));
    expect((await result).status).toBe('healthy');expect(f.socket.destroy).toHaveBeenCalledOnce();
  });
  it.each(['error','end','close'])('reports critical on %s',async event=>{const f=fixture(),result=exchangeBrokerHealth('/run/exchange.sock',f.connect);f.socket.emit(event);expect((await result).status).toBe('critical');});
  it.each(['not json\n','{"ok":true}\n','x'.repeat(1025)])('rejects malformed or oversized replies',async reply=>{const f=fixture(),result=exchangeBrokerHealth('/run/exchange.sock',f.connect);f.socket.emit('data',Buffer.from(reply));expect((await result).status).toBe('critical');});
  it('destroys a silent connection at the total deadline',async()=>{vi.useFakeTimers();const f=fixture(),result=exchangeBrokerHealth('/run/exchange.sock',f.connect);await vi.advanceTimersByTimeAsync(1000);expect((await result).status).toBe('critical');expect(f.socket.destroy).toHaveBeenCalledOnce();});
});
