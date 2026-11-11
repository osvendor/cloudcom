import {describe,it,expect} from 'vitest';
import {auditWorkActivity,workCanAutoClose} from './companionWorkModel';
const done={id:'one',label:'Restarted service',at:'2026-10-08T10:00:00.000Z',state:'success' as const};
describe('Work timeline safety',()=>{
 it('requires opt-in, completed evidence and fifteen minutes inactivity',()=>{expect(workCanAutoClose([done],true,Date.parse('2026-10-08T10:15:00Z'))).toBe(true);expect(workCanAutoClose([done],false,Infinity)).toBe(false);expect(workCanAutoClose([],true,Infinity)).toBe(false);expect(workCanAutoClose([done],true,Date.parse('2026-10-08T10:14:59Z'))).toBe(false);});
 it('failures and pending actions hold open even after subsequent success',()=>{for(const state of ['failure','pending'] as const)expect(workCanAutoClose([{...done,state},done],true,Infinity)).toBe(false);});
 it('unknown timestamps never auto close',()=>{expect(workCanAutoClose([{...done,at:'invalid'}],true,Infinity)).toBe(false);});
 it('labels are allowlisted and never echo supplied details',()=>{const row={id:'id',timestamp:done.at,action:'set_registry_value',result:'success',details:{password:'SECRET'},errorMessage:'SECRET'};const event=auditWorkActivity(row);expect(event?.label).toBe('Changed registry value');expect(JSON.stringify(event)).not.toContain('SECRET');expect(auditWorkActivity({...row,action:'get_processes'})).toBeNull();expect(auditWorkActivity({...row,result:'unknown'})?.state).toBe('failure');});
});
