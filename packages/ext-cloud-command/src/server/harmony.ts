import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { Variables } from './index';
import type { NativeHarmonyServices } from './native-harmony';
import { HarmonyError } from './harmony-contract';

const id = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const key = z.string().min(1).max(8192).regex(/^[^\u0000-\u001f\u007f]+$/);
const config = z.object({ version:z.number().int().positive().nullable(),region:z.enum(['us','eu','ap']),enabled:z.boolean(),clientId:key.optional(),accessKey:key.optional() }).strict();
const mappings = z.object({ version:z.number().int().positive(),mappings:z.array(z.object({kind:z.enum(['group','endpoint']),externalId:id}).strict()).max(100) }).strict();
const link = z.object({externalId:id,deviceId:z.uuid().nullable(),checkedAt:z.iso.datetime({offset:true})}).strict();
type C = Context<{Variables:Variables}>;
async function body<T>(c:C,schema:z.ZodType<T>):Promise<T> { try { return schema.parse(await c.req.json()); } catch { throw new HarmonyError('harmony_invalid_input',400); } }
export function mountHarmonyRoutes(app:Hono<{Variables:Variables}>,native?:NativeHarmonyServices) {
  const service = () => { if (!native) throw new HarmonyError('harmony_unavailable'); return native; };
  const request = (c:C) => ({auth:c.get('auth'),authorization:c.get('extensionAuthorization'),orgId:c.get('scope').organizationId});
  app.get('/harmony/connection',c => service().connection(request(c)).then(value => c.json(value)));
  app.put('/harmony/connection',async c => c.json(await service().configure(request(c),await body(c,config))));
  app.post('/harmony/discover',async c => c.json(await service().discover(request(c))));
  app.put('/harmony/mappings',async c => c.json(await service().map(request(c),await body(c,mappings))));
  app.post('/harmony/sync',async c => c.json(await service().sync(request(c))));
  app.get('/harmony/inventory',async c => c.json(await service().inventory(request(c))));
  app.put('/harmony/link',async c => c.json(await service().link(request(c),await body(c,link))));
}
