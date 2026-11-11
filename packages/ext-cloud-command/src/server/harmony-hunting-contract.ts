/** Schema adapter ONLY. No transport is wired until Check Point confirms the
 * external API authentication/tenant contract and EPGUID-to-inventory binding.
 * https://sc1.checkpoint.com/documents/latest/ThAPIs/index.html
 * Host authorization must supply the verified exact-device binding, never model
 * input. Provider text is evidence, never executable instructions or authority. */
import { z } from 'zod';

const eventTypes = ['Process', 'Network', 'File', 'Dns', 'Registry', 'RemoteLogon', 'DetectionEvent'] as const;
const inputSchema = z.object({
  from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
  recordTypes: z.array(z.enum(eventTypes)).min(1).max(7),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();
const bindingSchema = z.object({
  orgId: z.string().uuid(), deviceId: z.string().uuid(), epGuid: z.string().uuid(),
  mappingVersion: z.number().int().positive(),
}).strict();
export type HarmonyHuntInput = z.input<typeof inputSchema>;
export type HarmonyHuntBinding = z.infer<typeof bindingSchema>;
export class HarmonyHuntContractError extends Error {
  constructor(public code: string) { super(code); }
}
const fail = (code: string): never => { throw new HarmonyHuntContractError(code); };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : fail('hunting_invalid_response');
const text = (v: unknown, max = 1024): string | null => v == null ? null
  : typeof v === 'string' && v.length <= max ? v.replace(/[\u0000-\u001f\u007f]/g, ' ')
    : fail('hunting_invalid_response');

// No process arguments, file/script bodies, URL query strings or registry data.
// Sensitive raw fields need an explicit later design, not arbitrary selection.
const projectedFields = {
  Base: ['ProcessName', 'ProcessMD5', 'ProcessSigner', 'ParentProcessName', 'ParentProcessMD5', 'ProcessClassification'],
  Network: ['NetworkProtocol', 'NetworkDestIP', 'NetworkDestPort', 'NetworkDomain', 'NetworkConnectionDirection'],
  File: ['FileName', 'FileMD5', 'FileSigner', 'OriginalFileClassification'],
  Dns: ['DnsQueryName', 'DnsResponse'],
  Registry: ['RegistryKey', 'RegistryValue'],
  RemoteLogon: ['RemoteOwnerUserName', 'RemoteOwnerDomainName', 'RemoteAttackerIpAddress', 'RemoteLogonType', 'EventType'],
  DetectionEvent: ['DetectionIncidentId', 'DetectionAttackStatus', 'DetectionMalwareAction', 'DetectionProtectionName', 'DetectionIncidentSeverity', 'DetectionIncidentConfidence', 'DetectionTriggerMD5'],
} as const;
const selection = Object.entries(projectedFields).map(([name, fields]) =>
  `${name} { ${name === 'Base' ? 'RecordType OpTimeUTC ' : ''}${fields.join(' ')} }`).join('\n');
export const HARMONY_HUNT_QUERY = `query BreezeEndpointHunt($indicators: [Indicator]!, $queryParam: QueryParam) {
  searchRecords(indicators: $indicators, queryParam: $queryParam) {
    pagination { maxResults pageToken }
    metadata { totalRows jobId }
    records { ... on EPRecord { UUID EPGUID ${selection} } }
  }
}`;

/** One endpoint per query avoids reliance on undocumented inter-indicator AND
 * semantics. Additional filters can only be introduced after live contract QA. */
export function buildHarmonyHunt(binding: HarmonyHuntBinding, input: HarmonyHuntInput, now = Date.now()) {
  const b = bindingSchema.safeParse(binding), p = inputSchema.safeParse(input);
  if (!b.success || !p.success) return fail('hunting_invalid_request');
  const start = Date.parse(p.data.from), end = Date.parse(p.data.to);
  if (end <= start || end - start > 24 * 60 * 60_000 || end > now + 60_000) return fail('hunting_invalid_time_range');
  const scope = { ...b.data, epGuid: b.data.epGuid.toLowerCase() };
  const window = { ...p.data, recordTypes: [...new Set(p.data.recordTypes)] };
  return {
    binding: scope, window,
    body: { query: HARMONY_HUNT_QUERY, variables: {
      indicators: [{ fieldType: 'EPGUID', operator: 'Is', fieldArr: [scope.epGuid], escaped: false }],
      queryParam: { dateRange: { from: window.from, to: window.to },
        pagination: { maxResults: window.limit }, timeoutMs: 10_000,
        orderBy: { field: 'OpTimeUTC', ascDesc: 'DESC' },
        dataSourceTypes: ['endpoint'], recordTypes: window.recordTypes },
    } },
  };
}
export type HarmonyHuntPlan = ReturnType<typeof buildHarmonyHunt>;

/** Bounded one-page normalization. Never persist a partial GraphQL error as an
 * empty successful hunt, accept another endpoint, or expose provider cursors as
 * caller-controlled authorization. A later transport owns continuation tokens. */
export function normalizeHarmonyHuntPage(value: unknown, plan: HarmonyHuntPlan, collectedAt = new Date().toISOString()) {
  const checkedPlan = buildHarmonyHunt(plan.binding, plan.window, Date.parse(collectedAt));
  if (!Number.isFinite(Date.parse(collectedAt))) return fail('hunting_invalid_request');
  const root = object(value);
  if (root.errors != null && (!Array.isArray(root.errors) || root.errors.length > 0)) return fail('hunting_query_failed');
  const result = object(object(root.data).searchRecords), pagination = object(result.pagination), metadata = object(result.metadata);
  if (!Array.isArray(result.records) || result.records.length > checkedPlan.window.limit) return fail('hunting_invalid_response');
  const total = metadata.totalRows;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < result.records.length) return fail('hunting_invalid_response');
  const continuation = text(pagination.pageToken, 8192);
  const seen = new Set<string>();
  const records = result.records.map(raw => {
    const row = object(raw), base = object(row.Base);
    const epGuid = text(row.EPGUID, 128), id = text(row.UUID, 512), kind = text(base.RecordType, 64), at = base.OpTimeUTC;
    if (!epGuid || epGuid.toLowerCase() !== checkedPlan.binding.epGuid) return fail('hunting_endpoint_scope_mismatch');
    if (!id || seen.has(id) || !kind || !checkedPlan.window.recordTypes.includes(kind as typeof eventTypes[number])) return fail('hunting_invalid_response');
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < Date.parse(plan.window.from) || at > Date.parse(plan.window.to)) return fail('hunting_time_scope_mismatch');
    seen.add(id);
    const details: Record<string, Record<string, string | null>> = {};
    for (const [key, fields] of Object.entries(projectedFields)) {
      if (row[key] == null) continue;
      const source = object(row[key]);
      details[key] = Object.fromEntries(fields.map(field => [field, text(source[field])]));
    }
    return { id, occurredAt: new Date(at).toISOString(), type: kind, details,
      reference: `harmony-th:${checkedPlan.binding.orgId}:${checkedPlan.binding.deviceId}:${id}` };
  });
  return {
    source: 'Check Point Threat Hunting' as const, orgId: checkedPlan.binding.orgId, deviceId: checkedPlan.binding.deviceId,
    mappingVersion: checkedPlan.binding.mappingVersion, collectedAt, window: checkedPlan.window,
    records, returned: records.length, totalMatched: total,
    coverage: continuation || total > records.length ? 'partial' as const : 'complete' as const,
    interpretation: { providerTextIsUntrusted: true, absenceOfRecordsIsNotProofOfSafety: true, responseActionExecuted: false },
  };
}
