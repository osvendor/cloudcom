import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const origin=new URL(process.argv[2]||'');if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Supply one HTTPS Breeze origin');
const output=resolve(process.argv[3]||resolve(root,'dist'));await mkdir(output,{recursive:true});
for(const name of ['popup.html','popup.css','popup.js','popup-work.js','popup-notes.js','document-sections.js','device-user.js','background.js','policy.js','session.js','workspaces.js','workspace.html','workspace.css','workspace-registry.css','workspace-events.css','workspace-scripts.css','workspace.js','workspace-launch.mjs','workspace-processes.js','workspace-network.js','workspace-events-tasks.js','workspace-events.js','workspace-registry.js','workspace-files.js','workspace-scripts.js','workspace-ui.js','workspace-terminal.js'])await copyFile(resolve(root,name),resolve(output,name));
const vendor=resolve(root,'../../apps/web/node_modules/@xterm');
for(const [source,target] of [['xterm/lib/xterm.mjs','vendor-xterm.js'],['xterm/css/xterm.css','vendor-xterm.css'],['addon-fit/lib/addon-fit.mjs','vendor-fit.js'],['xterm/LICENSE','LICENSE-xterm.txt'],['addon-fit/LICENSE','LICENSE-fit.txt']])await copyFile(resolve(vendor,source),resolve(output,target));
await writeFile(resolve(output,'config.js'),`export const BREEZE_ORIGIN=${JSON.stringify(origin.origin)};export const BRIDGE_PATH='/extensions/credentials/browser-companion';\n`);
const publicKey=process.argv[4]?(await readFile(resolve(process.argv[4]),'utf8')).trim():undefined;
if(publicKey&&!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey))throw new Error('Supply a base64 public SPKI key, never a private key');
await writeFile(resolve(output,'manifest.json'),JSON.stringify({manifest_version:3,name:'OS Companion',version:'0.5.4',version_name:'0.5.4',key:publicKey,description:'Client-scoped website logins and Breeze device tools for staff.',minimum_chrome_version:'116',permissions:['activeTab','clipboardWrite','scripting','storage','identity','sidePanel'],host_permissions:[origin.origin+'/*'],background:{service_worker:'background.js',type:'module'},action:{default_title:'Open OS Companion'},side_panel:{default_path:'popup.html'},content_security_policy:{extension_pages:"script-src 'self'; object-src 'none'; base-uri 'none'"}},null,2));
console.log('Built Edge companion package');



