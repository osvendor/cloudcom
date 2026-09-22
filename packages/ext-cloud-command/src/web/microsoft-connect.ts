import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { CloudCommandHostApi } from './index';

type Onboarding = {
  state: 'not_connected' | 'needs_attention' | 'ready' | 'configuring';
  canManage: boolean;
  canStart: boolean;
  tenantName?: string;
  reason?: string;
  capabilities: Array<{ id: string; label: string; status: 'ready' | 'pending' | 'unavailable'; message?: string }>;
};
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const labels: Record<Onboarding['state'], string> = { not_connected: 'Not connected', needs_attention: 'Setup needs attention', ready: 'Ready', configuring: 'Setup in progress' };

export class CloudCommandMicrosoftConnect extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private generation = 0;
  private data: Onboarding | null = null;
  private busy = false;
  private message = '';
  private failed = false;
  private authorizationUrl: string | null = null;

  set context(input: unknown) {
    const next = parseExtensionPageContextV1(input);
    if (next.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    if (next.organizationId !== this.contextValue?.organizationId) {
      this.generation++;
      this.api = null;
      this.data = null;
      this.authorizationUrl = null;
      this.message = '';
      this.busy = false;
    }
    this.contextValue = next;
    this.render();
  }
  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    if (this.isConnected) void this.load();
  }
  connectedCallback() { this.render(); if (this.api) void this.load(); }
  disconnectedCallback() { this.generation++; this.authorizationUrl = null; }

  private async load(action: 'status' | 'recheck' | 'start' = 'status') {
    if (!this.api || !this.contextValue || this.busy) return;
    if (action !== 'status' && (!this.data?.canManage || (action === 'start' && !this.data.canStart))) return;
    const generation = this.generation;
    this.busy = true;
    this.message = '';
    this.failed = false;
    this.authorizationUrl = null;
    this.render();
    try {
      const response = await this.api.request(`/microsoft/onboarding${action === 'status' ? '' : `/${action}`}`, action === 'status' ? undefined : { method: 'POST' });
      if (!response.ok) throw new Error('Microsoft 365 setup could not be checked. Please try again.');
      const body = await response.json();
      if (generation !== this.generation || !this.isConnected) return;
      if (body.success === false) throw new Error('Microsoft 365 setup could not be completed.');
      if (action === 'start') {
        const url = new URL(body.authorizationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.username || url.password || url.port) throw new Error('Microsoft authorization is not available.');
        this.authorizationUrl = url.href;
        this.message = 'Continue to Microsoft to review and approve access. Then return here and check setup.';
      } else {
        if (!body || !Object.hasOwn(labels, body.state) || typeof body.canManage !== 'boolean' || typeof body.canStart !== 'boolean' || !Array.isArray(body.capabilities)
          || (body.tenantName !== undefined && typeof body.tenantName !== 'string') || (body.reason !== undefined && typeof body.reason !== 'string')
          || body.capabilities.some((item: Onboarding['capabilities'][number]) => !item || typeof item.id !== 'string' || typeof item.label !== 'string'
            || !['ready', 'pending', 'unavailable'].includes(item.status) || (item.message !== undefined && typeof item.message !== 'string')))
          throw new Error('Microsoft 365 setup returned an invalid status.');
        this.data = body as Onboarding;
        if (action === 'recheck') this.message = 'Setup checked. Review the capability status below.';
      }
    } catch (error) {
      if (generation !== this.generation || !this.isConnected) return;
      this.failed = true;
      this.message = error instanceof Error ? error.message : 'Unable to check Microsoft 365 setup.';
    } finally {
      if (generation === this.generation && this.isConnected) { this.busy = false; this.render(); }
    }
  }

  private render() {
    const data = this.data;
    this.root.innerHTML = `<style>${styles}</style><section aria-labelledby="microsoft-heading" aria-busy="${this.busy}"><h2 id="microsoft-heading">Microsoft 365</h2><p class="muted">One connection for this organization's Microsoft 365 services. Consent, setup and capability checks are managed here.</p>${data ? `<div class="summary"><strong>${labels[data.state]}</strong>${data.tenantName ? `<span>${escape(data.tenantName)}</span>` : ''}</div>${data.reason ? `<p>${escape(data.reason)}</p>` : ''}<ul>${data.capabilities.map(capability => `<li><div><strong>${escape(capability.label)}</strong><span class="status">${escape(capability.status === 'ready' ? 'Ready' : capability.status === 'pending' ? 'Pending' : 'Unavailable')}</span></div>${capability.message ? `<p class="muted">${escape(capability.message)}</p>` : ''}</li>`).join('')}</ul>${data.canManage ? `<div class="actions">${data.canStart ? `<button id="start" type="button" ${this.busy ? 'disabled' : ''}>Connect Microsoft 365</button>` : ''}<button id="recheck" class="secondary" type="button" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Checking…' : 'Check setup'}</button></div>` : '<p class="muted">An organization administrator manages this connection.</p>'}` : `<p>${this.busy ? 'Checking Microsoft 365 setup…' : 'Microsoft 365 setup status is unavailable.'}</p>${!this.busy ? '<button id="retry" class="secondary" type="button">Retry</button>' : ''}`}<p role="${this.failed ? 'alert' : 'status'}" class="feedback ${this.failed ? 'error' : ''}">${escape(this.message)}</p>${this.authorizationUrl ? `<a href="${escape(this.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Continue to Microsoft</a>` : ''}</section>`;
    this.root.querySelector('#recheck')?.addEventListener('click', () => void this.load('recheck'));
    this.root.querySelector('#start')?.addEventListener('click', () => void this.load('start'));
    this.root.querySelector('#retry')?.addEventListener('click', () => void this.load());
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}section{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1.25rem}h2{margin:0;font-size:1.125rem}p{font-size:.875rem;line-height:1.5}.muted{color:hsl(var(--muted-foreground))}.summary{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}.summary span{color:hsl(var(--muted-foreground))}ul{list-style:none;padding:0;margin:1rem 0}li{padding:.8rem 0;border-top:1px solid hsl(var(--border))}li>div{display:flex;justify-content:space-between;gap:1rem;font-size:.875rem}li p{margin:.3rem 0 0}.status{color:hsl(var(--muted-foreground));font-size:.8rem}.actions{display:flex;flex-wrap:wrap;gap:.5rem}button{font:inherit;font-size:.875rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:.5rem .8rem;cursor:pointer;background:hsl(var(--primary));color:hsl(var(--primary-foreground))}.secondary{background:hsl(var(--background));color:hsl(var(--foreground))}button:disabled{opacity:.6;cursor:wait}button:focus-visible,a:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}a{color:hsl(var(--primary))}.feedback:empty{display:none}.error{color:hsl(var(--destructive))}`;
if (!customElements.get('cloudcommand-microsoft-connect')) customElements.define('cloudcommand-microsoft-connect', CloudCommandMicrosoftConnect);
