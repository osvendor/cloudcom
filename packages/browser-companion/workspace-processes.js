const text=(e,v)=>{e.textContent=v==null?'—':String(v)};
const ok=b=>{if(b&&b.success===false)throw Error(b.error||'Operation failed.');return b};
const btn=(label,fn,danger=false)=>{const b=document.createElement('button');b.type='button';b.className=danger?'button danger':'button secondary';b.textContent=label;b.onclick=fn;return b};
const busy=(r,v)=>r.querySelectorAll('button').forEach(b=>{b.disabled=v});
function rows(root,items,fields,actions,q){root.querySelectorAll('.data-row,.muted,.detail-block').forEach(e=>e.remove());const shown=items.filter(x=>!q||fields.some(k=>String(x?.[k]??'').toLowerCase().includes(q)));shown.forEach(x=>{const r=document.createElement('div');r.className='data-row';fields.forEach(k=>{const s=document.createElement('span');text(s,x?.[k]);r.append(s)});r.append(actions(x));root.append(r)});if(!shown.length){const p=document.createElement('p');p.className='muted';p.textContent='No results returned.';root.append(p)}}
export async function renderProcesses({request,devicePath,root,status,isCurrent,onDispose}) {
  root.replaceChildren();
  let items=[], query='', sort='cpuPercent', descending=true,loading=false,disposed=false,timer;
  const active=()=>!disposed&&isCurrent();
  const auto=document.createElement('input');auto.type='checkbox';auto.checked=true;auto.setAttribute('aria-label','Auto refresh processes');
  const autoLabel=document.createElement('label');autoLabel.className='process-auto';autoLabel.append(auto,document.createTextNode('Auto refresh · 5s'));
  const schedule=()=>{clearTimeout(timer);if(active()&&auto.checked)timer=setTimeout(()=>refresh(),5000);};
  auto.onchange=()=>{clearTimeout(timer);if(auto.checked)refresh();};
  onDispose?.(()=>{disposed=true;clearTimeout(timer);});
  const toolbar=document.createElement('div');toolbar.className='process-toolbar';
  const input=document.createElement('input');input.type='search';input.placeholder='Filter processes';input.setAttribute('aria-label','Filter processes');
  const table=document.createElement('table');table.className='process-table';
  const head=document.createElement('thead'),header=document.createElement('tr'),body=document.createElement('tbody'),headers=[];
  for(const [key,label] of [['name','Name'],['cpuPercent','CPU %'],['memoryMb','Memory MB']]) {
    const th=document.createElement('th');th.scope='col';
    const button=btn(label,()=>{descending=sort===key?!descending:key!=='name';sort=key;draw();});
    th.append(button);header.append(th);headers.push({th,button,key,label});
  }
  const actionHead=document.createElement('th');actionHead.scope='col';actionHead.textContent='Action';header.append(actionHead);head.append(header);table.append(head,body);
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  function draw(){
    body.replaceChildren();
    for(const {th,button,key,label} of headers){th.setAttribute('aria-sort',sort===key?(descending?'descending':'ascending'):'none');button.textContent=label+(sort===key?(descending?' ↓':' ↑'):'');}
    const shown=items.filter(p=>String(p.name||'').toLowerCase().includes(query)).sort((a,b)=>{
      let comparison;
      if(sort==='name')comparison=String(a.name||'').localeCompare(String(b.name||''),undefined,{numeric:true,sensitivity:'base'});
      else{const av=number(a[sort]),bv=number(b[sort]);if(av===null)return bv===null?0:1;if(bv===null)return -1;comparison=av-bv;}
      return(descending?-comparison:comparison)||String(a.name||'').localeCompare(String(b.name||''))||a.pid-b.pid;
    });
    for(const p of shown){
      const row=document.createElement('tr');
      for(const key of ['name','cpuPercent','memoryMb']){const cell=document.createElement('td');cell.textContent=key==='name'?(p.name||'Unknown'):(number(p[key])===null?'—':p[key].toLocaleString(undefined,{minimumFractionDigits:1,maximumFractionDigits:1}));if(key==='name')cell.title=p.name||'Unknown';row.append(cell);}
      const action=document.createElement('td'),kill=btn('Kill',async()=>{
        if(loading||!active()||!confirm(`Kill process ${p.name||'Unknown'} (PID ${p.pid})?`))return;
        clearTimeout(timer);loading=true;busy(root,true);try{ok(await request(devicePath(`/processes/${encodeURIComponent(p.pid)}/kill`),'POST'));if(active()){status('Process kill requested.');loading=false;await refresh();}}catch(e){if(active())status(e.message,true);}finally{loading=false;if(active()){busy(root,false);schedule();}}
      },true);kill.setAttribute('aria-label',`Kill ${p.name||'process'}`);action.append(kill);row.append(action);body.append(row);
    }
    if(!shown.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.className='muted';cell.textContent='No matching processes.';row.append(cell);body.append(row);}
  }
  async function refresh(){
    if(loading||!active())return;
    clearTimeout(timer);loading=true;busy(root,true);
    try{status('Updating processes…');const d=ok(await request(devicePath('/processes?limit=500')));if(!active())return;items=Array.isArray(d?.data)?d.data:[];draw();status(`${items.length} processes · Updated ${new Date().toLocaleTimeString()}${auto.checked?' · Auto refresh on':''}`);}
    catch(e){if(active()){auto.checked=false;status(`Update failed; readings may be stale. ${e.message}`,true);}}
    finally{loading=false;if(active()){busy(root,false);schedule();}}
  }
  input.oninput=()=>{query=input.value.toLowerCase();draw();};toolbar.append(input,btn('Refresh',refresh),autoLabel);root.append(toolbar,table);await refresh();
}
export async function renderServices({request,devicePath,root,status,isCurrent,orgId,deviceId,osType}) {
  root.replaceChildren();
  let items=[],query='',sort='name',descending=false,loading=false;
  const toolbar=document.createElement('div');toolbar.className='service-toolbar';
  const input=document.createElement('input');input.type='search';input.placeholder='Filter services';input.setAttribute('aria-label','Filter services');
  const table=document.createElement('table');table.className='service-table';
  const head=document.createElement('thead'),header=document.createElement('tr'),body=document.createElement('tbody'),headers=[];
  const name=s=>s.displayName||s.name||'Unknown';
  const value=(s,key)=>key==='name'?name(s):String(s[key]||'—');
  const startupLabels={auto:'Automatic',manual:'Manual',disabled:'Disabled',auto_delayed:'Automatic (delayed)'};
  const serviceBusy=v=>{busy(root,v);root.querySelectorAll('select').forEach(e=>{e.disabled=v||osType!=='windows'||!startupLabels[e.value];});input.disabled=v;};
  for(const [key,label] of [['name','Name'],['status','Status'],['startType','Start type']]) {
    const th=document.createElement('th');th.scope='col';
    const button=btn(label,()=>{descending=sort===key?!descending:false;sort=key;draw();});
    th.append(button);header.append(th);headers.push({th,button,key,label});
  }
  const actionHead=document.createElement('th');actionHead.scope='col';actionHead.textContent='Actions';header.append(actionHead);head.append(header);table.append(head,body);
  function draw(){
    body.replaceChildren();
    for(const {th,button,key,label} of headers){th.setAttribute('aria-sort',sort===key?(descending?'descending':'ascending'):'none');button.textContent=label+(sort===key?(descending?' ↓':' ↑'):'');}
    const shown=items.filter(s=>['name','displayName','status','startType'].some(k=>String(s[k]||'').toLowerCase().includes(query))).sort((a,b)=>{
      const comparison=value(a,sort).localeCompare(value(b,sort),undefined,{numeric:true,sensitivity:'base'});
      return(descending?-comparison:comparison)||name(a).localeCompare(name(b))||String(a.name).localeCompare(String(b.name));
    });
    for(const s of shown){
      const row=document.createElement('tr');
      for(const key of ['name','status']){const cell=document.createElement('td');cell.textContent=value(s,key);cell.title=key==='name'&&s.displayName?`${s.displayName} (${s.name})`:value(s,key);row.append(cell);}
      const startupCell=document.createElement('td'),startup=document.createElement('select');startup.className='service-startup';startup.setAttribute('aria-label',`Startup type for ${name(s)}`);startup.title='Change startup type without starting or stopping the service';
      for(const type of ['auto','manual','disabled',...(s.startType==='auto_delayed'?['auto_delayed']:[])]){const option=document.createElement('option');option.value=type;option.textContent=startupLabels[type];if(type==='auto_delayed')option.disabled=true;startup.append(option);}
      startup.value=s.startType;
      startup.onchange=async()=>{
        const previous=s.startType,next=startup.value;
        if(loading||!isCurrent()||next===previous){startup.value=previous;return;}
        loading=true;serviceBusy(true);status(`Changing startup type for ${name(s)}…`);
        try{
          const result=ok(await request(`/companion-scripts/orgs/${orgId}/devices/${deviceId}/service-startup`,'POST',{name:s.name,startType:next,expectedStartType:previous}));
          if(result?.startType!==next)throw Error('Startup change was not confirmed. Refresh services before retrying.');
          if(isCurrent()){s.startType=next;draw();status(`${name(s)}: startup set to ${startupLabels[next]}. Current running state unchanged.`);}
        }catch(e){if(isCurrent()){startup.value=previous;status(e.message,true);}}
        finally{loading=false;if(isCurrent())serviceBusy(false);}
      };
      startupCell.append(startup);row.append(startupCell);
      const actionCell=document.createElement('td'),actions=document.createElement('div');actions.className='service-actions';
      const running=String(s.status).toLowerCase()==='running',stopped=String(s.status).toLowerCase()==='stopped',disabled=String(s.startType).toLowerCase()==='disabled';
      for(const [action,symbol,allowed] of [['Start','▶',stopped&&!disabled],['Stop','■',running],['Restart','↻',running&&!disabled]]) {
        if(!allowed)continue;
        const button=btn(symbol,async()=>{
          if(loading||!isCurrent()||!confirm(`${action} service ${name(s)}?`))return;
          loading=true;serviceBusy(true);
          try{ok(await request(devicePath(`/services/${encodeURIComponent(s.name)}/${action.toLowerCase()}`),'POST'));if(isCurrent()){const refreshed=await refresh();if(isCurrent()&&refreshed)status(`${action} requested for ${name(s)}.`);}}
          catch(e){if(isCurrent())status(e.message,true);}
          finally{loading=false;if(isCurrent())serviceBusy(false);}
        },action!=='Start');
        button.title=`${action} ${name(s)}`;button.setAttribute('aria-label',`${action} ${name(s)}`);actions.append(button);
      }
      if(!actions.children.length){const empty=document.createElement('span');empty.className='muted';empty.textContent='—';empty.title=disabled?'Service startup is disabled.':'No action available for this service state.';actions.append(empty);}
      actionCell.append(actions);row.append(actionCell);body.append(row);
    }
    if(!shown.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.className='muted';cell.textContent='No matching services.';row.append(cell);body.append(row);}
  }
  async function refresh(){
    loading=true;serviceBusy(true);
    try{status('Loading services…');const d=ok(await request(devicePath('/services?limit=500')));if(!isCurrent())return;items=Array.isArray(d?.data)?d.data:[];draw();status(`${items.length} services loaded.`);return true;}
    catch(e){if(isCurrent())status(e.message,true);}
    finally{loading=false;if(isCurrent())serviceBusy(false);}
  }
  input.oninput=()=>{query=input.value.toLowerCase();draw();};toolbar.append(input,btn('Refresh',refresh));root.append(toolbar,table);await refresh();
}
