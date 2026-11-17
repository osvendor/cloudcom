import { CREDENTIAL_ACCOUNT_TYPES, normalizeCredential, type CredentialAccountType, type CredentialNormalizationInput } from './normalize';

export type CredentialNoteSheet = {
  name: string;
  rows: { row: number; cells: { column: string; text: string }[] }[];
};
export type NoteCredentialCandidate = {
  source: { sheetIndex: number; sheetName: string; row: number; usernameRow: number; passwordRow: number };
  fields: CredentialNormalizationInput;
  reviewReasons: string[];
};
export type NoteCredentialExtractionOptions = { emailProvider?: 'microsoft' | 'google' };
type Field = 'username' | 'password' | 'name' | 'url' | 'category' | 'otpSecret';
type Values = Partial<Record<Field, string>>;
type AccountContext = { name: string; category: CredentialAccountType; source: 'section' | 'sheet' | 'table' | 'record'; conflict?: boolean; isAdministration?: boolean };

// Deliberately narrow. "Key", "secret", "code", and "account" alone do not
// identify passwords or usernames and must never turn arbitrary notes into logins.
const fieldLabels: Record<Field, readonly string[]> = {
  username: ['username', 'user name', 'user login', 'login name', 'domain username', 'domain user', 'email', 'e-mail', 'email address', 'mailbox'],
  password: ['password', 'passwd', 'pwd'],
  name: ['account name', 'service', 'application', 'account label'],
  url: ['url', 'login url', 'website'],
  category: ['account type', 'category'],
  otpSecret: ['totp secret', '2fa secret'],
};
function field(label: string): Field | undefined {
  const normalized = label.trim().replace(/:\s*$/, '').toLowerCase();
  return (Object.keys(fieldLabels) as Field[]).find(key => fieldLabels[key].includes(normalized));
}
function placeholder(value: string): boolean {
  const v = value.trim();
  return !v || /^(?:[*•●·xX]{3,}|[—–-]+|\.{3,}|<\s*(?:redacted|hidden|masked|password|username)\s*>|\[\s*(?:redacted|hidden|masked)\s*\]|redacted|hidden|masked|n\/?a|none|null|unknown|not set|tbd|todo)$/i.test(v);
}
function standaloneSecret(label: string): boolean {
  return /\b(?:api\s*(?:key|token|secret)|app(?:lication)?\s+(?:key|secret)|client\s+secret|licen[cs]e\s*key|encryption\s*key|recovery\s*(?:key|codes?)|uninstall(?:\s*(?:password|key|code))?|access\s*token)\b/i.test(label);
}
function columnNumber(column: string): number {
  return [...column].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}
function orderedCells(row: CredentialNoteSheet['rows'][number]) {
  return [...row.cells].sort((a, b) => columnNumber(a.column) - columnNumber(b.column));
}

