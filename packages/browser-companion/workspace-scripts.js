import {el,button} from './workspace-ui.js';
export async function renderScripts(opts){
 const {root,request,status,isCurrent}=opts,base=`/companion-scripts/orgs/${encodeURIComponent(opts.orgId)}/devices/${encodeURIComponent(opts.deviceId)}`;
 const schedule=opts.setTimer||setTimeout,cancel=opts.cancelTimer||clearTimeout;
 let timer,busy=false,ready=false,continueAfterPreview=false,pendingBody=null,pendingId=null,disposed=false;
 const active=()=>!disposed&&isCurrent();
 opts.onDispose?.(()=>{disposed=true;continueAfterPreview=false;cancel(timer);});root.classList.add('scripts-view');
 const row=el('div',null,{className:'script-history-row'}),name=el('strong','Clear stuck print jobs',{className:'script-name',title:'Stops Print Spooler, removes pending print jobs for every printer on this computer, then restarts Print Spooler.'}),last=el('time','Never run',{className:'script-last'}),state=el('span','Not run',{className:'script-state',role:'status'});
 const run=button('Run',start);run.classList.add('script-run');run.title=name.title;run.disabled=true;
 row.append(name,last,state,run);root.append(row);
 function label(text,tone=''){state.textContent=text;state.className='script-state'+(tone?' '+tone:'');}
 function lock(){run.disabled=!ready||busy;run.textContent='Run';}
 function stamp(r){if(!r.createdAt)return;const d=new Date(r.createdAt);if(Number.isNaN(d.valueOf()))return;last.dateTime=d.toISOString();last.textContent=d.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});last.title='Last run: '+d.toLocaleString();}
 function recover(error){busy=true;label('Status unknown','failure');run.disabled=false;run.textContent='Check';status('Run status could not be confirmed. Use Check to avoid starting it twice.',true);}
 async function submit(mode,previewRequestId){
  if(!active())return;
  busy=true;lock();label(mode==='preview'?'Preparing…':'Running…');
  pendingBody={requestId:crypto.randomUUID(),scriptId:'clear-print-spool',mode,...(mode==='execute'?{previewRequestId,createTicket:true}:{})};pendingId=pendingBody.requestId;
  try{await request(base+'/runs','POST',pendingBody);if(active())await check(pendingId);}catch(e){if(active())recover(e);}
 }
 async function start(){
  if(!active()||!ready)return;
  if(run.textContent==='Check'){
   run.disabled=true;try{if(pendingBody)await request(base+'/runs','POST',pendingBody);if(active())await check(pendingId);}catch(e){if(active())recover(e);}return;
  }
  if(busy)return;continueAfterPreview=true;status('');await submit('preview');
 }
 async function check(id){
  if(!id||!active())return;cancel(timer);
  try{
   const data=await request(base+'/runs/'+encodeURIComponent(id));if(!active())return;
   const r=data.run;pendingBody=null;pendingId=id;
   if(r.mode==='execute')stamp(r);
   if(['queued','running'].includes(r.status)){busy=true;lock();label(r.mode==='preview'?'Preparing…':'Running…');timer=schedule(()=>check(id),2000);return;}
   const success=r.status==='completed'&&r.result?.success===true;
   if(r.mode==='preview'&&success&&continueAfterPreview){continueAfterPreview=false;await submit('execute',id);return;}
   continueAfterPreview=false;busy=false;lock();
   label(success?'Successful':'Failed',success?'success':'failure');
   if(!success)status(r.mode==='preview'?'Pre-check failed; script was not executed.': 'Script failed. Details are in the Work ticket.',true);
   else if(r.ticketNoteStatus==='unavailable')status('Run succeeded, but its ticket is unavailable.',true);
   else if(r.ticketNotePending)status('Run succeeded; ticket update pending.');
   else status('');
  }catch(e){if(active())recover(e);}
 }
 try{
  const catalog=await request(base+'/catalog');if(!active())return;
  if(!catalog.scripts?.some(s=>s.id==='clear-print-spool'))throw Error('Print cleanup is unavailable.');
  const data=await request(base+'/runs');if(!active())return;ready=true;
  const runs=(data.runs||[]).filter(r=>r.mode==='execute').sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0));
  const previous=runs.find(r=>['queued','running'].includes(r.status))||runs[0];
  lock();status('');if(previous)await check(previous.requestId);
 }catch(e){if(active()){ready=false;lock();label('Unavailable','failure');status(e.message,true);}}
}
