import {describe,it,expect} from 'vitest';
import {serviceStartupSchema,serviceStartupScript,parseServiceStartupResult} from './companionServiceStartupScript';
const input={name:'Spooler',startType:'manual' as const,expectedStartType:'auto' as const};
describe('bounded service startup command',()=>{
 it.each(['x; Remove-Item','x\nfoo',"x'",'x\\y','x*'])('rejects unsafe service name %s',name=>expect(serviceStartupSchema.safeParse({...input,name}).success).toBe(false));
 it('accepts only supported types and no arbitrary script',()=>{expect(serviceStartupSchema.safeParse({...input,startType:'boot'}).success).toBe(false);expect(serviceStartupSchema.safeParse({...input,content:'bad'}).success).toBe(false);});
 it('supports named SQL instances without interpolating their name into executable code',()=>{const name='MSSQL$INSTANCE';expect(serviceStartupSchema.safeParse({...input,name}).success).toBe(true);expect(serviceStartupScript({...input,name})).not.toContain(name);});
 it('only changes startup mode and verifies it without starting/stopping the service',()=>{const script=serviceStartupScript(input);expect(script).toContain('ChangeStartMode');expect(script).toContain('expectedStartType');expect(script).not.toMatch(/(?:Stop|Start|Restart)-Service/);});
 it('requires exact successful readback',()=>{
  const result={success:true,name:'Spooler',startType:'manual',previousStartType:'auto'};
  expect(parseServiceStartupResult({exitCode:0,stdout:JSON.stringify(result)},input).startType).toBe('manual');
  expect(()=>parseServiceStartupResult({exitCode:1,stdout:JSON.stringify(result)},input)).toThrow();
  expect(()=>parseServiceStartupResult({exitCode:0,stdout:JSON.stringify({...result,startType:'auto'})},input)).toThrow();
 });
});
