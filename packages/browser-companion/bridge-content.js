// Only injected on the configured Breeze companion page, in an isolated world.
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||message?.type!=='companion-request')return false;
  const channel=new MessageChannel();let done=false;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);channel.port1.close();respond(value);};
  const timer=setTimeout(()=>finish({ok:false,error:'Open Breeze and click Enable companion.'}),15000);
  channel.port1.onmessage=event=>{
    if(event.data?.ready===true)channel.port1.postMessage(message.request);
    else finish(event.data);
  };
  channel.port1.start();window.postMessage({type:'cloudcom-companion-port-v1'},location.origin,[channel.port2]);
  return true;
});
