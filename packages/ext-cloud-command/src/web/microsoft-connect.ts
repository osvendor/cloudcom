import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { CloudCommandHostApi } from './index';

type Onboarding = {
  state: 'not_connected' | 'needs_attention' | 'ready' | 'configuring'; canManage: boolean; canStart: boolean;
  tenantName?: string; tenantId?: string; version?: number | null; reason?: string;
  capabilities: Array<{ id: string; label: string; status: 'ready' | 'pending' | 'unavailable'; message?: string }>;
};
type Callback = { state: string; code?: string; tenant?: string; adminConsent?: boolean; error?: string };
const STATE_PREFIX = 'cloudcommand.microsoft.onboarding.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const labels: Record<Onboarding['state'], string> = { not_connected: 'Not connected', needs_attention: 'Setup needs attention', ready: 'Ready', configuring: 'Setup in progress' };
const authorizationUrl = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Microsoft authorization is not available.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.username || url.password || url.port || !url.searchParams.get('state')) throw new Error('Microsoft authorization is not available.');
  return url.href;
};

export class CloudCommandMicrosoftConnect extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' }); private contextValue: ExtensionPageContextV1 | null = null; private api: CloudCommandHostApi | null = null;
  private generation = 0; private data: Onboarding | null = null; private busy = false; private message = ''; private failed = false;
  private authorizationUrl: string | null = null; private tenantId = ''; private callback: Callback | null = null; private callbackStarted = false;
  set context(input: unknown) {
    const next = parseExtensionPageContextV1(input); if (next.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    if (next.organizationId !== this.contextValue?.organizationId) { this.generation++; this.api = null; this.data = null; this.authorizationUrl = null; this.message = ''; this.busy = false; this.callbackStarted = false; }
    this.contextValue = next; this.render();
  }
  set hostApi(api: CloudCommandHostApi) { if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required'); this.api = api; if (this.isConnected) void this.load(); }
  connectedCallback() { this.captureCallback(); this.render(); if (this.api) void this.load(); }
  disconnectedCallback() { this.generation++; this.authorizationUrl = null; }
  private captureCallback() {
    const params = new URLSearchParams(window.location.search); const state = params.get('state');
    if (!state || (!params.has('code') && !params.has('admin_consent') && !params.has('error'))) return;
    this.callback = { state, ...(params.has('code') ? { code: params.get('code') || undefined } : {}), ...(params.has('tenant') ? { tenant: params.get('tenant') || undefined } : {}), ...(params.has('admin_consent') ? { adminConsent: ['true', 'True'].includes(params.get('admin_consent') || '') } : {}), ...(params.has('error') ? { error: params.get('error') || undefined } : {}) };
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
  }
  private stateKey(state: string) { return `${STATE_PREFIX}${state}`; }
  private rememberAuthorization(url: string) { try { window.sessionStorage.setItem(this.stateKey(new URL(url).searchParams.get('state')!), this.contextValue!.organizationId); } catch { throw new Error('Microsoft authorization cannot be continued in this browser.'); } }
  private validStatus(body: unknown): body is Onboarding {
    const value = body as Onboarding;
    return !!value && Object.hasOwn(labels, value.state) && typeof value.canManage === 'boolean' && typeof value.canStart === 'boolean' && Array.isArray(value.capabilities) && (value.tenantName === undefined || typeof value.tenantName === 'string') && (value.tenantId === undefined || typeof value.tenantId === 'string') && (value.version === undefined || value.version === null || (typeof value.version === 'number' && Number.isFinite(value.version))) && (value.reason === undefined || typeof value.reason === 'string') && value.capabilities.every(item => !!item && typeof item.id === 'string' && typeof item.label === 'string' && ['ready', 'pending', 'unavailable'].includes(item.status) && (item.message === undefined || typeof item.message === 'string'));
  }
  private async load(action: 'status' | 'recheck' = 'status') {
    if (!this.api || !this.contextValue || this.busy || (action === 'recheck' && !this.data?.canManage)) return;
    const generation = this.generation; this.busy = true; this.message = ''; this.failed = false; this.authorizationUrl = null; this.render();
    try {
      const response = await this.api.request(`/microsoft/onboarding${action === 'status' ? '' : '/recheck'}`, action === 'status' ? undefined : { method: 'POST' });
      if (!response.ok) throw new Error('Microsoft 365 setup could not be checked. Please try again.');
      const body = await response.json(); if (generation !== this.generation || !this.isConnected) return;
      if (!this.validStatus(body)) throw new Error('Microsoft 365 setup returned an invalid status.'); this.data = body; if (!this.tenantId && body.tenantId) this.tenantId = body.tenantId;
      if (action === 'recheck') this.message = 'Setup checked. Review the capability status below.';
    } catch (error) { if (generation !== this.generation || !this.isConnected) return; this.failed = true; this.message = error instanceof Error ? error.message : 'Unable to check Microsoft 365 setup.'; }
    finally { if (generation === this.generation && this.isConnected) { this.busy = false; this.render(); } }
    if (generation === this.generation && this.isConnected) void this.completeCallback();
  }
  private async start() {
    if (!this.api || !this.contextValue || this.busy || !this.data?.canManage || !this.data.canStart) return;
    if (!uuid.test(this.tenantId)) { this.failed = true; this.message = 'Enter a valid Microsoft tenant ID.'; this.render(); return; }
    const generation = this.generation; this.busy = true; this.failed = false; this.message = ''; this.authorizationUrl = null; this.render();
    try {
      const response = await this.api.request('/microsoft/onboarding/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: this.tenantId, version: this.data.version ?? null }) });
      if (!response.ok) throw new Error('Microsoft authorization could not be started. Please try again.'); const url = authorizationUrl((await response.json()).authorizationUrl);
      if (generation !== this.generation || !this.isConnected) return; this.rememberAuthorization(url); this.authorizationUrl = url; this.message = 'Continue to Microsoft to review and approve access.';
    } catch (error) { if (generation !== this.generation || !this.isConnected) return; this.failed = true; this.message = error instanceof Error ? error.message : 'Microsoft authorization could not be started.'; }
    finally { if (generation === this.generation && this.isConnected) { this.busy = false; this.render(); } }
  }
  private async completeCallback() {
    if (!this.callback || this.callbackStarted || !this.api || !this.contextValue || !this.isConnected || this.busy) return;
    const callback = this.callback; let origin: string | null = null; try { origin = window.sessionStorage.getItem(this.stateKey(callback.state)); } catch { /* unavailable */ }
    if (origin !== this.contextValue.organizationId) { this.callbackStarted = true; this.failed = true; this.message = 'Select the organization where this Microsoft connection was started, then continue setup.'; this.render(); return; }
    this.callbackStarted = true; const generation = this.generation; let completed = false; this.busy = true; this.failed = false; this.message = 'Completing Microsoft setup…'; this.render();
    try {
      const response = await this.api.request('/microsoft/onboarding/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callback) });
      if (!response.ok) throw new Error('Microsoft setup could not be completed. Please start again.'); const body = await response.json(); if (generation !== this.generation || !this.isConnected) return;
      if (body.success === true) { this.callback = null; completed = true; this.message = 'Microsoft 365 setup completed.'; }
      else { const url = authorizationUrl(body.authorizationUrl); this.rememberAuthorization(url); this.authorizationUrl = url; this.callback = null; this.message = 'Continue to Microsoft to finish setup.'; }
    } catch (error) { if (generation !== this.generation || !this.isConnected) return; this.failed = true; this.message = error instanceof Error ? error.message : 'Microsoft setup could not be completed.'; }
    finally { try { window.sessionStorage.removeItem(this.stateKey(callback.state)); } catch { /* callback data is never stored */ } if (generation === this.generation && this.isConnected) { this.busy = false; this.render(); if (completed) void this.load(); } }
  }
  private render() {
    const data = this.data;
    this.root.innerHTML = `<style>${styles}</style><section aria-labelledby="microsoft-heading" aria-busy="${this.busy}"><h2 id="microsoft-heading">Microsoft 365</h2><p class="muted">One connection for this organization's Microsoft 365 services. Consent, setup and capability checks are managed here.</p>${data ? `<div class="summary"><strong>${labels[data.state]}</strong>${data.tenantName ? `<span>${escape(data.tenantName)}</span>` : ''}</div>${data.reason ? `<p>${escape(data.reason)}</p>` : ''}<ul>${data.capabilities.map(capability => `<li><div><strong>${escape(capability.label)}</strong><span class="status">${escape(capability.status === 'ready' ? 'Ready' : capability.status === 'pending' ? 'Pending' : 'Unavailable')}</span></div>${capability.message ? `<p class="muted">${escape(capability.message)}</p>` : ''}</li>`).join('')}</ul>${data.canManage ? `<div class="actions">${data.canStart ? `<label class="tenant">Microsoft tenant ID<input id="tenant-id" value="${escape(this.tenantId)}" autocomplete="off" ${this.busy ? 'disabled' : ''}></label><button id="start" type="button" ${this.busy ? 'disabled' : ''}>Connect Microsoft 365</button>` : ''}<button id="recheck" class="secondary" type="button" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Checking…' : 'Check setup'}</button></div>` : '<p class="muted">An organization administrator manages this connection.</p>'}` : `<p>${this.busy ? 'Checking Microsoft 365 setup…' : 'Microsoft 365 setup status is unavailable.'}</p>${!this.busy ? '<button id="retry" class="secondary" type="button">Retry</button>' : ''}`}<p role="${this.failed ? 'alert' : 'status'}" class="feedback ${this.failed ? 'error' : ''}">${escape(this.message)}</p>${this.authorizationUrl ? `<a href="${escape(this.authorizationUrl)}" rel="noopener">Continue to Microsoft</a>` : ''}</section>`;
    this.root.querySelector<HTMLInputElement>('#tenant-id')?.addEventListener('input', event => { this.tenantId = (event.currentTarget as HTMLInputElement).value; });
    this.root.querySelector('#recheck')?.addEventListener('click', () => void this.load('recheck')); this.root.querySelector('#start')?.addEventListener('click', () => void this.start()); this.root.querySelector('#retry')?.addEventListener('click', () => void this.load());
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}section{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1.25rem}h2{margin:0;font-size:1.125rem}p{font-size:.875rem;line-height:1.5}.muted{color:hsl(var(--muted-foreground))}.summary{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}.summary span{color:hsl(var(--muted-foreground))}ul{list-style:none;padding:0;margin:1rem 0}li{padding:.8rem 0;border-top:1px solid hsl(var(--border))}li>div{display:flex;justify-content:space-between;gap:1rem;font-size:.875rem}li p{margin:.3rem 0 0}.status{color:hsl(var(--muted-foreground));font-size:.8rem}.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:end}.tenant{display:grid;gap:.25rem;font-size:.8rem}.tenant input{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--background));color:hsl(var(--foreground));font:inherit;padding:.5rem .6rem;width:min(100%,23rem)}button{font:inherit;font-size:.875rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:.5rem .8rem;cursor:pointer;background:hsl(var(--primary));color:hsl(var(--primary-foreground))}.secondary{background:hsl(var(--background));color:hsl(var(--foreground))}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}a{color:hsl(var(--primary))}.feedback:empty{display:none}.error{color:hsl(var(--destructive))}`;
if (!customElements.get('cloudcommand-microsoft-connect')) customElements.define('cloudcommand-microsoft-connect', CloudCommandMicrosoftConnect);
