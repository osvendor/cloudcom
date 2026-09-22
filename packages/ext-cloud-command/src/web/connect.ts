import { parseExtensionPageContextV1, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import './microsoft-connect';
import type { CloudCommandHostApi, CloudCommandThreeCxMode } from './index';

const ELEMENT = 'cloudcommand-connect-page';
type Provider = 'threecx' | 'microsoft' | 'google';
const providers: ReadonlyArray<{ id: Provider; name: string; href: string; detail: string; icon: string }> = [
  { id: 'threecx', name: '3CX', href: '', detail: 'Connect a PBX and select the directory scope for this organization.', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"/><path d="M8 9h8M8 12h5M8 15h8"/></svg>' },
  { id: 'microsoft', name: 'Microsoft 365', href: '', detail: 'Manage Microsoft 365 connections, consent, and access for your organization.', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8H3z"/></svg>' },
  { id: 'google', name: 'Google Workspace', href: '/integrations#google', detail: 'Manage Google Workspace connections and access for your organization.', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a12 12 0 0 0 0 16M4 12h16"/></svg>' },
];
type ThreeCxElement = HTMLElement & { context: ExtensionPageContextV1; hostApi: CloudCommandHostApi; displayMode: CloudCommandThreeCxMode };
const selectedFromHash = (): Provider => {
  const value = window.location.hash.replace(/^#/, '');
  return value === 'threecx' || value === 'microsoft' || value === 'google' ? value : 'threecx';
};

export class CloudCommandConnectPage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private selected: Provider = 'threecx';
  private mountedProvider: Provider | null = null;
  private child: (HTMLElement & { context: ExtensionPageContextV1; hostApi: CloudCommandHostApi }) | null = null;
  private onHashChange = () => this.select(selectedFromHash(), false);

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    const changedOrganization = this.contextValue?.organizationId !== context.organizationId;
    this.contextValue = context;
    if (changedOrganization) {
      // The previous bridge is organization-scoped. Disconnect it before any
      // new context can reach the child, then wait for the host's new bridge.
      this.child?.remove();
      this.child = null;
      this.mountedProvider = null;
      this.api = null;
    }
    this.render();
  }

  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    // Existing children receive a stable forwarding bridge, so a same-org host
    // refresh does not reload and overwrite an unsaved credentials draft.
    this.render();
  }

  connectedCallback() { this.selected = selectedFromHash(); window.addEventListener('hashchange', this.onHashChange); this.render(); }
  disconnectedCallback() { window.removeEventListener('hashchange', this.onHashChange); }

  private select(provider: Provider, updateHash: boolean) {
    if (updateHash && window.location.hash !== `#${provider}`) window.location.hash = provider;
    if (this.selected === provider) return;
    this.selected = provider;
    this.render();
    if (updateHash) this.root.querySelector<HTMLButtonElement>(`[data-provider="${provider}"]`)?.focus();
  }

  private render() {
    const currentProvider = providers.find(provider => provider.id === this.selected)!;
    const preserveChild = this.selected === this.mountedProvider && this.child;
    if (!preserveChild) {
      this.root.innerHTML = `<style>${styles}</style><main aria-labelledby="title"><header><p class="eyebrow">Cloud Command</p><h1 id="title">Connect</h1><p>Set up services for the selected organization.</p></header><nav class="pills" aria-label="Connection providers">${providers.map(provider => `<button class="pill ${this.selected === provider.id ? 'selected' : ''}" data-provider="${provider.id}" type="button" aria-pressed="${this.selected === provider.id}"><span class="icon">${provider.icon}</span><span>${provider.name}</span></button>`).join('')}</nav><section class="panel" data-provider-panel="${this.selected}">${this.selected !== 'google' ? '' : `<h2>${currentProvider.name}</h2><p>${currentProvider.detail}</p><a class="native-link" href="${currentProvider.href}">Open ${currentProvider.name} setup</a>`}</section></main>`;
      this.mountedProvider = this.selected;
      this.child = null;
      // Custom-element lifecycle callbacks are delivered when this connected
      // host appends the child. Deferring a detached shell prevents a child
      // that never loads its connection state in DOM implementations.
      if (this.selected !== 'google' && this.isConnected && this.contextValue && this.api) {
        const child = document.createElement(this.selected === 'threecx' ? 'cloudcommand-threecx-page' : 'cloudcommand-microsoft-connect') as ThreeCxElement;
        if (this.selected === 'threecx') child.displayMode = 'configuration';
        child.context = this.contextValue;
        child.hostApi = { request: (path, init) => this.api!.request(path, init) };
        this.root.querySelector('[data-provider-panel]')!.append(child);
        this.child = child;
      } else if (this.selected !== 'google') this.root.querySelector('[data-provider-panel]')!.textContent = 'Loading organization setup…';
    } else {
      this.root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => {
        const selected = button.dataset.provider === this.selected;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => button.onclick = () => this.select(button.dataset.provider as Provider, true));
  }
}

const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{width:100%;padding:1.5rem}h1,h2,p{margin:0}h1{font-size:1.5rem;line-height:2rem}h2{font-size:1.125rem}.eyebrow{color:hsl(var(--primary));font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}header>p:last-child,.panel>p{color:hsl(var(--muted-foreground));margin-top:.35rem}.pills{display:flex;flex-wrap:wrap;gap:12px;margin-top:1.5rem}.pill{align-items:center;background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:999px;color:hsl(var(--muted-foreground));cursor:pointer;display:flex;font:inherit;font-size:.875rem;gap:12px;min-height:48px;padding:8px 16px 8px 8px;text-align:left}.pill.selected{background:hsl(var(--primary) / .1);border-color:hsl(var(--primary));color:hsl(var(--primary))}.pill:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}.icon{align-items:center;background:hsl(var(--muted) / .6);border-radius:999px;color:hsl(var(--foreground));display:inline-flex;height:32px;justify-content:center;width:32px}.icon svg{fill:none;height:16px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.8;width:16px}.pill.selected .icon{background:hsl(var(--primary));color:hsl(var(--primary-foreground))}.panel{margin-top:1rem}.panel:not(:has(cloudcommand-threecx-page,cloudcommand-microsoft-connect)){border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1.25rem}.native-link{color:hsl(var(--primary));display:inline-block;font-size:.875rem;font-weight:600;margin-top:1rem}@media(max-width:600px){main{padding:1rem}.pills{align-items:stretch;flex-direction:column}.pill{width:100%}}`;
if (!customElements.get(ELEMENT)) customElements.define(ELEMENT, CloudCommandConnectPage);
