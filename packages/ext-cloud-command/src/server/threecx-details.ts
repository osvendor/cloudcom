import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import type { Variables, ThreeCxConnection } from './index';
import type { createProvider, Credentials } from './transport';
import { ProviderError } from './transport';
import type { DetailFields, ThreeCxDetail } from '../threecx/detail-contract';

export class ThreeCxDetailError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 = 400) { super(code); }
}
type Connection = ThreeCxConnection;
type Ports = {
  connection(org: string): Promise<Connection | undefined>;
  credentials(row: Connection): Credentials;
  provider: ReturnType<typeof createProvider>;
  context: ExtensionRuntimeContext;
};
const strings = ['Number', 'FirstName', 'LastName', 'EmailAddress', 'Mobile', 'OutboundCallerID', 'CurrentProfileName', 'VMEmailOptions', 'VMPlayMsgDateTime', 'Language', 'WebMeetingFriendlyName'];
const booleans = ['Enabled', 'IsRegistered', 'Enable2FA', 'Require2FA', 'VMEnabled', 'VMPlayCallerID', 'HideInPhonebook', 'MyPhoneShowRecordings', 'MyPhoneAllowDeleteRecordings', 'MyPhoneHideForwardings', 'MyPhonePush', 'SendEmailMissedCalls', 'WebMeetingApproveParticipants'];
export const detailQuery = {
  '$select': ['Id', 'PrimaryGroupId', ...strings, ...booleans, 'Blfs'].join(','),
  '$expand': 'Groups($select=GroupId,Name;$expand=Rights($select=RoleName)),Phones($select=Id,Name,MacAddress,TemplateName,Interface),ForwardingProfiles,ForwardingExceptions,Greetings',
};
const text = z.string().trim().max(255).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const telephone = text.max(64).refine(v => /^[+0-9*#(). \-]*$/.test(v));
const forwardingChanges = z.object({
  Id: z.number().int().min(0).max(2147483647), NoAnswerTimeout: z.number().int().min(5).max(180).optional(),
  RingMyMobile: z.boolean().optional(), AcceptMultipleCalls: z.boolean().optional(), BlockPushCalls: z.boolean().optional(),
  DisableRingGroupCalls: z.boolean().optional(), OfficeHoursAutoQueueLogOut: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 1);
const changesSchema = z.object({
  FirstName: text.optional(), LastName: text.optional(), EmailAddress: z.union([z.literal(''), z.email().max(254)]).optional(),
  Mobile: telephone.optional(), OutboundCallerID: telephone.optional(),
  VMEnabled: z.boolean().optional(), VMEmailOptions: z.enum(['None', 'Notification', 'Attachment', 'AttachmentAndDelete']).optional(),
  VMPlayCallerID: z.boolean().optional(), VMPlayMsgDateTime: z.enum(['None', 'Play12Hr', 'Play24Hr']).optional(),
  ForwardingProfiles: z.array(forwardingChanges).min(1).max(20).refine(items => new Set(items.map(item => item.Id)).size === items.length).optional(),
}).strict().refine(v => Object.keys(v).length > 0);
const inputSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), changes: changesSchema }).strict();
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length <= 2048 ? v : null;
const array = (v: unknown, max = 500): Record<string, unknown>[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max || v.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new ProviderError('invalid_provider_response');
  return v;
};
function fields(raw: Record<string, unknown>, names: string[]): DetailFields {
  return Object.fromEntries(names.map(key => {
    const value = raw[key];
    return [key, value == null ? null : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : str(value)];
  }));
}
function destination(raw: unknown) {
  const value = object(raw);
  return { type: str(value.To) ?? 'Unknown', target: str(value.External) || str(value.Number) || str(value.Name) };
}

