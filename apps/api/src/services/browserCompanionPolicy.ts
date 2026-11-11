import { z } from 'zod';
const uuid=z.string().uuid();
export const companionCallSchema=z.object({orgId:uuid.optional(),deviceId:uuid.optional(),path:z.string().max(4096),method:z.enum(['GET','POST','PUT','DELETE']).default('GET'),body:z.unknown().optional()}).strict();
export function classifyCompanionCall(input:z.infer<typeof companionCallSchema>){
  const {path,method,orgId,deviceId}=input;
  if(!path.startsWith('/')||path.startsWith('//')||/[\\#\r\n]/.test(path))return null;
  const u=new URL(path,'https://companion.invalid');
  if(u.origin!=='https://companion.invalid'||u.pathname!==path.split('?')[0]||u.searchParams.has('orgId'))return null;
  if(method==='GET'&&path==='/credentials/browser/clients'&&!deviceId)return {kind:'clients' as const};
  if(!orgId)return null;
  const workBase=`/companion-work/orgs/${orgId}`;
  if(!deviceId&&['GET','POST'].includes(method)&&(u.pathname===workBase||new RegExp(`^${workBase}/[0-9a-f-]{36}$`,'i').test(u.pathname)))return {kind:'client' as const};
  const credentialBase=`/credentials/browser/orgs/${orgId}`;
  if(!deviceId&&method==='GET'&&[`${credentialBase}/devices`,`${credentialBase}/credentials`].includes(u.pathname))return {kind:'client' as const};
  if(!deviceId&&method==='POST'&&new RegExp(`^${credentialBase}/credentials/[0-9a-f-]{36}/fill$`,'i').test(u.pathname))return {kind:'client' as const};
  const vaultBase=`/credentials/orgs/${orgId}`;
  if(!deviceId&&method==='GET'&&(u.pathname===vaultBase+'/credentials'||u.pathname===vaultBase+'/documents'||new RegExp(`^${vaultBase}/documents/[0-9a-f-]{36}$`,'i').test(u.pathname)))return {kind:'client' as const};
  if(!deviceId&&method==='POST'&&new RegExp(`^${vaultBase}/credentials/[0-9a-f-]{36}/(reveal|otp)$`,'i').test(u.pathname))return {kind:'client' as const};
  if(!deviceId)return null;
  const scriptsBase=`/companion-scripts/orgs/${orgId}/devices/${deviceId}`;
  if(method==='POST'&&u.pathname===scriptsBase+'/service-startup')return {kind:'device' as const};
  if(method==='GET'&&[scriptsBase+'/catalog',scriptsBase+'/tickets',scriptsBase+'/runs'].includes(u.pathname)||method==='POST'&&u.pathname===scriptsBase+'/runs'||method==='GET'&&new RegExp(`^${scriptsBase}/runs/[0-9a-f-]{36}$`,'i').test(u.pathname))return {kind:'device' as const};
  if(method==='GET'&&u.pathname===`/devices/${deviceId}`)return {kind:'device' as const};
  if(method==='POST'&&u.pathname===`/staff-native/launch/${deviceId}`)return {kind:'device' as const};
  const base=`/system-tools/devices/${deviceId}/`;
  if(u.pathname.startsWith(base)){
    const suffix=u.pathname.slice(base.length);
    if(method==='GET'&&(suffix==='network-scan/networks'||/^network-scan\/runs\/[0-9a-f-]{36}$/i.test(suffix)))return {kind:'device' as const};
    if(method==='POST'&&suffix==='network-scan')return {kind:'device' as const};
    const reads=/^(processes(?:\/\d+)?|services(?:\/[^/]+)?|eventlogs(?:\/[^/]+\/events(?:\/[^/]+)?)?|tasks(?:\/[^/]+(?:\/history)?)?|registry\/(keys|values|value)|files(?:\/(drives|download|trash))?)$/;
    const posts=/^(processes\/\d+\/kill|services\/[^/]+\/(start|stop|restart)|tasks\/[^/]+\/(run|enable|disable)|registry\/key|files\/(upload|copy|move|delete|trash\/restore))$/;
    if(method==='GET'&&reads.test(suffix)||method==='POST'&&posts.test(suffix)||method==='PUT'&&suffix==='registry/value'||method==='DELETE'&&/^registry\/(key|value)$/.test(suffix))return {kind:'device' as const};
  }
  if(method==='POST'&&path==='/remote/sessions'){
    const body=z.object({deviceId:z.literal(deviceId),type:z.literal('terminal')}).strict().safeParse(input.body);
    if(body.success)return {kind:'device' as const};
  }
  const session=u.pathname.match(/^\/remote\/sessions\/([0-9a-f-]{36})\/(ws-ticket|end)$/i);
  if(method==='POST'&&session&&uuid.safeParse(session[1]).success)return {kind:'session' as const,sessionId:session[1]!};
  return null;
}

