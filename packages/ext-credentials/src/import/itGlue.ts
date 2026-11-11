import { parseTotpSecret } from '../server/totp';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const HEADERS = ['id', 'organization', 'name', 'password_category', 'resource_type', 'resource_id', 'username', 'password', 'one_time_password', 'archived', 'url', 'notes', 'otp_secret', 'shareable'] as const;

/** Internal import data. Never serialize these rows as a preview or log them. */
export interface ItGlueRow {
  sourceId: string;
  sourceOrganization: string;
  name: string;
  category: string;
  username: string;
  email: string;
  password: string;
  url: string;
  notes: string;
  otpSecret: string;
  archived: boolean;
  issues: string[];
}

export class ItGlueImportError extends Error {
  constructor(public readonly code: string) {
    // Fixed codes only: malformed input can contain passwords in any column.
    super(code);
    this.name = 'ItGlueImportError';
  }
}

function fail(code: string): never { throw new ItGlueImportError(code); }

/** Strict RFC4180 quoting, accepting LF as well as CRLF exports. */
function csvRecords(input: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let pending = false;
  const finishField = () => {
    fields.push(field);
    if (fields.length > 256) fail('too_many_columns');
    field = '';
    state = 'start';
  };
  const finishRecord = () => {
    finishField();
    records.push(fields);
    if (records.length > MAX_ROWS + 1) fail('too_many_rows');
    fields = [];
    pending = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\0') fail('invalid_csv');
    pending = true;
    if (state === 'quoted') {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += ch;
      continue;
    }
    if (ch === ',') { finishField(); continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r') {
        if (input[i + 1] !== '\n') fail('invalid_csv');
        i++;
      }
      finishRecord();
      continue;
    }
    if (state === 'closed') fail('invalid_csv');
    if (ch === '"') {
      if (state !== 'start') fail('invalid_csv');
      state = 'quoted';
    } else { field += ch; state = 'plain'; }
  }
  if (state === 'quoted') fail('invalid_csv');
  if (pending) finishRecord();
  return records;
}

export function parseItGlueCsv(csv: string): ItGlueRow[] {
  if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) fail('file_too_large');
  const records = csvRecords(csv.replace(/^\uFEFF/, ''));
  const header = records.shift();
  if (!header) fail('missing_headers');
  if (new Set(header).size !== header.length) fail('duplicate_headers');
  if (HEADERS.some(key => !header.includes(key))) fail('missing_headers');
  const seen = new Set<string>();
  return records.map(fields => {
    if (fields.length !== header.length) fail('column_count_mismatch');
    const get = (key: typeof HEADERS[number]) => fields[header.indexOf(key)]!;
    const sourceId = get('id').trim();
    if (sourceId && seen.has(sourceId)) fail('duplicate_source_id');
    if (sourceId) seen.add(sourceId);
    const issues: string[] = [];
    const sourceOrganization = get('organization').trim();
    const name = get('name').trim();
    if (!sourceId) issues.push('missing_source_id');
    if (!sourceOrganization) issues.push('missing_organization');
    if (!name) issues.push('missing_name');
    const username = get('username');
    const password = get('password');
    const otpSecret = get('otp_secret').trim();
    if (!username) issues.push('missing_username');
    if (!password) issues.push('missing_password');
    if (otpSecret) {
      try { parseTotpSecret(otpSecret); }
      catch { issues.push('invalid_otp_secret'); }
    } else if (!['', 'no', 'false', '0'].includes(get('one_time_password').trim().toLowerCase())) {
      issues.push('otp_value_without_secret');
    }
    const archive = get('archived').trim().toLowerCase();
    if (!['', 'false', 'true', '0', '1', 'no', 'yes'].includes(archive)) issues.push('invalid_archived');
    return {
      sourceId, sourceOrganization, name, category: get('password_category'), username,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) ? username : '',
      password, url: get('url'), notes: get('notes'), otpSecret,
      archived: ['true', '1', 'yes'].includes(archive), issues,
    };
  });
}

/** Deliberately aggregate-only. Sensitive input never appears in this result. */
export function previewItGlue(rows: readonly ItGlueRow[]) {
  const organizations = new Map<string, number>();
  const issueCounts: Record<string, number> = {};
  const knownIssues = new Set(['missing_source_id', 'missing_organization', 'missing_name', 'missing_username', 'missing_password', 'invalid_otp_secret', 'otp_value_without_secret', 'invalid_archived']);
  let withOtp = 0;
  let archived = 0;
  let flagged = 0;
  for (const row of rows) {
    organizations.set(row.sourceOrganization, (organizations.get(row.sourceOrganization) ?? 0) + 1);
    if (row.otpSecret) withOtp++;
    if (row.archived) archived++;
    if (row.issues.length) flagged++;
    for (const issue of new Set(row.issues)) {
      const code = knownIssues.has(issue) ? issue : 'invalid_record';
      issueCounts[code] = (issueCounts[code] ?? 0) + 1;
    }
  }
  return {
    total: rows.length, withOtp, archived, flagged, issueCounts,
    organizations: [...organizations].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
