import {el,field,select,button,parseRegistryData} from './workspace-ui.js';
const hives=['HKEY_LOCAL_MACHINE','HKEY_CURRENT_USER','HKEY_CLASSES_ROOT','HKEY_USERS','HKEY_CURRENT_CONFIG'];
const aliases={HKLM:hives[0],HKCU:hives[1],HKCR:hives[2],HKU:hives[3],HKCC:hives[4]};
const types=['REG_SZ','REG_EXPAND_SZ','REG_BINARY','REG_DWORD','REG_QWORD','REG_MULTI_SZ'];
export function registryAddress(value){
 const [head,...rest]=value.trim().replace(/\//g,'\\').split('\\');const hive=aliases[head.toUpperCase()]||head.toUpperCase();
 if(!hives.includes(hive))throw Error('Start the path with a registry hive, such as HKLM or HKEY_LOCAL_MACHINE.');
 const path=rest.join('\\').replace(/^\\+|\\+$/g,'');if(path.includes('\0'))throw Error('The path contains an invalid character.');return {hive,path};
}
export function registryPlan(operation,target,input={}){
 const {hive,path}=registryAddress(target.hive+'\\'+target.path);const base={hive,path};
 if(operation==='new-key'){
  const name=String(input.name||'').trim();if(!name||/[\\/\0]/.test(name))throw Error('Enter one subkey name, without slashes.');
  return {operation,title:'Create registry key',method:'POST',endpoint:'/registry/key',body:{...base,path:[path,name].filter(Boolean).join('\\')}};
 }
 if(operation==='new-value'||operation==='edit-value'){
  if(!types.includes(input.type))throw Error('Choose a supported registry type.');if(String(input.name).includes('\0'))throw Error('The value name contains an invalid character.');
  return {operation,title:operation==='new-value'?'Create registry value':'Update registry value',method:'PUT',endpoint:'/registry/value',body:{...base,name:String(input.name??''),type:input.type,data:parseRegistryData(input.type,input.data)}};
 }
 if(operation==='delete-key'){
  if(!path)throw Error('Registry hives cannot be deleted.');return {operation,title:'Delete registry key',method:'DELETE',endpoint:'/registry/key',body:base};
 }
 if(operation==='delete-value')return {operation,title:'Delete registry value',method:'DELETE',endpoint:'/registry/value',body:{...base,name:input.name??''}};
 throw Error('Unknown registry operation.');
}
const dataText=v=>Array.isArray(v.data)?(v.type==='REG_BINARY'?v.data.map(n=>n.toString(16).padStart(2,'0')).join(' '):v.data.join('\n')):String(v.data??'');
export async function renderRegistry(opts){
 const {request,devicePath,root,status,isCurrent}=opts;
 root.classList.add('registry-workspace');let target={hive:hives[0],path:'SOFTWARE'},values=[],selected=null,busy=false,serial=0,dialog=null;
 const cache=new Map(),expanded=new Set(),full=t=>[t.hive,t.path].filter(Boolean).join('\\');
 const address=field('Registry path','text',full(target));address.wrap.className='registry-address';address.input.setAttribute('aria-label','Registry path');
 const tree=el('div',null,{className:'registry-tree',role:'tree'}),tableHost=el('div',null,{className:'registry-values'}),split=el('div',null,{className:'registry-split'}),toolbar=el('div',null,{className:'registry-toolbar'}),location=el('div',null,{className:'registry-location'});
 const search=field('Filter values');search.input.placeholder='Filter name, type or data';search.wrap.className='registry-filter';
 const editButton=button('Edit',()=>openEditor('edit-value',selected)),deleteButton=button('Delete',()=>selected?showPreview(registryPlan('delete-value',target,selected)):showPreview(registryPlan('delete-key',target)),true);
 const up=button('Up',()=>navigate({...target,path:target.path.split('\\').slice(0,-1).join('\\')}));
 const newKey=button('New key',()=>openEditor('new-key')),newValue=button('New value',()=>openEditor('new-value'));
 toolbar.append(newKey,newValue,editButton,deleteButton,button('Refresh',()=>navigate(target)),search.wrap);
 const nav=el('div',null,{className:'registry-nav'});nav.append(up,address.wrap,button('Go',()=>{try{navigate(registryAddress(address.input.value));}catch(e){status(e.message,true);}}));
 address.input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();try{navigate(registryAddress(address.input.value));}catch(error){status(error.message,true);}}};
 const left=el('section',null,{className:'registry-tree-pane'});left.append(el('h3','Registry keys'),tree);const right=el('section',null,{className:'registry-value-pane'});right.append(location,tableHost);split.append(left,right);root.append(nav,toolbar,split);
 function updateButtons(){editButton.disabled=busy||!selected||(typeof selected.data==='number'&&!Number.isSafeInteger(selected.data));deleteButton.disabled=busy||(!selected&&!target.path);up.disabled=busy||!target.path;}
 function drawValues(){
  tableHost.replaceChildren();const table=el('table',null,{className:'registry-table'}),head=el('thead'),hr=el('tr');['Name','Type','Data'].forEach(x=>hr.append(el('th',x)));head.append(hr);const body=el('tbody');
  const term=search.input.value.toLowerCase();const filtered=values.filter(v=>[v.name,v.type,dataText(v)].join(' ').toLowerCase().includes(term));
  for(const v of filtered){const tr=el('tr',null,{tabIndex:0,className:selected===v?'selected':''});tr.setAttribute('aria-selected',String(selected===v));
   for(const text of [v.name||'(Default)',v.type,dataText(v)||'(empty)'])tr.append(el('td',text,{title:text}));
   tr.onclick=()=>{if(busy||dialog)return;selected=v;drawValues();};tr.ondblclick=()=>{if(!busy&&!dialog)openEditor('edit-value',v);};tr.onkeydown=e=>{if(e.key==='Enter'){selected=v;openEditor('edit-value',v);}else if(e.key===' '){e.preventDefault();selected=v;drawValues();}};body.append(tr);
  }table.append(head,body);tableHost.append(table);if(!filtered.length)tableHost.append(el('p',values.length?'No matching values.':'This key has no values.',{className:'registry-empty'}));updateButtons();
 }
 search.input.oninput=drawValues;
 function drawTree(){
  tree.replaceChildren();function branch(t,name,depth){const id=full(t),line=el('div',null,{className:'registry-tree-row'+(id===full(target)?' selected':'')});line.style.paddingLeft=depth*16+'px';line.setAttribute('role','treeitem');line.setAttribute('aria-selected',String(id===full(target)));line.setAttribute('aria-expanded',String(expanded.has(id)));
   const toggle=button(expanded.has(id)?'▾':'▸',async()=>{if(busy||dialog)return;if(expanded.has(id)){expanded.delete(id);drawTree();}else{await navigate(t);}});toggle.className='registry-expander';toggle.setAttribute('aria-label',(expanded.has(id)?'Collapse ':'Expand ')+id);
   const label=button(name,()=>navigate(t));label.className='registry-key';label.title=id;label.ondblclick=()=>navigate(t);line.append(toggle,label);tree.append(line);
   if(expanded.has(id))for(const k of cache.get(id)||[]){const raw=k.path.replace(new RegExp('^'+t.hive+'\\\\','i'),'');branch({hive:t.hive,path:raw},k.name,depth+1);}
  }for(const hive of hives)branch({hive,path:''},hive.replace('HKEY_',''),0);
 }
 async function navigate(next){
  if(busy||dialog||!isCurrent())return;const n=++serial;busy=true;updateButtons();status('Loading registry…');
  try{const q=new URLSearchParams(next),[keys,result]=await Promise.all([request(devicePath('/registry/keys?'+q)),request(devicePath('/registry/values?'+q))]);if(!isCurrent()||n!==serial)return;
   cache.set(full(next),keys.data||[]);expanded.add(full(next));
   // Load missing ancestors so a pasted deep path is also visible in the tree.
   const segments=next.path.split('\\').filter(Boolean);for(let i=0;i<segments.length;i++){const a={hive:next.hive,path:segments.slice(0,i).join('\\')};expanded.add(full(a));if(!cache.has(full(a))){const r=await request(devicePath('/registry/keys?'+new URLSearchParams(a)));if(!isCurrent()||n!==serial)return;cache.set(full(a),r.data||[]);}}
   target={...next};values=result.data||[];selected=null;address.input.value=full(target);location.textContent=full(target);drawTree();drawValues();status(`${values.length} values · ${keys.data?.length||0} subkeys`);
  }catch(e){if(isCurrent())status(e.message,true);}finally{busy=false;updateButtons();}
 }
 function closeDialog(){dialog?.remove();dialog=null;}
 function modal(title){closeDialog();const overlay=el('div',null,{className:'registry-overlay'}),box=el('section',null,{className:'registry-dialog',role:'dialog',tabIndex:-1});box.setAttribute('aria-modal','true');box.setAttribute('aria-label',title);box.append(el('h2',title));overlay.append(box);root.append(overlay);dialog=overlay;
  overlay.onkeydown=e=>{if(e.key==='Escape'&&!busy)closeDialog();if(e.key==='Tab'){const items=[...box.querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};box.focus();return box;
 }
 function openEditor(operation,v,draft){
  if(busy||!isCurrent())return;if(operation==='edit-value'&&(!v||(typeof v.data==='number'&&!Number.isSafeInteger(v.data)))){status('This value exceeds the exact numeric range supported by the API.',true);return;}
  const captured={...target},box=modal(operation==='new-key'?'New registry key':operation==='new-value'?'New registry value':'Edit registry value'),form=el('form');form.onsubmit=e=>e.preventDefault();
  box.append(el('p',full(captured),{className:'registry-preview-path'}));const name=field(operation==='new-key'?'Subkey name':'Value name','text',draft?.name??v?.name??'');name.input.disabled=operation==='edit-value';form.append(name.wrap);
  let type,data;if(operation!=='new-key'){type=select('Type',types,draft?.type||v?.type||'REG_SZ');data=field('Data','textarea',draft?.data??(v?dataText(v):''));form.append(type.wrap,data.wrap,el('p','DWORD/QWORD: decimal. Binary: hexadecimal pairs. Multi-string: one entry per line.',{className:'registry-hint'}));}
  const error=el('p',null,{className:'registry-error',role:'alert'});const actions=el('div',null,{className:'registry-dialog-actions'});actions.append(button('Cancel',closeDialog),button('Preview change',()=>{try{
   if(operation==='new-key'&&(cache.get(full(captured))||[]).some(k=>k.name.toLowerCase()===name.input.value.trim().toLowerCase()))throw Error('That key already exists. Choose a different name.');
   if(operation==='new-value'&&values.some(x=>x.name.toLowerCase()===name.input.value.toLowerCase()))throw Error('That value already exists. Select it and use Edit.');
   const draft={name:name.input.value,type:type?.input.value,data:data?.input.value};const plan=registryPlan(operation,captured,draft);if(operation==='edit-value')plan.previous={type:v.type,data:v.data};showPreview(plan,()=>openEditor(operation,v,draft));
  }catch(e){error.textContent=e.message;}}));form.append(error,actions);box.append(form);name.input.focus();
 }
 function showPreview(plan,back){
  if(busy||!isCurrent())return;const frozen=JSON.parse(JSON.stringify(plan)),box=modal('Review registry change'),dl=el('dl',null,{className:'registry-preview'});
  const pair=(label,value)=>{dl.append(el('dt',label),el('dd',value));};pair('Computer',opts.deviceName||opts.deviceId||'Selected computer');if(opts.clientName)pair('Client',opts.clientName);pair('Operation',frozen.title);pair('Full key path',full(frozen.body));
  if('name'in frozen.body)pair('Value name',frozen.body.name||'(Default)');if('type'in frozen.body){pair('Type',frozen.body.type);pair('Data',dataText(frozen.body)||'(empty)');}if(frozen.previous){pair('Previous type',frozen.previous.type);pair('Previous data',dataText(frozen.previous)||'(empty)');}
  box.append(dl);if(frozen.operation==='delete-key')box.append(el('p','This deletes the selected key. Contents may be removed; this cannot be undone here.',{className:'registry-error'}));
  if(frozen.operation.startsWith('new'))box.append(el('p','The change is sent only when you select Apply change. If the target changed since loading, refresh and review it again.',{className:'registry-hint'}));
  const error=el('p',null,{className:'registry-error',role:'alert'}),actions=el('div',null,{className:'registry-dialog-actions'}),cancel=button('Cancel',closeDialog),apply=button('Apply change',async()=>{
   if(busy||!isCurrent()||!box.isConnected)return;busy=true;[...box.querySelectorAll('button')].forEach(b=>b.disabled=true);error.textContent='';
   try{if(frozen.operation==='new-key'||frozen.operation==='new-value'){const isKey=frozen.operation==='new-key',parts=frozen.body.path.split('\\'),name=isKey?parts.pop():frozen.body.name;const parentPath=isKey?parts.join('\\'):frozen.body.path;const existing=await request(devicePath((isKey?'/registry/keys?':'/registry/values?')+new URLSearchParams({hive:frozen.body.hive,path:parentPath})));if(!isCurrent())return;if((existing.data||[]).some(item=>item.name.toLowerCase()===name.toLowerCase()))throw Error('The target already exists. Cancel, refresh, and use Edit if appropriate.');}const endpoint=frozen.method==='DELETE'?frozen.endpoint+'?'+new URLSearchParams(frozen.body):frozen.endpoint;const result=await request(devicePath(endpoint),frozen.method,frozen.method==='DELETE'?undefined:frozen.body);if(result?.success===false)throw Error(result.error||'Registry change failed.');if(!isCurrent())return;closeDialog();busy=false;await navigate(target);status(frozen.title+' completed.');}
   catch(e){if(isCurrent()){error.textContent=e.message;status(e.message,true);}}finally{busy=false;[...box.querySelectorAll('button')].forEach(b=>b.disabled=false);updateButtons();}
  },frozen.operation.startsWith('delete'));
  actions.append(cancel);if(back)actions.append(button('Back',back));actions.append(apply);box.append(error,actions);cancel.focus();
 }
 drawTree();await navigate(target);
}
