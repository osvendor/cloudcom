import { describe, expect, it } from 'vitest';
import { extractNoteCredentials, type CredentialNoteSheet } from './extractNoteCredentials';
import { normalizeCredential } from './normalize';

const sheet = (name: string, values: string[][]): CredentialNoteSheet => ({
  name, rows: values.map((cells, index) => ({ row: index + 1, cells: cells.map((text, column) => ({ column: String.fromCharCode(65 + column), text })) })),
});

describe('conservative note credential extraction', () => {
  it('extracts explicit table fields and stable provenance without modifying the source', () => {
    const input = [sheet('Accounts', [
      ['Service', 'Username', 'Password', 'URL'],
      ['Google Workspace', 'person@example.test', '  synthetic-pass  ', 'https://accounts.example.test'],
    ])];
    const before = JSON.stringify(input);
    expect(extractNoteCredentials(input)).toEqual([{
      source: { sheetIndex: 0, sheetName: 'Accounts', row: 2, usernameRow: 2, passwordRow: 2 },
      fields: { name: 'Google Workspace', category: 'Email', username: 'person@example.test', email: 'person@example.test', password: '  synthetic-pass  ', url: 'https://accounts.example.test', otpSecret: '', notes: '' },
      reviewReasons: ['explicit_username_password_table', 'verify_source_account_before_import'],
    }]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('extracts contiguous labeled rows, including trailing metadata', () => {
    const result = extractNoteCredentials([sheet('Email', [
      ['Username:', 'person@example.test'], ['Password:', 'Synthetic!23'], ['Login URL:', 'https://example.test'],
    ])], { emailProvider: 'google' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: { row: 1, usernameRow: 1, passwordRow: 2 }, fields: { name: 'Google Workspace', username: 'person@example.test', password: 'Synthetic!23', url: 'https://example.test' } });
  });

  it('accepts anchored inline label values, never free-form prose', () => {
    expect(extractNoteCredentials([sheet('Adobe', [['Username: demo'], ['Password: Synthetic!23']])])[0]?.fields)
      .toMatchObject({ username: 'demo', password: 'Synthetic!23' });
    expect(extractNoteCredentials([sheet('Adobe', [['Ask the user for Username: demo'], ['The old Password: Synthetic!23']])])).toEqual([]);
  });

  it('recognizes adjacent label-value pairs on the same row, not a header', () => {
    expect(extractNoteCredentials([sheet('Adobe', [['Username', 'demo', 'Password', 'Synthetic!23']])])[0]?.fields)
      .toMatchObject({ username: 'demo', password: 'Synthetic!23' });
  });

  it.each(['********', '••••••', '<redacted>', '[hidden]', 'N/A', 'unknown', ''])('skips masked/missing password %s', password => {
    expect(extractNoteCredentials([sheet('Accounts', [['Username', 'Password'], ['demo', password]])])).toEqual([]);
  });

  it.each(['API key', 'Backup encryption key', 'Software license key', 'MFA recovery codes', 'Webroot uninstall', 'Trend Micro MSP - Uninstall'])('leaves %s records in notes', name => {
    expect(extractNoteCredentials([sheet('Accounts', [['Service', 'Username', 'Password'], [name, 'demo', 'Synthetic!23']])])).toEqual([]);
    expect(extractNoteCredentials([sheet(name, [['Username: demo'], ['Password: Synthetic!23']])])).toEqual([]);
  });

  it('keeps an uninstall heading from becoming a credential block', () => {
    expect(extractNoteCredentials([sheet('Accounts', [['Webroot uninstall'], ['Username: demo'], ['Password: Synthetic!23']])])).toEqual([]);
  });

  it('does not combine usernames and passwords across empty rows or headings', () => {
    expect(extractNoteCredentials([sheet('Accounts', [['Username: demo'], [], ['Password: Synthetic!23']])])).toEqual([]);
    expect(extractNoteCredentials([sheet('Accounts', [['Username: demo'], ['Another account'], ['Password: Synthetic!23']])])).toEqual([]);
  });

  it('does not combine separate source sheets or missing row intervals', () => {
    expect(extractNoteCredentials([sheet('A', [['Username: demo']]), sheet('B', [['Password: Synthetic!23']])])).toEqual([]);
    const input = sheet('Accounts', [['Username: demo'], ['Password: Synthetic!23']]);
    input.rows[1]!.row = 10;
    expect(extractNoteCredentials([input])).toEqual([]);
  });

  it('does not supply missing usernames or infer passwords from arbitrary columns', () => {
    expect(extractNoteCredentials([sheet('Accounts', [['Name', 'Code'], ['demo', 'Synthetic!23']])])).toEqual([]);
    expect(extractNoteCredentials([sheet('Accounts', [['Password: Synthetic!23']])])).toEqual([]);
  });

  it('does not apply an email provider to application accounts', () => {
    expect(extractNoteCredentials([sheet('Adobe', [['Username: demo'], ['Password: Synthetic!23']])], { emailProvider: 'google' })[0]?.fields.name).toBe('Adobe');
  });

  it('keeps multiple vertical accounts separate when labels repeat', () => {
    const result = extractNoteCredentials([sheet('Accounts', [
      ['Username: first'], ['Password: First!23'], ['Username: second'], ['Password: Second!23'],
    ])]);
    expect(result.map(candidate => candidate.fields.username)).toEqual(['first', 'second']);
    expect(result.map(candidate => candidate.source.row)).toEqual([1, 3]);
  });

  it('does not treat a nonadjacent cell as a label value', () => {
    expect(extractNoteCredentials([{ name: 'Accounts', rows: [
      { row: 1, cells: [{ column: 'A', text: 'Username' }, { column: 'D', text: 'demo' }] },
      { row: 2, cells: [{ column: 'A', text: 'Password' }, { column: 'D', text: 'Synthetic!23' }] },
    ] }])).toEqual([]);
  });

  it.each(['Sheet1', 'OneNote', 'Corporate Office', 'Old Notes', 'USERS', 'Example Company'])('does not use %s as a proposed account name', name => {
    const result = extractNoteCredentials([sheet(name, [['Username', 'Password'], ['domain-user@example.test', 'Synthetic!23']])]);
    expect(result[0]).toMatchObject({
      fields: { name: 'Application / Cloud', category: '', email: '', username: 'domain-user@example.test' },
      reviewReasons: expect.arrayContaining(['account_type_and_service_need_review']),
    });
    expect(result[0]!.source.sheetName).toBe(name);
  });

  it('uses explicit nearby email-provider headings instead of the generic sheet name', () => {
    const result = extractNoteCredentials([sheet('OneNote', [
      ['Google Workspace'], [], ['Email', 'Password'], ['person@example.test', 'Synthetic!23'],
    ])]);
    expect(result[0]?.fields).toMatchObject({ name: 'Google Workspace', category: 'Email', email: 'person@example.test' });
  });

  it('distinguishes domain and email sections on one sheet', () => {
    const result = extractNoteCredentials([sheet('Corporate Office', [
      ['Domain Users'], ['Username', 'Password'], ['domain-user@example.test', 'Domain!23'],
      [], ['Microsoft 365'], ['Email', 'Password'], ['mail-user@example.test', 'Mail!23'],
    ])]);
    expect(result.map(candidate => [candidate.fields.name, candidate.fields.category, candidate.fields.email])).toEqual([
      ['Active Directory', 'Local / Domain', ''], ['Microsoft 365', 'Email', 'mail-user@example.test'],
    ]);
  });

  it('recognizes computer/domain table structure without treating a UPN as email', () => {
    const result = extractNoteCredentials([sheet('Sheet1', [
      ['Computer Name', 'Username', 'Password'], ['WORKSTATION-EXAMPLE', 'person@example.test', 'Synthetic!23'],
    ])], { emailProvider: 'google' });
    expect(result[0]?.fields).toMatchObject({ name: 'Local / Domain', category: 'Local / Domain', email: '' });
  });

  it('does not infer email just because the username column is labeled Email', () => {
    const result = extractNoteCredentials([sheet('USERS', [['Email', 'Password'], ['person@example.test', 'Synthetic!23']])], { emailProvider: 'google' });
    expect(result[0]?.fields).toMatchObject({ name: 'Application / Cloud', category: '', email: '' });
    expect(result[0]?.reviewReasons).toContain('account_type_and_service_need_review');
  });

  it('uses the provider override only for an explicit generic email section', () => {
    const result = extractNoteCredentials([sheet('Sheet1', [['Email accounts'], ['Username: person@example.test'], ['Password: Synthetic!23']])], { emailProvider: 'microsoft' });
    expect(result[0]?.fields).toMatchObject({ name: 'Microsoft 365', category: 'Email' });
  });

  it('does not apply the previous section after a new generic heading', () => {
    const result = extractNoteCredentials([sheet('Sheet1', [
      ['Google Workspace'], ['Other users'], ['Username', 'Password'], ['person@example.test', 'Synthetic!23'],
    ])]);
    expect(result[0]?.reviewReasons).toContain('account_type_and_service_need_review');
    expect(result[0]?.fields.category).toBe('');
  });

  it('keeps licensing-only Microsoft headings under applications', () => {
    const result = extractNoteCredentials([sheet('Sheet1', [
      ['Microsoft Office 365 License'], ['Username', 'Password'], ['person@example.test', 'Synthetic!23'],
    ])]);
    expect(result[0]?.fields).toMatchObject({ name: 'Microsoft 365 Apps', category: 'Application / Cloud', email: '' });
  });

  it('flags contradictory section and table types', () => {
    const result = extractNoteCredentials([sheet('Sheet1', [
      ['Google Workspace'], ['Computer', 'Username', 'Password'], ['WORKSTATION', 'person@example.test', 'Synthetic!23'],
    ])]);
    expect(result[0]?.reviewReasons).toContain('conflicting_account_context');
  });

  it.each(['Google Workspace', 'Microsoft 365'])('preserves explicit %s administration headings through normalization', provider => {
    const [candidate] = extractNoteCredentials([sheet('OneNote', [
      [`${provider} admin`], ['Username', 'Password'], ['person@example.test', 'Synthetic!23'],
    ])]);
    expect(normalizeCredential(candidate!.fields)).toMatchObject({ name: provider, isAdministration: true });
  });

  it('does not mark an ordinary provider section as administration', () => {
    const [candidate] = extractNoteCredentials([sheet('Google Workspace', [
      ['Username', 'Password'], ['person@example.test', 'Synthetic!23'],
    ])]);
    expect(normalizeCredential(candidate!.fields)).toMatchObject({ name: 'Google Workspace', isAdministration: false });
  });

  it('preserves administration from a sheet heading with an explicit ordinary service field', () => {
    const [candidate] = extractNoteCredentials([sheet('Google Workspace admin', [
      ['Service', 'Username', 'Password'], ['Google Workspace', 'person@example.test', 'Synthetic!23'],
    ])]);
    expect(normalizeCredential(candidate!.fields)).toMatchObject({ name: 'Google Workspace', isAdministration: true });
  });
});
