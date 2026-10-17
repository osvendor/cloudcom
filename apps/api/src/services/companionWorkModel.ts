export type WorkActivity={id:string;label:string;at:string;state:'success'|'pending'|'failure'};
export const workActionLabels:Record<string,string>={network_scan_started:'Started network scan',kill_process:'Ended process',start_service:'Started service',stop_service:'Stopped service',restart_service:'Restarted service',service_startup_changed:'Changed service startup',run_scheduled_task:'Ran scheduled task',enable_scheduled_task:'Enabled scheduled task',disable_scheduled_task:'Disabled scheduled task',set_registry_value:'Changed registry value',delete_registry_value:'Deleted registry value',create_registry_key:'Created registry key',delete_registry_key:'Deleted registry key',file_upload:'Uploaded file',file_copy:'Copied file',file_move:'Moved file',file_delete:'Deleted file',file_restore:'Restored file',file_trash_purge:'Emptied file trash'};
export function workCanAutoClose(events:WorkActivity[],enabled:boolean,now=Date.now()){
  return enabled&&events.length>0&&events.every(e=>e.state==='success')&&events.every(e=>Number.isFinite(Date.parse(e.at)))&&now-Math.max(...events.map(e=>Date.parse(e.at)))>=15*60_000;
}
export function auditWorkActivity(row:{id:string;action:string;timestamp:Date|string;result:string}):WorkActivity|null{
  const label=workActionLabels[row.action];return label?{id:'audit:'+row.id,label,at:new Date(row.timestamp).toISOString(),state:row.result==='success'?'success':'failure'}:null;
}

