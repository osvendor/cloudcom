import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ExtensionRuntimeContext } from '@breeze/extension-sdk';
import { seal, unseal } from './secrets';
import { generateCredentialPassword } from './passwordGenerator';

export const credentialCategories = ['Email', 'Local / Domain', 'Application / Cloud', 'Network / Wi-Fi'] as const;
const text = z.string().trim().max(320);
export const createCredentialSchema = z.object({ requestId: z.string().uuid(), category: z.enum(credentialCategories), isAdministration: z.boolean() }).strict();
export const updateCredentialSchema = z.object({ version: z.number().int().positive(), fields: z.object({
  name: text.optional(), category: z.enum(credentialCategories).optional(), isAdministration: z.boolean().optional(),
  username: text.optional(), url: z.string().trim().max(2048).refine(v => { if (!v) return true; try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }).optional(),
  password: z.string().max(4096).optional(), otpSecret: z.string().trim().max(256).refine(v => !v || /^[A-Z2-7]+=*$/i.test(v)).optional(),
  generatePassword: z.literal(true).optional(), isDraft: z.boolean().optional(),
}).strict().refine(v => !(v.generatePassword && v.password !== undefined)) }).strict();
export const credentialMetadata = sql`id,name,category,username,email,url,has_password AS "hasPassword",has_otp AS "hasOtp",is_administration AS "isAdministration",is_draft AS "isDraft",temporary_password AS "temporaryPassword",creation_state AS "creationState",version`;
type RecordRow = { id: string; name: string; category: string; username: string; email: string; url: string; isAdministration: boolean; isDraft: boolean; version: number; creationState?: string; secret_ciphertext: string };
const rows = <T>(v: unknown): T[] => { if (!Array.isArray(v)) throw Error('Invalid credential result'); return v; };
export class CredentialDraftError extends Error { constructor(public readonly status: 404 | 409 | 422, message: string) { super(message); } }
export type CredentialEmailDefaults = { provider: 'microsoft' | 'google' | null; domain: string | null };
const consumerDomains = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','aol.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','mail.com','gmx.com','gmx.net']);
const generatedEmailUrls = new Set(['https://admin.microsoft.com','https://login.microsoftonline.com','https://admin.google.com','https://accounts.google.com']);
const providerUrl = (name: string, administration: boolean) => name === 'Microsoft 365' ? (administration ? 'https://admin.microsoft.com' : 'https://login.microsoftonline.com') : name === 'Google Workspace' ? (administration ? 'https://admin.google.com' : 'https://accounts.google.com') : '';
export async function resolveCredentialEmailDefaults(context: ExtensionRuntimeContext, orgId: string): Promise<CredentialEmailDefaults> {
  const records = rows<{ name: string; username: string; email: string }>(await context.db.execute(sql`SELECT DISTINCT name,username,email FROM credentials_records WHERE org_id=${orgId}::uuid AND archived=false AND is_draft=false AND category='Email' AND name IN ('Microsoft 365','Google Workspace')`));
  const providers = new Set(records.map(record => record.name));
  if (providers.size !== 1) return { provider: null, domain: null };
  const provider = providers.has('Microsoft 365') ? 'microsoft' : providers.has('Google Workspace') ? 'google' : null;
  if (!provider) return { provider: null, domain: null };
  const domains = new Set<string>();
  for (const record of records) for (const address of [record.username, record.email]) {
    const match = /^[^\s@]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/i.exec(address?.trim() ?? '');
    const domain = match?.[1]?.toLowerCase();
    if (domain && !domain.includes('..') && !consumerDomains.has(domain)) domains.add(domain);
  }
  return { provider, domain: domains.size === 1 ? [...domains][0]! : null };
}
export async function createCredentialDraft(context: ExtensionRuntimeContext, orgId: string, actorId: string, input: z.infer<typeof createCredentialSchema>) {
  const source = `companion:${actorId}`, id = randomUUID(), password = generateCredentialPassword();
  const emailDefaults = input.category === 'Email' ? await resolveCredentialEmailDefaults(context, orgId) : { provider: null, domain: null };
  const name = emailDefaults.provider === 'microsoft' ? 'Microsoft 365' : emailDefaults.provider === 'google' ? 'Google Workspace' : input.category;
  const url = providerUrl(name, input.isAdministration);
  const ciphertext = seal(context.secrets, orgId, id, { password, otpSecret: '', notes: '' });
  const inserted = rows<RecordRow>(await context.db.execute(sql`INSERT INTO credentials_records (id,org_id,name,category,url,secret_ciphertext,has_password,is_administration,is_draft,source_organization,source_id)
    VALUES (${id}::uuid,${orgId}::uuid,${name},${input.category},${url},${ciphertext},true,${input.isAdministration},true,${source},${input.requestId})
    ON CONFLICT (org_id,source_organization,source_id) DO NOTHING RETURNING ${credentialMetadata}`));
  if (inserted[0]) return { credential: inserted[0], value: password, emailDefaults };
  const prior = rows<RecordRow>(await context.db.execute(sql`SELECT ${credentialMetadata},secret_ciphertext FROM credentials_records WHERE org_id=${orgId}::uuid AND source_organization=${source} AND source_id=${input.requestId} AND archived=false`))[0];
  if (!prior) throw new CredentialDraftError(409, 'Draft unavailable. Refresh credentials.');
  const { secret_ciphertext, ...credential } = prior;
  return { credential, value: unseal(context.secrets, orgId, prior.id, secret_ciphertext).password, emailDefaults };
}
export async function updateCredentialDraft(context: ExtensionRuntimeContext, orgId: string, id: string, input: z.infer<typeof updateCredentialSchema>) {
  const prior = rows<RecordRow>(await context.db.execute(sql`SELECT ${credentialMetadata},secret_ciphertext FROM credentials_records WHERE org_id=${orgId}::uuid AND id=${id}::uuid AND archived=false`))[0];
  if (!prior) throw new CredentialDraftError(404, 'Credential unavailable');
  if (prior.creationState && !['none','accepted'].includes(prior.creationState)) throw new CredentialDraftError(409, 'Reconcile the Microsoft account creation before editing its saved credential.');
  if (prior.version !== input.version) throw new CredentialDraftError(409, 'Credential changed. Refresh before editing.');
  const f = input.fields, secret = unseal(context.secrets, orgId, id, prior.secret_ciphertext);
  const password = f.generatePassword ? generateCredentialPassword() : f.password ?? secret.password;
  const otpSecret = f.otpSecret ?? secret.otpSecret, category = f.category ?? prior.category;
  const defaultName = credentialCategories.includes(prior.name as typeof credentialCategories[number]) || (prior.isDraft && prior.category === 'Email' && ['Microsoft 365','Google Workspace'].includes(prior.name));
  const username = f.username ?? prior.username;
  let name = (f.name ?? (f.category && f.category !== prior.category && defaultName ? category : prior.name)) || category, url = f.url ?? prior.url;
  const isAdministration = f.isAdministration ?? prior.isAdministration, isDraft = f.isDraft ?? prior.isDraft;
  if (prior.isDraft && category !== prior.category) {
    if (prior.category === 'Email' && category !== 'Email' && f.url === undefined && generatedEmailUrls.has(prior.url)) url = '';
    if (category === 'Email' && defaultName && f.name === undefined) {
      const defaults = await resolveCredentialEmailDefaults(context, orgId);
      name = defaults.provider === 'microsoft' ? 'Microsoft 365' : defaults.provider === 'google' ? 'Google Workspace' : category;
      if (f.url === undefined && (!prior.url || generatedEmailUrls.has(prior.url))) url = providerUrl(name, isAdministration);
    }
  }
  if (!isDraft && (!name || (!username && category !== 'Network / Wi-Fi') || !password || !credentialCategories.includes(category as typeof credentialCategories[number]) || (isAdministration && !url && ['Email', 'Application / Cloud'].includes(category))))
    throw new CredentialDraftError(422, 'Complete the username, password and applicable login URL first.');
  const ciphertext = seal(context.secrets, orgId, id, { password, otpSecret, notes: secret.notes });
  const updated = rows<RecordRow>(await context.db.execute(sql`UPDATE credentials_records SET name=${name},category=${category},username=${username},email=${username.includes('@') ? username : ''},url=${url},secret_ciphertext=${ciphertext},has_password=${Boolean(password)},has_otp=${Boolean(otpSecret)},is_administration=${isAdministration},is_draft=${isDraft},version=version+1,updated_at=now() WHERE org_id=${orgId}::uuid AND id=${id}::uuid AND version=${input.version} AND archived=false RETURNING ${credentialMetadata}`))[0];
  if (!updated) throw new CredentialDraftError(409, 'Credential changed. Refresh before editing.');
  return { credential: updated, ...(f.generatePassword ? { value: password } : {}) };
}
