import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminUserUpdateSchema, AdminGraphError, createAdminGraphProvider } from './admin-graph-provider';
import type { GuardedFetch } from './transport';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('users.list') }).strict(),
  z.object({ type: z.literal('groups.list') }).strict(),
  z.object({ type: z.literal('licenses.list') }).strict(),
  z.object({ type: z.literal('user.get'), id: uuid }).strict(),
  z.object({ type: z.literal('group.get'), id: uuid }).strict(),
  z.object({ type: z.literal('user.update'), id: uuid, update: adminUserUpdateSchema }).strict(),
  z.object({ type: z.literal('user.password.reset'), id: uuid }).strict(),
  z.object({ type: z.literal('user.sessions.revoke'), id: uuid }).strict(),
  z.object({ type: z.literal('group.member.add'), groupId: uuid, userId: uuid }).strict(),
  z.object({ type: z.literal('group.member.remove'), groupId: uuid, userId: uuid }).strict(),
]);
export type AdministrationOperation = z.infer<typeof operation>;
const connectionSchema = z.object({
  id: uuid, orgId: uuid, tenantId: uuid, clientId: uuid, enabled: z.literal(true),
  generation: z.number().int().positive(), credentialVersion: z.string().min(1).max(128),
  permissionManifestVersion: z.string().min(1).max(128),
}).strict();
export type AdministrationConnection = z.infer<typeof connectionSchema>;
type Audit = {
  executionId: string;
  orgId: string; actorId: string; connectionId: string; operation: AdministrationOperation['type'];
  phase: 'intent' | 'outcome'; outcome?: 'success' | 'rejected' | 'unknown';
  targets: { userId?: string; groupId?: string };
  changedFields: string[];
};
export class AdministrationExecutionError extends Error {
  constructor(public readonly code: 'invalid_operation' | 'access_denied' | 'connection_not_ready'
    | 'connection_changed' | 'audit_unavailable' | 'unknown_write_outcome' | 'provider_failed') { super(code); }
}

/** Internal service, not a browser endpoint. The host must implement authorization using
 * its authenticated request object, live permissions, MFA and mutation approvals. Connection
 * loading must run under that caller's RLS context. Credential lookup is server-owned and
 * must resolve the exact supplied credentialVersion; never accept a browser certificate/ref.
 * Checks fence each dispatch and response, but cannot recall an already dispatched write. */
export function createAdministrationExecutor<Request>(ports: {
  authorize(request: Request, orgId: string, operation: AdministrationOperation['type']): Promise<{ actorId: string } | null>;
  loadConnection(request: Request, orgId: string): Promise<AdministrationConnection | null>;
  acquireToken(connection: AdministrationConnection): Promise<string>;
  fetch: GuardedFetch;
  audit(event: Audit): Promise<void>;
}) {
  return async (request: Request, orgId: string, input: unknown) => {
    const parsed = operation.safeParse(input);
    if (!uuid.safeParse(orgId).success || !parsed.success) throw new AdministrationExecutionError('invalid_operation');
    orgId = uuid.parse(orgId);
    const op = parsed.data;
    const principal = await ports.authorize(request, orgId, op.type);
    if (!principal || !uuid.safeParse(principal.actorId).success) throw new AdministrationExecutionError('access_denied');
    const initial = connectionSchema.safeParse(await ports.loadConnection(request, orgId));
    if (!initial.success || initial.data.orgId !== orgId) throw new AdministrationExecutionError('connection_not_ready');
    const snapshot = Object.freeze(initial.data);
    const fields = Object.keys(connectionSchema.shape) as (keyof AdministrationConnection)[];
    const mutation = op.type === 'user.update' || op.type === 'user.password.reset'
      || op.type === 'user.sessions.revoke' || op.type.startsWith('group.member.');
    let dispatched = false;
    let fenceFailure: AdministrationExecutionError | undefined;
    async function checkFence() {
      const currentPrincipal = await ports.authorize(request, orgId, op.type);
      if (currentPrincipal?.actorId !== principal!.actorId) throw new AdministrationExecutionError('access_denied');
      const current = connectionSchema.safeParse(await ports.loadConnection(request, orgId));
      if (!current.success || fields.some(key => current.data[key] !== snapshot[key]))
        throw new AdministrationExecutionError('connection_changed');
    }
    async function fence() {
      try { await checkFence(); }
      catch (error) {
        if (error instanceof AdministrationExecutionError) fenceFailure = error;
        throw error;
      }
    }
    const targets = 'groupId' in op ? { groupId: op.groupId, userId: op.userId }
      : 'id' in op ? (op.type === 'group.get' ? { groupId: op.id } : { userId: op.id }) : {};
    const event = { executionId: randomUUID(), orgId, actorId: principal.actorId, connectionId: snapshot.id,
      operation: op.type, targets, changedFields: op.type === 'user.update' ? Object.keys(op.update)
        : op.type === 'user.password.reset' ? ['passwordProfile']
          : op.type === 'user.sessions.revoke' ? ['signInSessions'] : [] };
    async function audit(phase: Audit['phase'], outcome?: Audit['outcome']) {
      try { await ports.audit({ ...event, phase, ...(outcome ? { outcome } : {}) }); }
      catch { throw new AdministrationExecutionError(dispatched ? 'unknown_write_outcome' : 'audit_unavailable'); }
    }
    // Fail closed before acquiring credentials or contacting Microsoft if intent cannot be recorded.
    await audit('intent');
    const provider = createAdminGraphProvider({
      tenantId: snapshot.tenantId,
      acquireToken: async () => {
        await fence();
        const token = await ports.acquireToken(snapshot);
        await fence();
        return token;
      },
      fetch: async (url, init) => {
        await fence();
        if (init.method !== 'GET') {
          if (!mutation || dispatched) throw new AdministrationExecutionError('invalid_operation');
          dispatched = true;
        }
        return ports.fetch(url, init);
      },
    });
    let result: unknown;
    try {
      switch (op.type) {
        case 'users.list': result = await provider.listUsers(); break;
        case 'groups.list': result = await provider.listGroups(); break;
        case 'licenses.list': result = await provider.listLicenses(); break;
        case 'user.get': result = await provider.getUser(op.id); break;
        case 'group.get': result = await provider.getGroup(op.id); break;
        case 'user.update': result = await provider.updateUser(op.id, op.update); break;
        case 'user.password.reset': result = await provider.resetUserPassword(op.id, fence); break;
        case 'user.sessions.revoke': result = await provider.revokeUserSessions(op.id, fence); break;
        case 'group.member.add': result = await provider.addGroupMember(op.groupId, op.userId); break;
        case 'group.member.remove': result = await provider.removeGroupMember(op.groupId, op.userId); break;
      }
      await fence();
    } catch (error) {
      const unknown = dispatched && (!(error instanceof AdminGraphError)
        || error.code === 'unknown_write_outcome');
      await audit('outcome', unknown ? 'unknown' : 'rejected');
      if (unknown) throw new AdministrationExecutionError('unknown_write_outcome');
      if (fenceFailure) throw fenceFailure;
      if (error instanceof AdministrationExecutionError || error instanceof AdminGraphError) throw error;
      throw new AdministrationExecutionError('provider_failed');
    }
    await audit('outcome', 'success');
    return result;
  };
}