/** Positive projection: never return arbitrary provider objects or authentication material. */
export function projectDetail(raw: Record<string, unknown>, row: Connection, id: number, canManage: boolean): ThreeCxDetail {
  if (raw.Id !== id || typeof raw.Number !== 'string' || raw.Number.length > 64) throw new ProviderError('invalid_provider_response');
  const memberships = array(raw.Groups);
  if (memberships.some(g => !Number.isSafeInteger(g.GroupId) || Number(g.GroupId) < 0)) throw new ProviderError('invalid_provider_response');
  if (row.department_id !== null && !memberships.some(g => g.GroupId === row.department_id)) throw new ThreeCxDetailError('not_available', 404);
  const user = { ...fields(raw, [...strings, ...booleans, 'PrimaryGroupId']), Id: id, Number: raw.Number };
  const visibleGroups = memberships.filter(g => row.department_id === null || g.GroupId === row.department_id);
  // Recognize only the verified empty XML envelope. Never parse arbitrary XML,
  // resolve entities, or guess how non-empty BLF entries should round-trip.
  const emptyBlf = raw.Blfs == null || raw.Blfs === '' || (typeof raw.Blfs === 'string' &&
    /^\s*(?:<\?xml[^?]*\?>\s*)?<PhoneDevice>\s*<BLFS(?:\s*\/>|>\s*<\/BLFS>)\s*<\/PhoneDevice>\s*$/.test(raw.Blfs));
  const profiles = array(raw.ForwardingProfiles, 20).map(p => {
    if (!Number.isSafeInteger(p.Id)) throw new ProviderError('invalid_provider_response');
    const destinations: ThreeCxDetail['forwardingProfiles'][number]['destinations'] = [];
    for (const [route, labels] of Object.entries({ AvailableRoute: ['BusyInternal', 'BusyExternal', 'NoAnswerInternal', 'NoAnswerExternal', 'NotRegisteredInternal', 'NotRegisteredExternal'], AwayRoute: ['Internal', 'External'] })) {
      const routing = object(p[route]);
      for (const label of labels) if (routing[label] != null) destinations.push({ label: `${route}.${label}`, ...destination(routing[label]) });
    }
    return { Id: Number(p.Id), Name: str(p.CustomName) || str(p.Name) || `Profile ${p.Id}`,
      fields: fields(p, ['NoAnswerTimeout', 'RingMyMobile', 'AcceptMultipleCalls', 'BlockPushCalls', 'DisableRingGroupCalls', 'OfficeHoursAutoQueueLogOut']), destinations };
  });
  const dto: Omit<ThreeCxDetail, 'revision'> = {
    user,
    groups: visibleGroups.map(g => ({ id: Number(g.GroupId), name: str(g.Name) || `Department ${g.GroupId}`, role: str(object(g.Rights).RoleName) })),
    phones: array(raw.Phones, 100).map(p => {
      if (!Number.isSafeInteger(p.Id)) throw new ProviderError('invalid_provider_response');
      return { id: Number(p.Id), name: str(p.Name) || 'IP phone', macAddress: str(p.MacAddress), template: str(p.TemplateName), interface: str(p.Interface) };
    }),
    forwardingProfiles: profiles,
    forwardingExceptions: array(raw.ForwardingExceptions, 100).map(r => {
      if (!Number.isSafeInteger(r.Id)) throw new ProviderError('invalid_provider_response');
      return { id: Number(r.Id), fields: fields(r, ['CallType', 'Condition', 'Data', 'Enabled']), destination: [destination(r.Destination).type, destination(r.Destination).target].filter(Boolean).join(' · ') };
    }),
    greetings: array(raw.Greetings, 100).map(g => ({ name: str(g.DisplayName) || 'Greeting', profile: str(g.Type) })),
    blf: { configured: !emptyBlf, entries: [], readable: emptyBlf },
    editable: { general: canManage, voicemail: canManage, forwarding: canManage },
    notices: canManage ? [] : ['Editing requires organization write access and a verified MFA session.'],
  };
  // Detect stale drafts and configuration/scope changes without exposing provider secrets.
  // 3CX does not document conditional PATCH; this is a preflight comparison, not an atomic provider lock.
  const revision = createHash('sha256').update(JSON.stringify({ connection: row.id, organization: row.org_id, version: row.version, department: row.department_id, data: { ...dto, editable: undefined, notices: undefined } })).digest('hex');
  return { ...dto, revision };
}

export function mountThreeCxDetails(app: Hono<{ Variables: Variables }>, ports: Ports) {
  async function read(org: string, id: number, canManage: boolean) {
    const row = await ports.connection(org);
    if (!row?.enabled || row.org_id !== org) throw new ThreeCxDetailError('not_available', 404);
    let raw;
    try { raw = await ports.provider.user(ports.credentials(row), id, detailQuery); }
    catch (error) { if (error instanceof ProviderError && error.code === 'provider_not_found') throw new ThreeCxDetailError('not_available', 404); throw error; }
    return { row, raw, detail: projectDetail(raw, row, id, canManage) };
  }
  const parseId = (value: string) => {
    if (!/^(0|[1-9]\d{0,9})$/.test(value) || Number(value) > 2147483647) throw new ThreeCxDetailError('invalid_extension');
    return Number(value);
  };
  app.get('/threecx/users/:id', async c => {
    c.header('Cache-Control', 'no-store');
    const { detail } = await read(c.get('scope').organizationId, parseId(c.req.param('id')), c.get('canManage'));
    return c.json(detail);
  });
  app.patch('/threecx/users/:id', async c => {
    c.header('Cache-Control', 'no-store');
    if (!c.get('canManage')) throw new ThreeCxDetailError('edit_access_denied', 403);
    const id = parseId(c.req.param('id'));
    const input = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new ThreeCxDetailError('invalid_extension_changes');
    const scope = c.get('scope');
    const { row, raw, detail } = await read(scope.organizationId, id, true);
    if (input.data.revision !== detail.revision) throw new ThreeCxDetailError('extension_changed_reload_before_saving', 409);
    const latest = await ports.connection(scope.organizationId);
    if (!latest?.enabled || latest.org_id !== scope.organizationId || latest.id !== row.id || latest.version !== row.version) throw new ThreeCxDetailError('connection_changed_reload_before_saving', 409);
    const { ForwardingProfiles: profileChanges, ...scalarChanges } = input.data.changes;
    // Keep each save to one provider operation so a mixed form cannot partially apply.
    if (profileChanges && Object.keys(scalarChanges).length) throw new ThreeCxDetailError('save_forwarding_separately');
    if (profileChanges) {
      const existing = array(raw.ForwardingProfiles, 20);
      if (profileChanges.some(patch => !existing.some(profile => profile.Id === patch.Id))) throw new ThreeCxDetailError('unknown_forwarding_profile');
      const merged = existing.map(profile => ({ ...profile, ...profileChanges.find(patch => patch.Id === profile.Id) }));
      // This documented action regenerates profile IDs. The client must reload after saving.
      // It receives exactly one scoped extension, never caller-provided bulk targets.
      await ports.provider.updateForwarding(ports.credentials(row), id, merged);
    } else await ports.provider.updateUser(ports.credentials(row), id, scalarChanges);
    await ports.context.audit({ orgId: scope.organizationId, actorId: scope.actorId, actorType: 'user', action: 'cloudcommand.threecx.user.update', resourceType: 'integration', resourceId: row.id, result: 'success', details: { extensionId: id, fields: Object.keys(input.data.changes).sort() } });
    return c.json({ success: true });
  });
}
