export const CREDENTIAL_ACCOUNT_TYPES = [
  'Email', 'Local / Domain', 'Application / Cloud', 'Network / Wi-Fi',
] as const;
export type CredentialAccountType = typeof CREDENTIAL_ACCOUNT_TYPES[number];
export type CredentialDisposition = 'credential' | 'note' | 'review';
export type CredentialNormalizationInput = {
  name: string;
  category: string;
  username: string;
  email: string;
  url: string;
  password: string;
  otpSecret: string;
  notes: string;
};
export type NormalizedCredential<T extends CredentialNormalizationInput = CredentialNormalizationInput> = T & {
  category: CredentialAccountType;
  isAdministration: boolean;
  disposition: CredentialDisposition;
  reasons: string[];
};

// Used for labels/classification only. Never run this over a saved password,
// username, OTP secret, URL or notes. This is not an HTML rendering sanitizer.
function plainLabel(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, entity => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    })[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ').trim();
}

function hostname(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch { return ''; }
}

type Service = { name: string; type: CredentialAccountType; pattern: RegExp };
const services: readonly Service[] = [
  { name: 'Microsoft 365', type: 'Email', pattern: /\b(?:microsoft\s*365|office\s*365|365\s+(?:admin|office|email|apps)|(?:email|admin)\s+365)\b|(?:^|[.\s])(?:onmicrosoft\.com|office\.com|office365\.com|admin\.microsoft\.com)(?:$|[\s/])/i },
  { name: 'Google Workspace', type: 'Email', pattern: /\b(?:google\s+(?:workspace|apps|admin)|g\s*suite)\b|\badmin\.google\.com\b/i },
  { name: 'Gmail', type: 'Email', pattern: /\bgmail\b|\bmail\.google\.com\b/i },
  { name: 'Rackspace', type: 'Email', pattern: /\brackspace\b/i },
  { name: 'Active Directory', type: 'Local / Domain', pattern: /\bactive directory\b|\bdomain\s+(?:admin(?:istrator|istration)?|user|account|login|credentials?)\b/i },
  { name: 'Windows', type: 'Local / Domain', pattern: /\bwindows\s+(?:local\s+)?(?:admin(?:istrator)?|account|login|credentials?|password)\b|\blocal\s+(?:admin(?:istrator)?|account|login|credentials?)\b/i },
  { name: 'SonicWall', type: 'Network / Wi-Fi', pattern: /\bsonicwall\b/i },
  { name: 'Fortinet', type: 'Network / Wi-Fi', pattern: /\bfortinet\b|\bfortigate\b/i },
  { name: 'UniFi', type: 'Network / Wi-Fi', pattern: /\bunifi\b|\bubiquit[yi]\b/i },
  { name: 'EnGenius', type: 'Network / Wi-Fi', pattern: /\bengenius\b/i },
  { name: 'Zyxel', type: 'Network / Wi-Fi', pattern: /\bzyxel\b/i },
  { name: 'Synology', type: 'Network / Wi-Fi', pattern: /\bsynology\b/i },
  { name: 'QNAP', type: 'Network / Wi-Fi', pattern: /\bqnap\b/i },
  { name: 'iDRAC', type: 'Network / Wi-Fi', pattern: /\bidrac\b/i },
  { name: '3CX', type: 'Application / Cloud', pattern: /\b3cx\b/i },
  { name: 'Dropbox', type: 'Application / Cloud', pattern: /\bdropbox\b/i },
  { name: 'Box', type: 'Application / Cloud', pattern: /\bbox\.com\b|\bbox\s+(?:account|login|admin)\b/i },
  { name: 'Adobe', type: 'Application / Cloud', pattern: /\badobe\b|\bacrobat\b/i },
  { name: 'Autodesk', type: 'Application / Cloud', pattern: /\bautodesk\b/i },
  { name: 'IDrive 360', type: 'Application / Cloud', pattern: /\bidrive\b/i },
  { name: 'Veeam', type: 'Application / Cloud', pattern: /\bveeam\b/i },
  { name: 'Cloudflare', type: 'Application / Cloud', pattern: /\bcloudflare\b/i },
  { name: 'GoDaddy', type: 'Application / Cloud', pattern: /\bgodaddy\b/i },
  { name: 'Microsoft Azure', type: 'Application / Cloud', pattern: /\bazure\b/i },
  { name: 'AWS', type: 'Application / Cloud', pattern: /\baws\b|\bamazon\s+(?:web services|lightsail)\b|\blightsail\b/i },
  { name: 'Check Point', type: 'Application / Cloud', pattern: /\bcheck\s*point\b/i },
  { name: 'SMTP2GO', type: 'Application / Cloud', pattern: /\bsmtp2go\b/i },
  ...([
    ['RingCentral', /\bringcentral\b/i],
    ['SoftActivity', /\bsoftactivity\b/i],
    ['Splashtop', /\bsplashtop\b/i],
    ['Atera', /\batera\b/i],
    ['BudgetVM', /\bbudgetvm\b/i],
    ['Esker', /\besker\b/i],
    ['Datto', /\bdatto\b/i],
    ['TP-Link Cloud', /\btp[- ]?link\b/i],
    ['Vultr', /\bvultr\b/i],
    ['RocketCyber', /\brocketcyber\b/i],
    ['Webroot', /\bwebroot\b/i],
    ['Autotask', /\bautotask\b/i],
    ['LinkedIn', /\blinkedin\b/i],
    ['Keeper', /\b(?:keepersecurity|thrive\s+keeper|keeper\s+(?:vault|password|admin))\b|^keeper(?:\s|$)/i],
    ['Cove', /\bcove\s+(?:backup|data\s+protection|solution)\b|\bn-able\.com\b/i],
    ['UniHosted', /\bunihosted\b/i],
    ['OpenAI', /\bopen\s?ai\b|\bchatgpt\b/i],
    ['Apple Business Manager', /\bapple\s+(?:business|ipad)\s+manager\b|\bbusiness\.apple\.com\b/i],
    ['DarkWebID', /\bdarkwebid\b/i],
    ['BullPhish', /\bbullphish\b/i],
    ['Kaseya', /\bkaseya\b/i],
    ['Backblaze', /\bbackblaze\b/i],
    ['Payoneer', /\bpayoneer\b/i],
    ['Flowroute', /\bflowroute\b/i],
    ['Neural Frames', /\bneural\s*frames\b/i],
    ['HPE', /\bhpe\b|\bhewlett\s+packard\s+enterprise\b/i],
    ['VoIP Supply', /\bvoip\s*supply\b/i],
    ['Hiya', /\bhiya\b/i],
    ['Tiger Technology', /\btiger\s*technology\b/i],
    ['MyIgea', /\bmyigea\b/i],
    ['AT&T', /\bat&t\b|\batt\.com\b|\batt\s+(?:main|smb|fiber|premier|business)\b/i],
    ['Register.com', /\bregister\.com\b/i],
    ['Comcast', /\bcomcast\b/i],
    ['SketchUp', /\bsketchup\b/i],
    ['PCLaw', /\bpclaw\b/i],
    ['TitanFile', /\btitanfile\b/i],
    ['Everlaw', /\beverlaw\b/i],
    ['HubSpot', /\bhubspot\b/i],
    ['Hostway', /\bhostway\b/i],
    ['ActivTrak', /\bactiv\s?trak\b/i],
    ['ADT Pulse', /\badt\s?pulse\b/i],
    ['Bluebeam', /\bbluebeam\b/i],
    ['PlanSwift', /\bplanswift\b/i],
    ['Procore', /\bprocore\b/i],
    ['Smartsheet', /\bsmartsheets?\b/i],
    ['DocuSign', /\bdocusign\b/i],
    ['T-Mobile', /\bt[- ]?mobile\b/i],
    ['GoTo', /\bgoto\b|\blogmein\b/i],
    ['Wix', /\bwix\b/i],
    ['Upwork', /\bupwork\b/i],
    ['888VoIP', /\b888voip\b/i],
    ['Bandwidth', /\bbandwidth\.com\b|^bandwidth(?:\s+(?:account|login|support|admin)|\s*$)/i],
    ['Bill.com', /\bbill\.com\b/i],
    ['Dell', /\bdell\b/i],
    ['Duo', /\bduo(?:security)?\b/i],
    ['Facebook', /\bfacebook\b/i],
    ['Fiverr', /\bfiverr\b/i],
    ['IT Glue', /\bit\s?glue\b/i],
    ['Lenovo', /\blenovo\b/i],
    ['Namecheap', /\bnamecheap\b/i],
    ['PAX8', /\bpax8\b/i],
    ['Twitter / X', /\btwitter\b|\bx\.com\b/i],
    ['MSP Camp', /\bmsp\s?camp\b/i],
    ['ClickUp', /\bclickup\b/i],
    ['VW Credit', /\bvw\s?credit\b/i],
    ['Zoom', /\bzoom\b/i],
    ['Flytec', /\bflytec\b/i],
    ['Parsec', /\bparsec\b/i],
    ['Tech Tribe', /\b(?:the\s+)?tech\s?tribe\b/i],
    ['FCC', /\bfcc(?:\.gov)?\b/i],
    ['USAC', /\busac(?:\.org)?\b/i],
    ['WordPress', /\bwordpress\b/i],
    ['GitHub', /\bgithub\b/i],
    ['Spiceworks', /\bspiceworks\b/i],
    ['Abacus AI', /\babacus\s?ai\b|\babacus\.ai\b/i],
    ['Intuit', /\bintuit\b|\bquickbooks\b/i],
    ['Graphus', /\bgraphus\b/i],
    ['Ironscales', /\bironscales\b/i],
    ['Wasabi', /\bwasabi\b/i],
  ] as const).map(([name, pattern]) => ({ name, pattern, type: 'Application / Cloud' as const })),
  // Generic network descriptions are the final fallback, so a vendor-specific
  // wireless-management label becomes "Zyxel", not its original prose title.
  { name: 'Wi-Fi', type: 'Network / Wi-Fi', pattern: /\bwi-?fi\b|\bwireless\b|\bssid\b/i },
];