function accountContext(value: string, source: AccountContext['source']): AccountContext | undefined {
  const title = value.trim().replace(/[:\s]+$/, '');
  // A heading supplies type/service only, never secrets. Reject prose and account
  // identifiers rather than treating a client name, Sheet1 or OneNote as a service.
  if (!title || title.length > 160 || /[\r\n@]/.test(title) || standaloneSecret(title)) return;
  const exact = CREDENTIAL_ACCOUNT_TYPES.find(category => category.toLowerCase() === title.toLowerCase());
  if (exact) return { name: exact, category: exact, source };
  if (/^(?:e-?mail|mailbox)(?:\s+(?:users?|accounts?|credentials?|logins?|passwords?))*$/i.test(title))
    return { name: 'Email', category: 'Email', source };
  if (/^(?:domain|active directory|ad)(?:\s+(?:users?|accounts?|credentials?|logins?|passwords?))*$/i.test(title))
    return { name: 'Active Directory', category: 'Local / Domain', source };
  if (/^(?:local|windows|computer|computers)(?:\s+(?:users?|accounts?|credentials?|logins?|passwords?))*$/i.test(title))
    return { name: 'Local / Domain', category: 'Local / Domain', source };
  if (/^(?:network|wi-?fi|wireless)(?:\s+(?:users?|accounts?|credentials?|logins?|passwords?))*$/i.test(title))
    return { name: 'Network / Wi-Fi', category: 'Network / Wi-Fi', source };
  if (/^(?:applications?|cloud)(?:\s+(?:users?|accounts?|credentials?|logins?|passwords?))*$/i.test(title))
    return { name: 'Application / Cloud', category: 'Application / Cloud', source };
  const normalized = normalizeCredential({ name: title, category: '', username: '', email: '', url: '', password: 'classification-only', otpSecret: '', notes: '' });
  // Application services are accepted by the normalizer only when recognized.
  // Email/network also have generic prose fallbacks: allow only their canonical
  // services here so a sentence mentioning email does not become a section name.
  if (normalized.disposition !== 'credential' || normalized.reasons.length) return;
  if (normalized.category === 'Email' && !['Microsoft 365', 'Google Workspace', 'Gmail', 'Rackspace'].includes(normalized.name)) return;
  if (normalized.category === 'Network / Wi-Fi'
    && !['SonicWall', 'Fortinet', 'UniFi', 'EnGenius', 'Zyxel', 'Synology', 'QNAP', 'iDRAC'].includes(normalized.name)) return;
  return { name: normalized.name, category: normalized.category, source, isAdministration: normalized.isAdministration };
}

