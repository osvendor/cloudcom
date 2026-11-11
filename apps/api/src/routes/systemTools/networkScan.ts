import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceIpHistory, deviceCommands } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { queueCommandForExecution } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { deviceIdParamSchema } from './schemas';
import { lookupMacVendor } from '../../services/macVendorLookup';

function ipv4(value:string):number|null {
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return null;
  const bytes=value.split('.').map(Number);
  if(bytes.some(b=>b>255))return null;
  return bytes.reduce((n,b)=>n*256+b,0);
}
export function reportedSubnet(ip:string,mask:string|null):string|null {
  const address=ipv4(ip);if(address===null||!mask)return null;
  let prefix:number;
  if(/^\/?\d{1,2}$/.test(mask))prefix=Number(mask.replace('/',''));
  else {
    const bits=ipv4(mask);if(bits===null)return null;
    const binary=bits.toString(2).padStart(32,'0');
    if(!/^1*0*$/.test(binary))return null;
    prefix=binary.indexOf('0');if(prefix===-1)prefix=32;
  }
  if(prefix<0||prefix>32)return null;
  const size=2**(32-prefix),network=Math.floor(address/size)*size;
  return [24,16,8,0].map(shift=>Math.floor(network/2**shift)%256).join('.')+'/'+prefix;
}
// Scan scope is the selected device IP's /24, as requested by the owner.
export function normalizeScanSubnet(value:string):string|null {
  const [ip,prefixText]=value.split('/');
  if(!ip||!prefixText||!/^\d{1,2}$/.test(prefixText))return null;
  const prefix=Number(prefixText),bytes=ip.split('.').map(Number);
  if(prefix<24||prefix>32||!(bytes[0]===10||bytes[0]===172&&bytes[1]!>=16&&bytes[1]!<=31||bytes[0]===192&&bytes[1]===168))return null;
  return reportedSubnet(ip,prefixText);
}
async function networks(deviceId:string,orgId:string){
  const rows=await db.select().from(deviceIpHistory).where(and(eq(deviceIpHistory.deviceId,deviceId),eq(deviceIpHistory.orgId,orgId),eq(deviceIpHistory.isActive,true),eq(deviceIpHistory.ipType,'ipv4')));
  return rows.map(r=>{const subnet=reportedSubnet(r.ipAddress,'24');return {id:r.id,interfaceName:r.interfaceName,ipAddress:r.ipAddress,subnet,supported:!!subnet&&normalizeScanSubnet(subnet)!==null};});
}
const scanSchema=z.object({networkId:z.uuid()}).strict();
const agentResultSchema=z.object({hosts:z.array(z.object({ip:z.ipv4(),hostname:z.string().max(1024).optional(),snmpData:z.object({sysName:z.string().max(1024).optional()}).nullable().optional(),mac:z.string().max(64).optional(),manufacturer:z.string().max(256).optional(),openPorts:z.array(z.object({port:z.number().int().min(1).max(65535)})).optional()})).max(256),hostsScanned:z.number().int().nonnegative().max(256)});
export const networkScanRoutes=new Hono();
// Parent router enforces MFA, device execution permission and remote access policy.
networkScanRoutes.get('/devices/:deviceId/network-scan/networks',zValidator('param',deviceIdParamSchema),async c=>{
  const device=await getDeviceWithOrgAndSiteCheck(c,c.req.valid('param').deviceId,c.get('auth'));
  if(device===SITE_ACCESS_DENIED)return c.json({error:'Access to this site denied'},403);
  if(!device)return c.json({error:'Device unavailable'},404);
  return c.json({data:await networks(device.id,device.orgId)});
});
networkScanRoutes.post('/devices/:deviceId/network-scan',zValidator('param',deviceIdParamSchema),zValidator('json',scanSchema),async c=>{
  const {deviceId}=c.req.valid('param'),auth=c.get('auth');
  const device=await getDeviceWithOrgAndSiteCheck(c,deviceId,auth);
  if(device===SITE_ACCESS_DENIED)return c.json({error:'Access to this site denied'},403);
  if(!device)return c.json({error:'Device unavailable'},404);
  const network=(await networks(deviceId,device.orgId)).find(n=>n.id===c.req.valid('json').networkId);
  if(!network)return c.json({error:'This network is no longer active on the selected device. Refresh the network list.'},409);
  if(!network.supported)return c.json({error:'The selected network must have a private IPv4 address.'},400);
  const result=await queueCommandForExecution(deviceId,'network_discovery',{
    companionScan:true,subnets:[network.subnet],excludeIps:[],methods:['arp','port_scan','snmp'],portRanges:['80','443','445'],
    snmpCommunities:['public'],snmpCredentials:[],timeout:1,concurrency:32,deepScan:false,identifyOS:false,resolveHostnames:true,
  },{userId:auth.user.id,expectedOrgId:device.orgId,offlinePolicy:{kind:'reject'}});
  if(!result.command)return c.json({error:result.error||'Could not start network scan'},409);
  await createAuditLog({orgId:device.orgId,actorId:auth.user.id,actorEmail:auth.user.email,action:'network_scan_started',resourceType:'device',resourceId:deviceId,resourceName:device.hostname??device.id,details:{subnet:network.subnet,commandId:result.command.id},ipAddress:getTrustedClientIpOrUndefined(c),result:'success'});
  return c.json({scanId:result.command.id,status:'pending',meta:{subnet:network.subnet}},202);
});
networkScanRoutes.get('/devices/:deviceId/network-scan/runs/:scanId',zValidator('param',deviceIdParamSchema.extend({scanId:z.uuid()})),async c=>{
  const {deviceId,scanId}=c.req.valid('param'),auth=c.get('auth');
  const device=await getDeviceWithOrgAndSiteCheck(c,deviceId,auth);
  if(device===SITE_ACCESS_DENIED)return c.json({error:'Access to this site denied'},403);
  if(!device)return c.json({error:'Device unavailable'},404);
  const [run]=await db.select().from(deviceCommands).where(and(eq(deviceCommands.id,scanId),eq(deviceCommands.deviceId,deviceId),eq(deviceCommands.submittedOrgId,device.orgId),eq(deviceCommands.createdBy,auth.user.id),eq(deviceCommands.type,'network_discovery'))).limit(1);
  const params=run?.payload as {companionScan?:boolean;subnets?:string[]}|undefined;
  if(!run||params?.companionScan!==true)return c.json({error:'Scan unavailable'},404);
  if(['pending','sent','running','queued'].includes(run.status))return c.json({status:run.status});
  const result=run.result as {exitCode?:number;stdout?:string}|null;
  if(run.status!=='completed'||result?.exitCode!==0)return c.json({error:'Network scan failed or timed out. Try again when the device is online.'},409);
  let payload:z.infer<typeof agentResultSchema>;
  try{payload=agentResultSchema.parse(JSON.parse(result.stdout||'{}'));}catch{return c.json({error:'Invalid network scan response from the agent'},500);}
  return c.json({status:'completed',data:payload.hosts.map(h=>({ip:h.ip,hostname:h.hostname?.trim()||h.snmpData?.sysName?.trim()||null,mac:h.mac||null,manufacturer:h.manufacturer?.trim()||lookupMacVendor(h.mac),manufacturerSource:h.manufacturer?.trim()?'device':lookupMacVendor(h.mac)?'mac_oui':null,httpsPortOpen:(h.openPorts??[]).some(p=>p.port===443)})),meta:{subnet:params.subnets?.[0],hostsScanned:payload.hostsScanned,hostsDiscovered:payload.hosts.length}});
});




