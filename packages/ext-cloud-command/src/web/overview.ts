import { dispatchExtensionHostEvent, parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';

type Provider = 'threecx' | 'microsoft' | 'google';
type Status = { connected: boolean; enabled?: boolean; canManage?: boolean; available?: boolean };
type HostApi = { request(path: string): Promise<Response> };
const providers = [{ id: 'threecx', title: '3CX', description: 'PBX connection and extension directory.' }, { id: 'microsoft', title: 'Microsoft 365', description: 'Users, groups, licenses and SharePoint inventory.' }, { id: 'google', title: 'Google Workspace', description: 'Users and groups from the connected Workspace directory.' }] as const;

export class CloudCommandOverviewPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: HostApi | null = null;
  private generation = 0;
  private states: Partial<Record<Provider, Status>> = {};
  private loading = true;
  private failed = false;
  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    this.contextValue = context;
    this.generation += 1;
    this.states = {};
    this.loading = true;
    this.failed = false;
    this.render();
    if (this.isConnected && this.api) void this.load();
  }
  set hostApi(api: HostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    if (this.isConnected && this.contextValue) void this.load();
  }
  connectedCallback() { this.render(); if (this.contextValue && this.api) void this.load(); }
  disconnectedCallback() { this.generation += 1; }
  private async load() {
    const generation = ++this.generation;
    const api = this.api!;
    this.loading = true;
    this.failed = false;
    this.render();
    const results = await Promise.allSettled(providers.map(async provider => {
      const response = await api.request(`/${provider.id}/connection`);
      if (!response.ok) throw new Error('Provider status unavailable');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || typeof (body as Status).connected !== 'boolean') throw new Error('Invalid provider status');
      return { id: provider.id, status: body as Status };
    }));
    if (generation !== this.generation) return;
    this.states = {};
    for (const result of results) {
      if (result.status === 'fulfilled') this.states[result.value.id] = result.value.status;
      else this.failed = true;
    }
    this.loading = false;
    this.render();
  }
  private render() {
    const visible = providers.filter(provider => {
      const state = this.states[provider.id];
      return state && (provider.id === 'threecx' || state.available === true) && ((state.connected === true && state.enabled === true) || state.canManage === true);
    });
    this.root.innerHTML = `<style>${styles}</style><main><header><div><h1>Cloud Command</h1><p>Services for the selected organization.</p></div><button id="refresh" ${this.loading ? 'disabled' : ''}>Refresh</button></header><p role="status">${this.loading ? 'Loading services…' : this.failed ? 'Some service statuses could not be loaded. Refresh to try again.' : ''}</p><section aria-label="Organization services" class="providers">${visible.map(provider => {
      const enabled = this.states[provider.id]!.connected && this.states[provider.id]!.enabled === true;
      return `<article><h2>${provider.title}</h2><p>${provider.description}</p><span>${enabled ? 'Enabled' : 'Not enabled'}</span><button data-provider="${provider.id}">${enabled ? 'Open' : 'Configure'} ${provider.title}</button></article>`;
    }).join('')}</section>${!this.loading && !visible.length ? '<p class="empty">No enabled services are available for this organization.</p>' : ''}</main>`;
    this.root.querySelector('#refresh')?.addEventListener('click', () => { void this.load(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => button.addEventListener('click', () => {
      const provider = providers.find(item => item.id === button.dataset.provider);
      if (provider) {
        const state = this.states[provider.id];
        const path = state?.connected === true && state.enabled === true
          ? `/extensions/cloudcommand/${provider.id}`
          : `/extensions/cloudcommand/connect#${provider.id}`;
        dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path });
      }
    }));
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:auto;padding:1.5rem}header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}h1{font-size:1.5rem;margin:0}h2{font-size:1.1rem;margin:0}p{color:hsl(var(--muted-foreground));font-size:.875rem;line-height:1.5}p[role=status]{min-height:1.5rem}.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:1rem}article{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--card));padding:1.25rem;display:flex;align-items:flex-start;flex-direction:column;gap:.5rem}article p{flex:1;margin:.25rem 0}span{background:hsl(var(--muted));color:hsl(var(--muted-foreground));border-radius:999px;padding:.25rem .6rem;font-size:.75rem}button{background:hsl(var(--primary));color:hsl(var(--primary-foreground));font:inherit;font-size:.875rem;font-weight:600;border:0;border-radius:calc(var(--radius,.5rem) - 2px);padding:.6rem .85rem;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}article button{margin-top:1rem}.empty{border:1px dashed hsl(var(--border));border-radius:var(--radius,.5rem);padding:1.25rem}@media(max-width:600px){main{padding:1rem}}`;
if (!customElements.get('cloudcommand-overview-page')) customElements.define('cloudcommand-overview-page', CloudCommandOverviewPage);
