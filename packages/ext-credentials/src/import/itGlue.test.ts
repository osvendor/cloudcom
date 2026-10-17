import { describe, expect, it } from 'vitest';
import { parseItGlueCsv, previewItGlue } from './itGlue';

const headers = ['id', 'organization', 'name', 'password_category', 'resource_type', 'resource_id', 'username', 'password', 'one_time_password', 'archived', 'url', 'notes', 'otp_secret', 'shareable'];
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const record = (values: Record<string, string> = {}) => headers.map(h => quote(({ id: '1', organization: 'Client A', name: 'Example', username: 'test@example.invalid', password: 'SYNTHETIC-password', archived: 'false', ...values } as Record<string, string>)[h] ?? '')).join(',');
const csv = (...records: string[]) => `${headers.join(',')}\r\n${records.join('\r\n')}`;

describe('IT Glue credential importer', () => {
  it.each(['No', 'FALSE', '0', ''])('treats the IT Glue OTP flag %j as disabled', flag => {
    expect(parseItGlueCsv(csv(record({ one_time_password: flag })))[0]?.issues).not.toContain('otp_value_without_secret');
  });
  it('requires a seed for the enabled OTP flag', () => {
    expect(parseItGlueCsv(csv(record({ one_time_password: 'Yes' })))[0]?.issues).toContain('otp_value_without_secret');
  });
  it('preserves quoted multiline secrets and independent username/email fields', () => {
    const [row] = parseItGlueCsv('\uFEFF' + csv(record({ password: '  comma, "quote"\r\nnext  ', notes: 'line1\nline2' })) + '\r\n');
    expect(row?.password).toBe('  comma, "quote"\r\nnext  ');
    expect(row?.notes).toBe('line1\nline2');
    expect(row?.email).toBe('test@example.invalid');
    expect(parseItGlueCsv(csv(record({ username: 'DOMAIN\\user' })))[0]?.email).toBe('');
  });
  it('accepts reordered structural columns and ignores extra columns', () => {
    const reordered = [...headers].reverse();
    const input = `${reordered.join(',')},extra\n${reordered.map(h => quote(h === 'id' ? '1' : h === 'organization' ? 'A' : '')).join(',')},ignored`;
    expect(parseItGlueCsv(input)[0]?.sourceOrganization).toBe('A');
  });
  it('preserves URI parameters and flags invalid OTP rather than dropping it', () => {
    const uri = 'otpauth://totp/Example:test?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256';
    const rows = parseItGlueCsv(csv(record({ otp_secret: uri }), record({ id: '2', otp_secret: 'not!base32' }), record({ id: '3', one_time_password: '123456' })));
    expect(rows[0]?.otpSecret).toBe(uri);
    expect(rows[0]?.issues).not.toContain('invalid_otp_secret');
    expect(rows[1]?.otpSecret).toBe('not!base32');
    expect(rows[1]?.issues).toContain('invalid_otp_secret');
    expect(rows[2]?.issues).toContain('otp_value_without_secret');
  });
  it('returns only aggregate metadata in previews', () => {
    const rows = parseItGlueCsv(csv(record({ name: 'SECRET-NAME', notes: 'SECRET-NOTES', otp_secret: 'JBSWY3DPEHPK3PXP' }), record({ id: '2', username: '', password: '', archived: 'yes' })));
    const preview = previewItGlue(rows);
    expect(preview).toMatchObject({ total: 2, withOtp: 1, archived: 1, flagged: 1, organizations: [{ name: 'Client A', count: 2 }], issueCounts: { missing_username: 1, missing_password: 1 } });
    const serialized = JSON.stringify(preview);
    for (const secret of ['SECRET-NAME', 'SECRET-NOTES', 'JBSWY3DPEHPK3PXP', 'test@example.invalid', 'SYNTHETIC-password']) expect(serialized).not.toContain(secret);
    rows[0]!.issues.push('SECRET-INJECTED-ISSUE');
    expect(JSON.stringify(previewItGlue(rows))).not.toContain('SECRET-INJECTED-ISSUE');
  });
  it('rejects duplicated source IDs even across organizations', () => {
    expect(() => parseItGlueCsv(csv(record(), record({ organization: 'Client B' })))).toThrow('duplicate_source_id');
  });
  it('rejects duplicate/missing headers and column mismatch without input leakage', () => {
    expect(() => parseItGlueCsv(headers.join(',') + ',id')).toThrow('duplicate_headers');
    expect(() => parseItGlueCsv('id,password\n1,secret')).toThrow('missing_headers');
    expect(() => parseItGlueCsv(csv('secret'))).toThrow('column_count_mismatch');
  });
  it.each(['"unterminated', 'abc"def', '"closed"garbage', 'abc\rdef', 'abc\0def'])('rejects malformed quoting or control syntax', bad => {
    expect(() => parseItGlueCsv(csv(bad))).toThrow('invalid_csv');
  });
  it('bounds byte size and row count', () => {
    expect(() => parseItGlueCsv('x'.repeat(10 * 1024 * 1024 + 1))).toThrow('file_too_large');
    expect(() => parseItGlueCsv(csv(...Array.from({ length: 10_001 }, (_, i) => record({ id: String(i) }))))).toThrow('too_many_rows');
    expect(() => parseItGlueCsv(','.repeat(256))).toThrow('too_many_columns');
  });
});
