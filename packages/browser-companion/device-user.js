export function deviceUser(device){
  const current=typeof device.currentUser==='string'?device.currentUser.trim():'';
  const last=typeof device.lastUser==='string'?device.lastUser.trim():'';
  if(current&&device.status==='online')return {name:current,label:'Current user'};
  if(last||current)return {name:last||current,label:'Last seen user'};
  return {name:'User not reported',label:'User'};
}
