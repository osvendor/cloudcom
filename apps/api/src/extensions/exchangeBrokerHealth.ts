import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import type { HealthCard } from '@cloudcom/ext-cloud-command';

/** Same deliberately invalid request as the worker's container healthcheck.
 * Rejected before tenant lookup/admission, so no Exchange/PowerShell session.
 * Total deadline and response cap also bound a stalled or malformed broker.
 */
export async function exchangeBrokerHealth(
  path=process.env.CLOUDCOM_EXCHANGE_SOCKET_PATH,
  connect:(path:string)=>Socket=path=>createConnection(path),
):Promise<HealthCard>{
  const base={id:'exchange-worker',title:'Exchange worker'};
  if(!path)return {...base,status:'unknown',value:'Not configured',detail:'Exchange broker socket is not configured. API worker readiness does not include this separate service.'};
  const unavailable=():HealthCard=>({...base,status:'critical',value:'Unavailable',detail:'The configured Exchange broker did not answer its local health probe. Mailbox delegation and other Exchange tools may be unavailable. No tenant session was opened.'});
  if(!isAbsolute(path))return unavailable();
  const healthy=await new Promise<boolean>(resolve=>{
    let socket:Socket|undefined,finished=false,received=Buffer.alloc(0);
    const finish=(ok:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);socket?.destroy();resolve(ok);};
    const timer=setTimeout(()=>finish(false),1000);
    try{
      socket=connect(path);
      socket.once('connect',()=>socket!.write('{}\n'));
      socket.on('data',(chunk:Buffer)=>{
        if(received.length+chunk.length>1024)return finish(false);
        received=Buffer.concat([received,chunk]);
        const newline=received.indexOf(10);if(newline<0)return;
        try{const value=JSON.parse(received.subarray(0,newline).toString('utf8'));finish(value?.ok===false&&value?.code==='invalid_request');}catch{finish(false);}
      });
      socket.once('error',()=>finish(false));socket.once('end',()=>finish(false));socket.once('close',()=>finish(false));
    }catch{finish(false);}
  });
  return healthy?{...base,status:'healthy',value:'Responding',detail:'Local broker probe succeeded without opening a tenant or PowerShell session. Microsoft authorization and tenant operations are not tested.'}:unavailable();
}
