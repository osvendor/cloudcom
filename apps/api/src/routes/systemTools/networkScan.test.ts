import {beforeEach,describe,it,expect,vi} from 'vitest';
import {Hono} from 'hono';
const m=vi.hoisted(()=>({device:vi.fn(),queue:vi.fn(),audit:vi.fn(),where:vi.fn(),limit:vi.fn()}));
vi.mock('./helpers',()=>({getDeviceWithOrgAndSiteCheck:m.device,SITE_ACCESS_DENIED:Symbol.for('denied')}));
vi.mock('../../services/commandQueue',()=>({queueCommandForExecution:m.queue}));
vi.mock('../../services/auditService',()=>({createAuditLog:m.audit}));
vi.mock('../../services/clientIp',()=>({getTrustedClientIpOrUndefined:()=>undefined}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({where:m.where})})}}));
vi.mock('../../services/macVendorLookup',()=>({lookupMacVendor:(mac:string)=>mac==='00:11:22:33:44:55'?'Test NIC Vendor':null}));
import {networkScanRoutes,normalizeScanSubnet,reportedSubnet} from './networkScan';
const id='33333333-3333-4333-8333-333333333333',networkId='44444444-4444-4444-8444-444444444444',scanId='55555555-5555-4555-8555-555555555555';
const app=new Hono();app.use('*',async(c,next)=>{c.set('auth' as never,{user:{id:'actor',email:'a@example.invalid'}} as never);await next();});app.route('/',networkScanRoutes);
const base=`/devices/${id}/network-scan`,post=(body:unknown)=>app.request(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const inventory={id:networkId,interfaceName:'Ethernet',ipAddress:'10.0.0.99',subnetMask:'255.255.255.0'};
beforeEach(()=>{vi.clearAllMocks();m.device.mockResolvedValue({id,orgId:'org',hostname:'TEST'});m.where.mockResolvedValue([inventory]);m.queue.mockResolvedValue({command:{id:scanId}});});
describe('selected-device scan',()=>{
it('derives exact network and rejects noncontiguous or missing masks',()=>{
expect(reportedSubnet('10.0.3.99','255.255.254.0')).toBe('10.0.2.0/23');expect(reportedSubnet('10.0.3.99','24')).toBe('10.0.3.0/24');expect(reportedSubnet('10.0.3.99','255.0.255.0')).toBeNull();expect(reportedSubnet('10.0.3.99',null)).toBeNull();
for(const value of ['10.0.0.0/8','8.8.8.8/32','127.0.0.1/32','10.0.999.1/24'])expect(normalizeScanSubnet(value)).toBeNull();
});
it('loads inventory without dispatch',async()=>{const r=await app.request(base+'/networks');expect(r.status).toBe(200);expect((await r.json()).data[0]).toMatchObject({subnet:'10.0.0.0/24',supported:true});expect(m.queue).not.toHaveBeenCalled();});
it('rejects arbitrary targets, foreign network IDs and denied devices',async()=>{
expect((await post({subnet:'10.0.0.0/24'})).status).toBe(400);expect((await post({networkId:scanId})).status).toBe(409);m.device.mockResolvedValue(null);expect((await post({networkId})).status).toBe(404);m.device.mockResolvedValue(Symbol.for('denied'));expect((await post({networkId})).status).toBe(403);expect(m.queue).not.toHaveBeenCalled();
});
it('queues the server-derived subnet fenced to the selected device and organization',async()=>{
expect((await post({networkId})).status).toBe(202);expect(m.queue).toHaveBeenCalledWith(id,'network_discovery',expect.objectContaining({subnets:['10.0.0.0/24'],companionScan:true,methods:['arp','port_scan','snmp'],snmpCommunities:['public'],snmpCredentials:[],timeout:1,resolveHostnames:true}),expect.objectContaining({expectedOrgId:'org',offlinePolicy:{kind:'reject'}}));expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({action:'network_scan_started'}));
});
it.each([null,'','255.255.0.0','255.255.255.128'])('uses the device IP /24 regardless of reported mask %s',async mask=>{m.where.mockResolvedValue([{...inventory,ipAddress:'192.168.254.11',subnetMask:mask}]);expect((await post({networkId})).status).toBe(202);expect(m.queue).toHaveBeenCalledWith(id,'network_discovery',expect.objectContaining({subnets:['192.168.254.0/24']}),expect.anything());});
it('polls pending and completed results and rejects unrelated or invalid results',async()=>{
const run={status:'running',payload:{companionScan:true,subnets:['10.0.0.0/24']},result:{exitCode:0,stdout:JSON.stringify({hosts:[{ip:'10.0.0.2',openPorts:[{port:443}]}],hostsScanned:254})}};m.where.mockReturnValue({limit:m.limit});m.limit.mockResolvedValue([run]);const get=()=>app.request(base+'/runs/'+scanId);expect((await(await get()).json()).status).toBe('running');run.status='completed';expect((await(await get()).json()).data[0]).toMatchObject({httpsPortOpen:true,mac:null});m.limit.mockResolvedValue([]);expect((await get()).status).toBe(404);m.limit.mockResolvedValue([{...run,payload:{}}]);expect((await get()).status).toBe(404);m.limit.mockResolvedValue([{...run,result:{exitCode:0,stdout:'invalid'}}]);expect((await get()).status).toBe(500);expect(m.queue).not.toHaveBeenCalled();
});
});


it('enriches MAC vendors without overwriting device manufacturer and leaves missing MAC unknown',async()=>{
 const hosts=[{ip:'10.0.0.2',mac:'00:11:22:33:44:55'},{ip:'10.0.0.3',mac:'00:11:22:33:44:55',manufacturer:'Device Brand'},{ip:'10.0.0.4'}];
 m.where.mockReturnValue({limit:m.limit});m.limit.mockResolvedValue([{status:'completed',payload:{companionScan:true,subnets:['10.0.0.0/24']},result:{exitCode:0,stdout:JSON.stringify({hosts,hostsScanned:254})}}]);
 const r=await app.request(base+'/runs/'+scanId);expect(r.status).toBe(200);const {data}=await r.json();
 expect(data[0]).toMatchObject({manufacturer:'Test NIC Vendor',manufacturerSource:'mac_oui'});
 expect(data[1]).toMatchObject({manufacturer:'Device Brand',manufacturerSource:'device'});
 expect(data[2]).toMatchObject({manufacturer:null,manufacturerSource:null});
});


it('returns resolved hostname, falls back to SNMP name and tolerates absent names',async()=>{
 const hosts=[{ip:'10.0.0.2',hostname:'printer.example',snmpData:{sysName:'Other'}},{ip:'10.0.0.3',snmpData:{sysName:'Switch'}},{ip:'10.0.0.4'}];
 m.where.mockReturnValue({limit:m.limit});m.limit.mockResolvedValue([{status:'completed',payload:{companionScan:true},result:{exitCode:0,stdout:JSON.stringify({hosts,hostsScanned:254})}}]);
 const r=await app.request(base+'/runs/'+scanId);expect(r.status).toBe(200);expect((await r.json()).data.map((h:{hostname:string|null})=>h.hostname)).toEqual(['printer.example','Switch',null]);
});