function cleanName(value: string, input: CredentialNormalizationInput): string {
  let name = plainLabel(value);
  // Remove only exact account identifiers and conventional label boilerplate.
  // Client names cannot be identified safely without a supplied client context.
  for (const identifier of [input.username, input.email]) {
    if (identifier.trim().length >= 3) name = name.split(identifier).join(' ');
  }
  return name.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/\b(?:credentials?|passwords?|logins?|username|administration|administrator|admin|tenant|account|company|client)\b/gi, ' ')
    .replace(/^[\s:|,;–—-]+|[\s:|,;–—-]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** Deterministic proposal; a review disposition must not be silently published. */
export function normalizeCredential<T extends CredentialNormalizationInput>(input: T): NormalizedCredential<T> {
  const label = plainLabel(input.name);
  const priorCategory = plainLabel(input.category);
  const host = hostname(input.url);
  // Free-form notes remain untouched. Their contents can describe other accounts
  // and must not override the identity/type of this particular record.
  const context = `${label} ${priorCategory} ${host}`;
  const reasons: string[] = [];
  const isAdministration = /\b(?:admin(?:istrator|istration)?|tenant\s+(?:owner|management)|global\s+admin|root|superuser)\b/i.test(`${label} ${priorCategory}`)
    || /^(?:admin(?:istrator)?|kosadmin|osadmin|root)(?:@|$|\\)/i.test(input.username.trim())
    || /^(?:admin\.google\.com|admin\.microsoft\.com)$/.test(host);
  const keyLabel = /\b(?:api\s*(?:key|token|secret)|app(?:lication)?\s+(?:key|secret)|licen[cs]e\s*key|encryption\s*key|recovery\s*(?:key|codes?)|uninstall(?:\s*(?:password|key|code))?|access\s*token|client\s*secret)\b/i.test(label);
  // An explicit key/uninstall label takes precedence over a recognized service,
  // even when the legacy export happened to include an account name alongside it.
  const isStandaloneSecret = keyLabel;
  const service = services.find(candidate => candidate.pattern.test(context));
  const explicitType = CREDENTIAL_ACCOUNT_TYPES.find(type => type.toLowerCase() === priorCategory.toLowerCase());
  const appLicense = /\b(?:apps?\s+(?:licen[cs](?:e|ing)|microsoft\s+office)|office\s+licen[cs]e|(?:apps?[- ]only|licen[cs]ing[- ]only)|microsoft\s+office\s+licen[cs]e|(?:office|microsoft)\s*365\s+licen[cs](?:e|ing))\b/i.test(context);
  let category: CredentialAccountType = explicitType ?? service?.type ?? 'Application / Cloud';
  if (appLicense && service?.name === 'Microsoft 365') category = 'Application / Cloud';
  if (!explicitType && !service) {
    if (/\b(?:email|e-mail|mailbox|exchange)\b/i.test(context)) category = 'Email';
    else if (/\b(?:firewall|router|switch|vpn|access point|cctv|dvr|nvr|modem|nas)\b/i.test(context)) category = 'Network / Wi-Fi';
    else if (/\b(?:domain|local|windows)\b/i.test(priorCategory)) category = 'Local / Domain';
    else reasons.push('account_type_needs_review');
  }
  // Never collapse separate network SSIDs into an indistinguishable "Wi-Fi" name.
  const concise = cleanName(label, input);
  let name = service && service.name !== 'Wi-Fi' ? service.name : concise || host || category;
  if (service?.name === 'Microsoft 365' && appLicense) name = 'Microsoft 365 Apps';
  if (!label && !host) reasons.push('missing_account_label');
  if (!input.password && !input.otpSecret) reasons.push('missing_secret');
  if (isStandaloneSecret) reasons.push('standalone_secret_belongs_in_notes');
  const disposition: CredentialDisposition = isStandaloneSecret ? 'note' : reasons.length ? 'review' : 'credential';
  return { ...input, name, category, isAdministration, disposition, reasons };
}