/** Read-only proposals from explicit structures, never inferred prose passwords. */
export function extractNoteCredentials(
  sheets: readonly CredentialNoteSheet[], options: NoteCredentialExtractionOptions = {},
): NoteCredentialCandidate[] {
  const candidates: NoteCredentialCandidate[] = [];
  sheets.forEach((sheet, sheetIndex) => {
    let headers: Partial<Record<Field, string>> | undefined;
    const sheetContext = accountContext(sheet.name, 'sheet');
    let sectionContext: AccountContext | undefined;
    let sectionRow = 0;
    let tableContext: AccountContext | undefined;
    let blockContext: AccountContext | undefined;
    let block: Values = {};
    let positions: Partial<Record<Field, number>> = {};
    let blockStart = 0;
    let lastRow = 0;
    let blockedSection = standaloneSecret(sheet.name);

    const nearbyContext = (row: number) => sectionContext && row - sectionRow <= 8 ? sectionContext : sheetContext;
    const emit = (values: Values, start: number, usernameRow: number, passwordRow: number, origin: string, inherited?: AccountContext) => {
      if (!values.username || !values.password || placeholder(values.username) || placeholder(values.password)) return;
      if (blockedSection || standaloneSecret(`${values.name ?? ''} ${values.category ?? ''}`)) return;
      const reviewReasons = [origin, 'verify_source_account_before_import'];
      const explicit = accountContext(values.name ?? '', 'record') ?? accountContext(values.category ?? '', 'record');
      const context = explicit ?? inherited;
      if (!context) reviewReasons.push('account_type_and_service_need_review');
      if (context?.conflict || explicit && inherited && explicit.category !== inherited.category)
        reviewReasons.push('conflicting_account_context');
      const category = context?.category ?? '';
      // Unclassified candidates carry a generic label and remain review-only.
      // Original sheet/client labels are provenance, never a proposed service.
      let label = context?.name ?? 'Application / Cloud';
      // A client provider enriches explicit email records only. A domain account
      // or Adobe login in a Google client must not become a Google email account.
      if (label === 'Email' && category === 'Email' && options.emailProvider) {
        label = options.emailProvider === 'google' ? 'Google Workspace' : 'Microsoft 365';
      }
      // Preserve explicit administration evidence through the next normalization
      // pass; it removes this suffix while retaining the administration flag.
      if (explicit?.isAdministration || inherited?.isAdministration) label += ' administration';
      const otpSecret = values.otpSecret && !placeholder(values.otpSecret) ? values.otpSecret : '';
      candidates.push({
        source: { sheetIndex, sheetName: sheet.name, row: start, usernameRow, passwordRow },
        fields: {
          name: label, category, username: values.username,
          email: category === 'Email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.username) ? values.username : '',
          password: values.password, url: values.url ?? '', otpSecret, notes: '',
        },
        reviewReasons,
      });
    };
    const flush = () => {
      if (positions.username !== undefined && positions.password !== undefined) {
        emit(block, blockStart, positions.username, positions.password, 'explicit_label_value_fields', blockContext);
      }
      block = {}; positions = {}; blockStart = 0; blockContext = undefined;
    };

    for (const row of [...sheet.rows].sort((a, b) => a.row - b.row)) {
      const cells = orderedCells(row);
      if (!cells.some(cell => cell.text.trim())) {
        flush(); headers = undefined; blockedSection = standaloneSecret(sheet.name); lastRow = row.row; continue;
      }
      if (lastRow && row.row > lastRow + 1) { flush(); headers = undefined; blockedSection = standaloneSecret(sheet.name); }
      lastRow = row.row;

      const possibleHeaders: Partial<Record<Field, string>> = {};
      let duplicateHeader = false;
      for (const cell of cells) {
        const key = field(cell.text);
        if (key) {
          if (possibleHeaders[key]) duplicateHeader = true;
          possibleHeaders[key] = cell.column;
        }
      }
      const headerOnly = cells.every(cell => !cell.text.trim() || field(cell.text)
        || /^(?:notes?|description|id|computer(?: name)?|hostname|domain)$/i.test(cell.text.trim()));
      if (possibleHeaders.username && possibleHeaders.password && !duplicateHeader && headerOnly) {
        flush(); headers = possibleHeaders; tableContext = nearbyContext(row.row);
        if (cells.some(cell => /^(?:computer(?: name)?|hostname|domain|domain username|domain user)$/i.test(cell.text.trim()))) {
          tableContext = { name: 'Local / Domain', category: 'Local / Domain', source: 'table', conflict: Boolean(tableContext && tableContext.category !== 'Local / Domain'), isAdministration: tableContext?.isAdministration };
        }
        continue;
      }
      if (headers) {
        const values: Values = {};
        for (const key of Object.keys(headers) as Field[]) {
          const value = cells.find(cell => cell.column === headers![key])?.text;
          if (value !== undefined) values[key] = value;
        }
        // A new labeled section terminates a table instead of treating its text
        // as an additional row of usernames and passwords.
        if (field(values.username ?? '') || field(values.password ?? '')) { headers = undefined; }
        else if (values.username && values.password) { emit(values, row.row, row.row, row.row, 'explicit_username_password_table', tableContext); continue; }
        else { headers = undefined; }
      }

      const values: Values = {};
      for (let index = 0; index < cells.length; index++) {
        const cell = cells[index]!;
        const key = field(cell.text);
        const next = cells[index + 1];
        if (key && next && columnNumber(next.column) === columnNumber(cell.column) + 1 && !field(next.text)) {
          values[key] = next.text; index++; continue;
        }
        // Only anchored labels qualify. Preserve the value after the colon,
        // treating a single formatting space as part of the label separator.
        const match = /^\s*([^:\r\n]{1,30}): ?([^\r\n]*)$/.exec(cell.text);
        const inlineKey = match ? field(match[1]!) : undefined;
        if (inlineKey) values[inlineKey] = match![2]!;
      }
      const keys = Object.keys(values) as Field[];
      if (!keys.length) {
        flush();
        // Plain headings can exclude a key-only section, but cannot supply
        // either a username or a password.
        blockedSection = standaloneSecret(sheet.name) || cells.some(cell => standaloneSecret(cell.text));
        const nonempty = cells.filter(cell => cell.text.trim());
        sectionContext = nonempty.length === 1 ? accountContext(nonempty[0]!.text, 'section') : undefined;
        sectionRow = row.row;
        continue;
      }
      if (keys.some(key => block[key] !== undefined) || blockStart && row.row - blockStart > 7) flush();
      if (!blockStart) { blockStart = row.row; blockContext = nearbyContext(row.row); }
      for (const key of keys) { block[key] = values[key]; positions[key] = row.row; }
    }
    flush();
  });
  return candidates;
}
