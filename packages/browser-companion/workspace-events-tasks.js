import {el,button,row,details,controls,field} from './workspace-ui.js';

export {renderEvents} from './workspace-events.js';

export async function renderTasks(opts){
 const {root,request,devicePath,status,isCurrent}=opts,run=controls(opts);
 const search=field('Search tasks'),list=el('div');let page=1,totalPages=1;
 async function load(wanted=1){return run(async()=>{
  const response=await request(devicePath(`/tasks?page=${wanted}&limit=50&search=${encodeURIComponent(search.input.value)}`));
  if(!isCurrent())return;page=wanted;totalPages=response.meta?.totalPages||1;list.replaceChildren();
  const items=response.data||[];
  for(const item of items){
   const path=devicePath(`/tasks/${encodeURIComponent(item.path)}`);
   const inspect=suffix=>run(async()=>{const data=await request(path+suffix);if(isCurrent())details(list,data.data??data);});
   const actions=[button('Details',()=>inspect('')),button('History',()=>inspect('/history?limit=100'))];
   for(const action of ['run','enable','disable'])actions.push(button(action[0].toUpperCase()+action.slice(1),()=>run(async()=>{
    if(!confirm(`${action} task ${item.path}?`))return;
    await request(path+'/'+action,'POST');status(`Task ${action} requested. Refresh to load its current state.`);
   }),action==='disable'));
   row(list,[item.path,item.state,item.lastRunTime],actions);
  }
  status(`${items.length} tasks · page ${page} of ${totalPages}`);
 });}
 root.append(search.wrap,button('Search / refresh',()=>load(1)),button('Previous',()=>load(Math.max(1,page-1))),button('Next',()=>load(Math.min(totalPages,page+1))),list);
 await load();
}
