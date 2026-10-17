import {z} from 'zod';

export const serviceStartupSchema=z.object({
  name:z.string().min(1).max(256).regex(/^[A-Za-z0-9_$ .-]+$/),
  startType:z.enum(['auto','manual','disabled']),
  expectedStartType:z.enum(['auto','auto_delayed','manual','disabled']),
}).strict();
export type ServiceStartupInput=z.infer<typeof serviceStartupSchema>;
export function serviceStartupScript(raw:ServiceStartupInput){
  const input=serviceStartupSchema.parse(raw);
  const payload=Buffer.from(JSON.stringify(input),'utf8').toString('base64');
  return `$ErrorActionPreference='Stop'
$inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$service=Get-CimInstance Win32_Service | Where-Object { $_.Name -ceq $inputData.name } | Select-Object -First 1
if(-not $service){throw 'Service not found'}
$regPath='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+$service.Name
function Read-StartType($svc){
  if($svc.StartMode -eq 'Auto'){
    $delayed=(Get-ItemProperty -LiteralPath $regPath -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart
    if($delayed -eq 1){return 'auto_delayed'}
    return 'auto'
  }
  if($svc.StartMode -eq 'Manual'){return 'manual'}
  if($svc.StartMode -eq 'Disabled'){return 'disabled'}
  throw 'Unsupported service startup type'
}
$before=Read-StartType $service
if($before -ne $inputData.expectedStartType){throw 'Startup type changed. Refresh services before trying again.'}
$mode=@{auto='Automatic';manual='Manual';disabled='Disabled'}[$inputData.startType]
$change=Invoke-CimMethod -InputObject $service -MethodName ChangeStartMode -Arguments @{StartMode=$mode}
if($change.ReturnValue -ne 0){throw ('Windows rejected the startup change: '+$change.ReturnValue)}
if($inputData.startType -eq 'auto'){Set-ItemProperty -LiteralPath $regPath -Name DelayedAutoStart -Value 0 -Type DWord}
$after=Read-StartType (Get-CimInstance Win32_Service | Where-Object { $_.Name -ceq $inputData.name } | Select-Object -First 1)
if($after -ne $inputData.startType){throw 'Windows did not confirm the requested startup type'}
@{success=$true;name=$service.Name;previousStartType=$before;startType=$after} | ConvertTo-Json -Compress
`;
}
export function parseServiceStartupResult(raw:unknown,input:ServiceStartupInput){
  const result=raw as {exitCode?:number;stdout?:string}|null;
  if(result?.exitCode!==0||typeof result.stdout!=='string'||result.stdout.length>10000)throw Error('Startup change was not confirmed. Refresh services before retrying.');
  let value:any;try{value=JSON.parse(result.stdout.trim());}catch{throw Error('Startup change returned an invalid result. Refresh services before retrying.');}
  if(value?.success!==true||value.name!==input.name||value.startType!==input.startType||value.previousStartType!==input.expectedStartType)throw Error('Startup change readback did not match the request. Refresh services before retrying.');
  return {success:true as const,name:input.name,startType:input.startType,previousStartType:input.expectedStartType};
}
