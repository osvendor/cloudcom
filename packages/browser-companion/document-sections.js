// Generated from ext-credentials/src/import/documentSections.ts; keep behavior aligned.
const labels = {
    username: 'Username', user: 'Username', 'user name': 'Username', login: 'Username', 'login name': 'Username',
    email: 'Email', 'email address': 'Email', password: 'Password', pass: 'Password', pwd: 'Password',
    'otp seed': 'OTP seed', 'otp secret': 'OTP seed', 'totp seed': 'OTP seed', 'totp secret': 'OTP seed',
    '2fa secret': 'OTP seed', 'mfa secret': 'OTP seed', 'authenticator secret': 'OTP seed',
    'otp code': 'OTP code', 'totp code': 'OTP code', '2fa code': 'OTP code', 'mfa code': 'OTP code',
};
// Restrict inferred headings to a fixed vocabulary. Arbitrary short strings
// can be passwords too, so neither them nor the workbook name becomes a title.
const headings = new Set(['notes', 'general notes', 'general information', 'email', 'network', 'network notes', 'vpn', 'router', 'firewall', 'server', 'servers', 'wireless', 'wifi', 'wi-fi', 'internet', 'printers', 'printing', 'backup', 'backups', 'office 365', 'microsoft 365', 'accounts', 'credentials', 'contacts', 'instructions', 'software', 'hardware']);
function heading(text) {
    const normalized = text.trim().replace(/^#{1,3}\s+/, '').replace(/:$/, '').trim();
    if (headings.has(normalized.toLowerCase()))
        return normalized;
    // Explicitly punctuated natural-language service headings are useful, but
    // never infer titles from bare tokens, field labels, digits or inline values.
    if (text.trim().endsWith(':') && normalized.length <= 60 && /^[A-Za-z]+(?:[ -][A-Za-z]+)+$/.test(normalized)
        && /\b(?:admin|account|accounts|network|settings|support|install|portal|server|password|firewall|backup)\b/i.test(normalized)
        && !labels[normalized.toLowerCase()])
        return normalized;
    return null;
}
function field(text) {
    const match = /^\s*([^:=\r\n]{1,32})\s*[:=](.*)$/s.exec(text);
    const label = (match ? match[1] : text.replace(/:$/, '')).trim().toLowerCase();
    const kind = labels[label];
    return kind ? { kind, value: match ? match[2].replace(/^\s+/, '') : null } : null;
}
function seedLike(value) {
    // Numeric one-time codes are NEVER imported or presented as seed material.
    const normalized = value.trim().replace(/[\s-]/g, '');
    if (/^[0-9]+$/.test(normalized))
        return false;
    if (/^[A-Z2-7]{16,}=*$/i.test(normalized))
        return true;
    try {
        const uri = new URL(value.trim());
        const secret = uri.searchParams.get('secret') ?? '';
        return uri.protocol === 'otpauth:' && uri.hostname === 'totp' && /^[A-Z2-7]{16,}=*$/i.test(secret) && !/^[0-9]+$/.test(secret);
    }
    catch {
        return false;
    }
}
const suspicious = (text) => /^[^\s]{8,128}$/.test(text.trim()) || /(?:otpauth:\/\/|\b(?:username|login|password|passwd|pwd|otp|totp|2fa|mfa|recovery\s+code|secret|token)\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i.test(text);
export function classifySheet(sheet) {
    const result = [];
    let current = null;
    let safeHeading = null;
    let previousRow = null;
    let pending = null;
    const start = () => current ??= { id: `section-${result.length + 1}`, title: '', kind: 'notes', fields: [], notes: [], sourceRows: [], sourceCells: [] };
    const finish = () => {
        if (!current)
            return;
        if (current.fields.length && current.notes.length)
            current.kind = 'review';
        if (new Set(current.fields.map(field => field.label)).size !== current.fields.length)
            current.kind = 'review';
        if (current.fields.some(f => !f.value || f.label.includes('(review)') || f.label === 'OTP code'))
            current.kind = 'review';
        const prefix = current.kind === 'credentials' ? 'Credentials' : current.kind === 'review' ? 'Review' : 'Notes';
        current.title = safeHeading ?? `${prefix} ${result.length + 1}`;
        result.push(current);
        current = null;
        safeHeading = null;
        pending = null;
    };
    for (const row of [...sheet.rows].sort((a, b) => a.row - b.row)) {
        const nonempty = row.cells.filter(cell => cell.text.trim());
        if (previousRow !== null && row.row > previousRow + 1)
            finish();
        previousRow = row.row;
        if (!nonempty.length) {
            // Keep explicit empty source cells rather than discarding provenance.
            if (row.cells.length) {
                const section = start();
                section.sourceRows.push(row.row);
                section.sourceCells.push(...row.cells.map(cell => ({ row: row.row, ...cell })));
            }
            finish();
            continue;
        }
        const title = !pending && nonempty.length === 1 ? heading(nonempty[0].text) : null;
        if (title) {
            finish();
            safeHeading = title;
            const section = start();
            section.sourceRows.push(row.row);
            section.sourceCells.push(...row.cells.map(cell => ({ row: row.row, ...cell })));
            continue;
        }
        const section = start();
        section.sourceRows.push(row.row);
        section.sourceCells.push(...row.cells.map(cell => ({ row: row.row, ...cell })));
        if (pending && pending.section === section && row.row === pending.row + 1 && nonempty.length === 1 && nonempty[0].column === pending.column && !field(nonempty[0].text)) {
            const target = section.fields[pending.fieldIndex];
            target.value = nonempty[0].text;
            if (pending.kind === 'OTP seed' && !seedLike(target.value)) {
                target.label = 'OTP value (review)';
                section.kind = 'review';
            }
            pending = null;
            continue;
        }
        pending = null;
        // A line is still inert text; formulas, URLs and markup are never executed.
        const tokens = nonempty.flatMap(cell => cell.text.split(/\r\n|\n|\r/).map((text, line) => ({ text, column: cell.column, line }))).filter(token => token.text.trim());
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i], text = token.text;
            const parsed = field(text);
            if (!parsed) {
                section.notes.push(text);
                if (suspicious(text))
                    section.kind = 'review';
                continue;
            }
            let value = parsed.value;
            if (value === null || value === '') {
                const next = tokens[i + 1];
                const columnNumber = (column) => [...column].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
                const adjacent = next && ((next.column === token.column && next.line === token.line + 1) || (next.column !== token.column && columnNumber(next.column) === columnNumber(token.column) + 1));
                if (next !== undefined && adjacent && !field(next.text)) {
                    value = next.text;
                    i++;
                }
                else
                    value = '';
            }
            const uncertain = parsed.kind === 'OTP code' || (Boolean(value) && parsed.kind === 'OTP seed' && !seedLike(value));
            const label = parsed.kind === 'OTP seed' && value && !seedLike(value) ? 'OTP value (review)' : parsed.kind;
            section.fields.push({ label, value, secret: parsed.kind === 'Password' || parsed.kind.startsWith('OTP') });
            if (!value && nonempty.length === 1 && tokens.length === 1)
                pending = { section, fieldIndex: section.fields.length - 1, kind: parsed.kind, column: token.column, row: row.row };
            if (uncertain)
                section.kind = 'review';
            else if (section.kind !== 'review')
                section.kind = 'credentials';
        }
    }
    finish();
    return result;
}
