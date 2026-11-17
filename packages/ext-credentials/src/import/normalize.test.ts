import { describe, expect, it } from 'vitest';
import { normalizeCredential, type CredentialNormalizationInput } from './normalize';

const record = (overrides: Partial<CredentialNormalizationInput> = {}): CredentialNormalizationInput => ({
  name: '', category: '', username: 'person@example.test', email: '', url: '',
  password: ' synthetic password\n', otpSecret: ' SYNTHETIC OTP ', notes: '<b>Keep these notes verbatim.</b>', ...overrides,
});

describe('credential normalization proposals', () => {
  it('cleans a recognized service label without changing credential bytes', () => {
    const original = record({ name: '<b>Example client Microsoft 365 Administration</b> person@example.test Password' });
    const result = normalizeCredential(original);
    expect(result).toMatchObject({ name: 'Microsoft 365', category: 'Email', isAdministration: true, disposition: 'credential' });
    for (const field of ['username', 'email', 'url', 'password', 'otpSecret', 'notes'] as const) expect(result[field]).toBe(original[field]);
    expect(original.name).toContain('<b>');
  });

  it.each([
    ['Google Workspace Administration', 'Google Workspace', 'Email', true],
    ['Dr Example Domain Admin Password', 'Active Directory', 'Local / Domain', true],
    ['Local administrator login', 'Windows', 'Local / Domain', true],
    ['Adobe.com account login', 'Adobe', 'Application / Cloud', false],
    ['Sonicwall firewall admin', 'SonicWall', 'Network / Wi-Fi', true],
    ['Microsoft Office 365 License', 'Microsoft 365 Apps', 'Application / Cloud', false],
    ['office1 365 apps microsoft office', 'Microsoft 365 Apps', 'Application / Cloud', false],
  ])('classifies %s', (name, expectedName, category, admin) => {
    expect(normalizeCredential(record({ name }))).toMatchObject({ name: expectedName, category, isAdministration: admin, disposition: 'credential' });
  });

  it('does not treat another account mentioned in notes as this account provider', () => {
    expect(normalizeCredential(record({ name: 'Google Workspace', notes: 'Microsoft 365 administration is documented elsewhere.' })))
      .toMatchObject({ name: 'Google Workspace', category: 'Email', isAdministration: false });
  });

  it.each(['API key', 'Application secret', 'Windows license key', 'Backup encryption key', 'MFA recovery codes', 'Antivirus uninstall password'])('routes standalone %s to notes without losing the record', name => {
    const original = record({ name, username: '', email: '' });
    expect(normalizeCredential(original)).toMatchObject({ disposition: 'note', password: original.password, notes: original.notes, reasons: expect.arrayContaining(['standalone_secret_belongs_in_notes']) });
  });

  it('routes an explicit API key to notes even with an accompanying username', () => {
    expect(normalizeCredential(record({ name: 'Widget API key' }))).toMatchObject({ disposition: 'note', reasons: expect.arrayContaining(['standalone_secret_belongs_in_notes']) });
  });

  it('keeps password-only Wi-Fi credentials and preserves the SSID in their name', () => {
    expect(normalizeCredential(record({ name: 'WIFI SSID - EXAMPLE_GUEST', username: '', otpSecret: '' })))
      .toMatchObject({ name: 'WIFI SSID - EXAMPLE_GUEST', category: 'Network / Wi-Fi', disposition: 'credential' });
  });

  it('does not infer an email provider from the username domain', () => {
    expect(normalizeCredential(record({ name: 'Email account', username: 'someone@gmail.com' })))
      .toMatchObject({ name: 'Email', category: 'Email', disposition: 'credential' });
  });

  it('retains an explicit four-type category for an unknown service', () => {
    expect(normalizeCredential(record({ name: 'Widget login', category: 'Application / Cloud' })))
      .toMatchObject({ name: 'Widget', category: 'Application / Cloud', disposition: 'credential' });
  });

  it('uses a safe host fallback and flags an ambiguous account type', () => {
    const original = record({ name: 'account password', url: 'https://portal.example.test/login' });
    expect(normalizeCredential(original)).toMatchObject({ name: 'portal.example.test', url: original.url, category: 'Application / Cloud', disposition: 'review', reasons: ['account_type_needs_review'] });
  });

  it('does not interpret unsafe URL schemes or invented labels as verified accounts', () => {
    expect(normalizeCredential(record({ name: '', url: 'javascript:alert(1)', password: '', otpSecret: '' })))
      .toMatchObject({ name: 'Application / Cloud', disposition: 'review', reasons: expect.arrayContaining(['missing_account_label', 'missing_secret']) });
  });

  it.each([
    ['RingCentral', 'RingCentral'], ['SoftActivity', 'SoftActivity'], ['Splashtop', 'Splashtop'],
    ['atera.com', 'Atera'], ['budgetvm.com', 'BudgetVM'], ['esker.com', 'Esker'], ['Datto RMM', 'Datto'],
    ['TP Link Cloud', 'TP-Link Cloud'], ['Vultr Cloud Hosting', 'Vultr'], ['Managed SOC RocketCyber', 'RocketCyber'],
    ['Webroot', 'Webroot'], ['Autotask PSA', 'Autotask'], ['Linkedin Learning', 'LinkedIn'],
    ['Thrive Keeper', 'Keeper'], ['Cove Backup Solution', 'Cove'], ['unihosted', 'UniHosted'],
    ['open ai chatgpt team', 'OpenAI'], ['Apple iPad Manager', 'Apple Business Manager'],
    ['darkwebid kaseya', 'DarkWebID'], ['BullPhish', 'BullPhish'], ['Kaseya One', 'Kaseya'],
    ['backblaze b2', 'Backblaze'], ['payoneer', 'Payoneer'], ['Flowroute SIP Trunk', 'Flowroute'],
    ['neural frames', 'Neural Frames'], ['HPE Downloads', 'HPE'], ['voip supply', 'VoIP Supply'],
    ['hiya', 'Hiya'], ['tiger technology', 'Tiger Technology'], ['MyIgea', 'MyIgea'], ['att.com', 'AT&T'],
    ['register.com', 'Register.com'], ['Comcast support', 'Comcast'], ['Trimble Sketchup', 'SketchUp'],
    ['PCLAW Community', 'PCLaw'], ['TitanFile share', 'TitanFile'], ['Everlaw', 'Everlaw'],
    ['Hubspot', 'HubSpot'], ['Hostway', 'Hostway'], ['activ trak', 'ActivTrak'], ['adtpulse.com', 'ADT Pulse'],
    ['Bluebeam', 'Bluebeam'], ['Planswift Estimating Software', 'PlanSwift'], ['Procore Project Management', 'Procore'],
    ['SmartSheets', 'Smartsheet'], ['Docusign', 'DocuSign'], ['tmobile ipad', 'T-Mobile'],
    ['goto logmein', 'GoTo'], ['Wix', 'Wix'], ['Upwork', 'Upwork'], ['888voip.com', '888VoIP'],
    ['bandwidth.com support', 'Bandwidth'], ['bill.com', 'Bill.com'], ['dell.com', 'Dell'],
    ['duosecurity.com', 'Duo'], ['facebook.com', 'Facebook'], ['fiverr.com', 'Fiverr'], ['ITGlue', 'IT Glue'],
    ['Lenovo Pro', 'Lenovo'], ['Namecheap SSL', 'Namecheap'], ['PAX8', 'PAX8'], ['Twitter / X', 'Twitter / X'],
    ['MSP Camp', 'MSP Camp'], ['Clickup Marketing Tech', 'ClickUp'], ['vwcredit', 'VW Credit'],
    ['zoom', 'Zoom'], ['flytec distributor', 'Flytec'], ['parsec', 'Parsec'], ['techtribe', 'Tech Tribe'],
    ['fcc', 'FCC'], ['usac', 'USAC'], ['wordpress example.test', 'WordPress'], ['github', 'GitHub'],
    ['spiceworks', 'Spiceworks'], ['abacus ai chatllm', 'Abacus AI'], ['Intuit.com', 'Intuit'],
  ])('reduces %s to its concise service label', (label, name) => {
    expect(normalizeCredential(record({ name: `${label} administration account person@example.test` })))
      .toMatchObject({ name, category: 'Application / Cloud', isAdministration: true, disposition: 'credential' });
  });

  it('prefers a vendor-specific wireless name over generic wireless prose', () => {
    expect(normalizeCredential(record({ name: 'Zyxel Nebula wireless manager' })))
      .toMatchObject({ name: 'Zyxel', category: 'Network / Wi-Fi', disposition: 'credential' });
  });

  it.each(['Widget X account', 'Register portal', 'cloud bandwidth account', 'monkey credentials', 'Bill payment portal'])('does not overmatch generic words in %s', name => {
    expect(normalizeCredential(record({ name })))
      .toMatchObject({ category: 'Application / Cloud', disposition: 'review', reasons: ['account_type_needs_review'] });
  });

  it.each(['Webroot uninstall', 'Trend Micro MSP - Uninstall', 'Cloudflare API token', 'Backblaze application key', 'Adobe license key'])('keeps %s in Notes regardless of service recognition', name => {
    expect(normalizeCredential(record({ name }))).toMatchObject({ disposition: 'note', reasons: expect.arrayContaining(['standalone_secret_belongs_in_notes']) });
  });
});
