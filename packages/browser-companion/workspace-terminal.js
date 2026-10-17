import {Terminal} from './vendor-xterm.js';
import {FitAddon} from './vendor-fit.js';
import {BREEZE_ORIGIN} from './config.js';
import {el,button} from './workspace-ui.js';
export async function renderTerminal(opts){
 const {root,status,isCurrent,request,onDispose,endSession,deviceId}=opts;
 const term=new Terminal({cursorBlink:true,scrollback:2000,fontSize:13,theme:{background:'#0c1017'}}),fit=new FitAddon();term.loadAddon(fit);
 const host=el('div',null,{className:'terminal-host'});host.style.height='420px';
 let ws,id,disposed=false,ready=false,lastFrame=Date.now(),ping,watchdog,timeout;
 const stop=()=>{if(disposed)return;disposed=true;clearInterval(ping);clearInterval(watchdog);clearTimeout(timeout);observer.disconnect();ws?.close();term.dispose();if(id)endSession(id).catch(()=>{});};
 root.append(button('Disconnect',()=>{stop();status('Terminal disconnected. Select Terminal to start a new session.');}),host);
 term.open(host);const observer=new ResizeObserver(()=>{if(disposed)return;fit.fit();if(ready&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));});observer.observe(host);fit.fit();onDispose(stop);
 term.onData(data=>{if(ready&&!disposed&&isCurrent()&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'data',data}));});
 try{
  status('Starting terminal…');const session=await request('/remote/sessions','POST',{deviceId,type:'terminal'});id=session.id;
  if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid terminal session');
  if(disposed||!isCurrent()){await endSession(id);return;}
  const grant=await request(`/remote/sessions/${id}/ws-ticket`,'POST');
  if(disposed||!isCurrent()){await endSession(id);return;}
  if(typeof grant.ticket!=='string'||!grant.ticket||grant.ticket.length>512)throw Error('Invalid terminal ticket');
  const url=new URL(`/api/v1/remote/sessions/${id}/ws`,BREEZE_ORIGIN);url.protocol='wss:';url.searchParams.set('ticket',grant.ticket);ws=new WebSocket(url);
  timeout=setTimeout(()=>{if(!ready&&!disposed){stop();status('Terminal did not connect. Select Terminal to retry.',true);}},30000);
  ws.onmessage=event=>{if(disposed||!isCurrent())return;lastFrame=Date.now();let msg;try{msg=JSON.parse(event.data);}catch{return;}
   if(msg.type==='output'&&typeof msg.data==='string')term.write(msg.data);
   else if(msg.type==='ping')ws.send(JSON.stringify({type:'pong',timestamp:Date.now()}));
   else if(msg.type==='connected'){ready=true;clearTimeout(timeout);status('Terminal connected.');if(opts.shell==='cmd'||opts.shell==='powershell')ws.send(JSON.stringify({type:'data',data:opts.shell==='cmd'?'cmd.exe\r':'powershell.exe -NoLogo -NoProfile\r'}));fit.fit();term.focus();ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));}
   else if(msg.type==='error')status(msg.message||'Terminal error',true);
  };
  ws.onerror=()=>{if(!disposed){stop();status('Terminal connection failed. Check sign-in and network access, then select Terminal to retry.',true);}};
  ws.onclose=()=>{if(!disposed){stop();status('Terminal disconnected. Select Terminal to reconnect.',true);}};
  ping=setInterval(()=>{if(ready&&!disposed&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}));},15000);
  watchdog=setInterval(()=>{if(ready&&!disposed&&Date.now()-lastFrame>75000){stop();status('Terminal connection timed out.',true);}},10000);
 }catch(error){stop();if(isCurrent())status(error.message,true);}
}
