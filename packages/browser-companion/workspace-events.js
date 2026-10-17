import {el,button,controls,field} from './workspace-ui.js';
const levels=['critical','error','warning','information','verbose'];
const readableTime=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?value||'—':date.toLocaleString();};
export function filterSortEvents(items,{search='',from='',to='',sort='timeCreated',direction=-1}={}){
 const query=search.trim().toLowerCase(),start=from?new Date(from).getTime():-Infinity,end=to?new Date(to).getTime():Infinity;
 return items.filter(item=>{const date=new Date(item.timeCreated).getTime();return (!query||[item.message,item.source,item.eventId].some(v=>String(v??'').toLowerCase().includes(query)))&&(!from||date>=start)&&(!to||date<=end);}).sort((a,b)=>{
  const value=item=>sort==='level'?levels.indexOf(item.level):sort==='timeCreated'?new Date(item.timeCreated).getTime():sort==='eventId'?Number(item.eventId):String(item[sort]??'').toLowerCase();
  const av=value(a),bv=value(b);return (typeof av==='string'?av.localeCompare(bv):av-bv)*direction;
 });
}
export async function renderEvents(opts){
 const {root,request,devicePath,status,isCurrent}=opts,run=controls(opts);
 root.classList.add('events-view');
 const log=el('select',null,{ariaLabel:'Event log'}),severity=el('select',null,{ariaLabel:'Severity'});
 severity.append(el('option','All levels',{value:''}));levels.forEach(v=>severity.append(el('option',v[0].toUpperCase()+v.slice(1),{value:v})));
 const source=field('Source'),eventId=field('Event ID','number'),search=field('Search this page'),from=field('From · this page','datetime-local'),to=field('To · this page','datetime-local');
 source.input.placeholder='Any source';eventId.input.placeholder='Any ID';eventId.input.min='0';search.input.placeholder='Message, source or ID';
 severity.value='warning';
 const allLogs=field('Show all logs','checkbox');allLogs.wrap.className='event-all-logs';let availableLogs=[],refreshTimer;
 const cancelRefresh=()=>clearTimeout(refreshTimer);opts.onDispose?.(cancelRefresh);
 const refresh=()=>{cancelRefresh();return load(1);};
 const scheduleRefresh=()=>{cancelRefresh();refreshTimer=setTimeout(()=>{if(isCurrent())load(1);},400);};
 const filters=el('form',null,{className:'event-filters'}),logLabel=el('label','Log'),levelLabel=el('label','Level');logLabel.append(log);levelLabel.append(severity);
 filters.append(logLabel,levelLabel,source.wrap,eventId.wrap);filters.onsubmit=e=>{e.preventDefault();refresh();};
 log.onchange=severity.onchange=refresh;source.input.oninput=eventId.input.oninput=scheduleRefresh;source.input.onchange=eventId.input.onchange=refresh;
 function populateLogs(){const previous=log.value;log.replaceChildren();const logs=availableLogs.filter(item=>allLogs.input.checked||['application','system'].includes((item.name||item.logName||'').toLowerCase()));for(const item of logs){const name=item.name||item.logName;if(name)log.append(el('option',item.displayName||name,{value:name}));}log.value=logs.some(item=>(item.name||item.logName)===previous)?previous:(logs[0]?.name||logs[0]?.logName||'');}
 allLogs.input.onchange=()=>{populateLogs();if(!log.value){items=[];paint();status('No Application or System logs available. Enable Show all logs to browse other logs.');return;}return refresh();};
 const local=el('details',null,{className:'event-local-filters'}),localFields=el('div',null,{className:'event-local-fields'});local.append(el('summary','Search and date range · loaded page'));localFields.append(search.wrap,from.wrap,to.wrap);local.append(localFields);
 const toolbar=el('div',null,{className:'event-toolbar'});toolbar.append(el('h3','Event Viewer'));if(opts.embedded&&opts.openFullView)toolbar.append(button('Open full view',()=>run(async()=>{await opts.openFullView();status('Opened full Event Viewer.');})));
 const table=el('table',null,{className:'event-table'}),head=el('thead'),header=el('tr'),body=el('tbody'),tableWrap=el('div',null,{className:'event-table-wrap'}),detail=el('section',null,{className:'event-detail',ariaLabel:'Selected event details'});
 const count=el('span',null,{className:'muted'}),previous=button('Previous',()=>load(Math.max(1,page-1))),next=button('Next',()=>load(Math.min(totalPages,page+1))),pager=el('div',null,{className:'event-pager'});pager.append(count,previous,next);
 let page=1,totalPages=1,items=[],loadedLog='',sort='timeCreated',direction=-1,selected=null;
 const headings=[['level','Level'],['timeCreated','Time'],['source','Source'],['eventId','Event ID'],['message','Message']];
 const headers=new Map();for(const [key,label] of headings){const th=el('th');th.append(button(label,()=>{direction=sort===key?-direction:1;sort=key;paint();}));header.append(th);headers.set(key,th);}head.append(header);table.append(head,body);tableWrap.append(table);
 function paint(){
  body.replaceChildren();for(const [key,th]of headers)th.setAttribute('aria-sort',sort===key?(direction===1?'ascending':'descending'):'none');
  const shown=filterSortEvents(items,{search:search.input.value,from:from.input.value,to:to.input.value,sort,direction});
  for(const item of shown){const tr=el('tr');tr.classList.toggle('selected',selected===item.recordId);const level=el('td',null,{className:'event-level '+(levels.includes(item.level)?item.level:'information')});level.append(el('span',({critical:'◆',error:'●',warning:'▲',information:'ⓘ',verbose:'◌'})[item.level]||'ⓘ'),el('span',item.level||'information'));const time=el('td',readableTime(item.timeCreated)),src=el('td',item.source||'—',{title:item.source||''}),id=el('td',item.eventId??'—'),message=el('td');const open=button(item.message||'View event',()=>inspect(item,loadedLog));open.className='event-message';open.title=item.message||'View event';open.setAttribute('aria-label',`Details for event ${item.eventId??''}: ${item.message||''}`);message.append(open);tr.append(level,time,src,id,message);tr.onclick=e=>{if(!e.target.closest('button'))inspect(item,loadedLog);};body.append(tr);}
  if(!shown.length){const tr=el('tr'),td=el('td','No events match these filters.');td.colSpan=5;tr.append(td);body.append(tr);}
  count.textContent=`${shown.length} of ${items.length} loaded · page ${page} of ${totalPages}`;previous.disabled=page<=1;next.disabled=page>=totalPages;
 }
 function showDetails(item,logName){
  detail.replaceChildren();detail.hidden=false;const top=el('div',null,{className:'event-detail-header'});top.append(el('h3',`${item.level||'Event'} · ${item.eventId??'—'}`),button('Close',()=>{detail.hidden=true;selected=null;paint();}));detail.append(top);
  const data=el('dl',null,{className:'event-metadata'});for(const [label,value]of [['Log',logName],['Time',readableTime(item.timeCreated)],['Source',item.source],['Event ID',item.eventId],['Record ID',item.recordId],['Computer',item.computer],['User',item.user],['Category',item.category]]){data.append(el('dt',label),el('dd',value??'—'));}detail.append(data,el('h4','Message'),el('p',item.message||'No message supplied.',{className:'event-full-message'}));
  const report=[`Log: ${logName}`,...['timeCreated','level','source','eventId','recordId','computer','user','category','message'].map(key=>`${key}: ${item[key]??''}`)].join('\n');
  const copy=text=>run(async()=>{await navigator.clipboard.writeText(text);status('Event copied.');});detail.append(button('Copy event',()=>copy(report)));
  if(item.rawXml){const xml=el('details');xml.append(el('summary','XML'),el('pre',item.rawXml),button('Copy XML',()=>copy(item.rawXml)));detail.append(xml);}
 }
 async function inspect(item,logName){return run(async()=>{status('Loading event details…');const response=await request(devicePath(`/eventlogs/${encodeURIComponent(logName)}/events/${encodeURIComponent(item.recordId)}`));if(!isCurrent())return;selected=item.recordId;showDetails({...item,...response.data},logName);paint();status('Event details loaded.');});}
 async function load(wanted=1){return run(async()=>{
  if(!log.value)return;if(eventId.input.value&&!/^\d+$/.test(eventId.input.value))throw Error('Event ID must be a nonnegative whole number.');
  status('Loading events…');const params=new URLSearchParams({page:String(wanted),limit:'50'});if(severity.value)params.set('level',severity.value);if(source.input.value.trim())params.set('source',source.input.value.trim());if(eventId.input.value)params.set('eventId',eventId.input.value);
  const targetLog=log.value,response=await request(devicePath(`/eventlogs/${encodeURIComponent(targetLog)}/events?${params}`));if(!isCurrent())return;loadedLog=targetLog;items=response.data||[];page=response.meta?.page||wanted;totalPages=Math.max(1,response.meta?.totalPages||1);selected=null;detail.hidden=true;detail.replaceChildren();paint();status(`${loadedLog} · sorting and text/date filters apply to this page.`);
 }).finally(()=>{if(isCurrent()){previous.disabled=page<=1;next.disabled=page>=totalPages;}});}
 for(const input of [search.input,from.input,to.input])input.oninput=paint;
 detail.hidden=true;root.append(toolbar,filters,allLogs.wrap,local,tableWrap,pager,detail);
 await run(async()=>{status('Loading event logs…');const response=await request(devicePath('/eventlogs'));if(!isCurrent())return;availableLogs=response.data||[];populateLogs();if(!log.options.length)status('No Application or System logs available. Enable Show all logs to browse other logs.');});
 await load();
}
