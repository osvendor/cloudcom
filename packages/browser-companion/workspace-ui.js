export const el=(tag,text,attrs={})=>{const e=document.createElement(tag);if(text!=null)e.textContent=String(text);Object.assign(e,attrs);return e;};
export function field(label,type='text',value=''){const input=el(type==='textarea'?'textarea':'input',null,{value});if(type!=='textarea')input.type=type;const wrap=el('label',label);wrap.append(input);return {wrap,input};}
export function select(label,values,value){const input=el('select');for(const v of values)input.append(el('option',v,{value:v}));if(value)input.value=value;const wrap=el('label',label);wrap.append(input);return {wrap,input};}
export function button(text,action,danger=false){const b=el('button',text,{type:'button',className:'button '+(danger?'danger':'secondary')});b.onclick=action;return b;}
export function details(root,value){const pre=el('pre',JSON.stringify(value,null,2),{className:'detail-block'});root.querySelector('.detail-block')?.remove();root.append(pre);}
export function row(root,values,actions=[]){const r=el('div',null,{className:'data-row'});values.forEach(v=>r.append(el('span',v??'—')));const a=el('span',null,{className:'action-row'});a.append(...actions);r.append(a);root.append(r);}
export function controls(opts){let busy=false;return async(action,success)=>{if(busy||!opts.isCurrent())return;busy=true;const nodes=[...opts.root.querySelectorAll('button,input,select,textarea')];const disabled=nodes.map(e=>e.disabled);nodes.forEach(e=>e.disabled=true);try{const value=await action();if(!opts.isCurrent())return;if(value?.success===false||value?.testResult?.success===false)throw Error(value.error||'Action failed');if(success)opts.status(success);return value;}catch(e){if(opts.isCurrent())opts.status(e.message,true);}finally{busy=false;nodes.forEach((e,i)=>e.disabled=disabled[i]);}};}
export function parseRegistryData(type,value){
 if(type==='REG_DWORD'||type==='REG_QWORD'){if(!/^\d+$/.test(value.trim()))throw Error('Enter a nonnegative decimal integer.');const n=BigInt(value.trim()),max=type==='REG_DWORD'?4294967295n:BigInt(Number.MAX_SAFE_INTEGER);if(n>max)throw Error(type==='REG_DWORD'?'DWORD is too large.':'This API cannot safely edit QWORD values above 9007199254740991.');return Number(n);}
 if(type==='REG_BINARY'){const h=value.replace(/\s/g,'');if(!/^(?:[a-fA-F0-9]{2})*$/.test(h))throw Error('Use pairs of hexadecimal digits for binary data.');return h.match(/.{2}/g)?.map(x=>parseInt(x,16))||[];}
 if(type==='REG_MULTI_SZ')return value.split(/\r?\n/);
 return value;
}
