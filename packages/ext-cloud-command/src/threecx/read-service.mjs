/**
 * Read-only 3CX orchestration used by the extension's authenticated route.
 * Ports MUST be server-owned: authorize through Breeze, load with enforced RLS,
 * and call the PBX through an egress-safe transport. This module itself has no
 * network implementation or credential store.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['Id', 'Number', 'FirstName', 'LastName', 'EmailAddress', 'Mobile', 'Enabled', 'IsRegistered', 'CurrentProfileName'];

export class ThreeCxReadError extends Error {
  constructor(code) { super(code); this.name = 'ThreeCxReadError'; this.code = code; }
}
const fail = code => { throw new ThreeCxReadError(code); };

/** Origin syntax only. DNS pinning/private-address policy belongs to transport. */
export function normalizePbxOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('invalid_origin');
  return url.origin;
}

export function publicConnection(connection) {
  return {
    id: connection.id, organizationId: connection.organizationId,
    origin: normalizePbxOrigin(connection.origin), enabled: connection.enabled,
    departmentId: connection.departmentId ?? null,
  };
}

export function createThreeCxReadService(ports) {
  return {
    async listExtensions(scope, connectionId, skip = 0) {
      if (!scope || !uuid.test(scope.organizationId) || !uuid.test(scope.partnerId) || !scope.actorId || !uuid.test(connectionId)) fail('invalid_scope');
      if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100000 || skip % 100 !== 0) fail('invalid_page');
      // Authorization runs before either connection lookup or secret access.
      if (!await ports.authorize(scope, 'threecx.read')) fail('access_denied');
      const connection = await ports.loadConnection(scope, connectionId);
      if (!connection || connection.organizationId !== scope.organizationId || connection.partnerId !== scope.partnerId || connection.id !== connectionId || connection.enabled !== true) fail('not_available');
      if (connection.departmentId != null && (!Number.isSafeInteger(connection.departmentId) || connection.departmentId < 0)) fail('invalid_department');
      const origin = normalizePbxOrigin(connection.origin);
      let response;
      try {
        response = await ports.readUsers({
          scope, connectionId, origin, credentialRef: connection.credentialRef,
          query: { '$select': fields.join(','), '$expand': 'Groups($select=GroupId)', '$top': 100, '$skip': skip, '$orderby': 'Number' },
        });
      } catch {
        // Transport errors may contain tokens, origins or upstream bodies.
        fail('provider_read_failed');
      }
      if (!response || !Array.isArray(response.value) || response.value.length > 100) fail('invalid_provider_response');
      const rows = response.value;
      const items = [];
      for (const row of rows) {
        if (!row || !Number.isSafeInteger(row.Id) || row.Id < 0 || typeof row.Number !== 'string') fail('invalid_provider_response');
        if (connection.departmentId != null) {
          if (!Array.isArray(row.Groups) || row.Groups.some(g => !g || !Number.isSafeInteger(g.GroupId))) fail('invalid_provider_response');
          if (!row.Groups.some(g => g.GroupId === connection.departmentId)) continue;
        }
        // Never forward arbitrary upstream properties or the membership expansion.
        const safe = {};
        for (const key of fields) {
          const value = row[key];
          if (value == null) { safe[key] = null; continue; }
          if (key === 'Id' || (['Enabled', 'IsRegistered'].includes(key) ? typeof value === 'boolean' : typeof value === 'string' && value.length <= 2048)) safe[key] = value;
          else fail('invalid_provider_response');
        }
        items.push(safe);
      }
      // Never follow a provider nextLink: it could send auth to another host.
      // Advance by RAW page length, not the count after department filtering.
      const more = Boolean(response['@odata.nextLink']) || rows.length === 100;
      return { items, nextSkip: more && skip < 100000 ? skip + 100 : null, truncated: more && skip >= 100000 };
    },
  };
}
