import { parseExtensionPageContextV1, dispatchExtensionHostEvent, type ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import type { CloudCommandHostApi } from './index';

type Kind = 'users' | 'groups';
type Connection = { available: boolean; connected: boolean; enabled: boolean; customerDomain?: string };
type Row = Record<string, string | boolean | null>;
type Page = { items: Row[]; nextPageToken: string | null; complete: boolean };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const headers: Record<Kind, readonly { key: string; label: string }[]> = {
  users: [
    { key: 'name', label: 'User' }, { key: 'email', label: 'Email' }, { key: 'suspended', label: 'Status' },
    { key: 'admin', label: 'Administrator' }, { key: 'orgUnitPath', label: 'Org unit' },
    { key: 'lastLoginTime', label: 'Last sign-in' }, { key: 'twoStepVerificationEnrolled', label: '2-step enrolled' },
    { key: 'twoStepVerificationEnforced', label: '2-step enforced' },
  ],
  groups: [{ key: 'name', label: 'Group' }, { key: 'email', label: 'Email' }, { key: 'members', label: 'Members' }, { key: 'description', label: 'Description' }],
};
function cell(row: Row, key: string): string {
  const raw = row[key];
  if (key === 'suspended') return raw === true ? 'Suspended' : raw === false ? 'Active' : 'Unavailable';
  if (key === 'admin' || key.startsWith('twoStep')) return raw === true ? 'Yes' : raw === false ? 'No' : 'Unavailable';
  return escape(raw ?? '—');
}

export class CloudCommandGooglePage extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' });
  private contextValue: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private generation = 0;
  private connection: Connection | null = null;
  private kind: Kind = 'users';
  private rows: Row[] = [];
  private nextToken: string | null = null;
  private loading = false;
  private error = '';
  private query = '';

  set context(input: unknown) {
    const context = parseExtensionPageContextV1(input);
    if (context.extensionName !== 'cloudcommand') throw new Error('Wrong extension context');
    if (context.organizationId !== this.contextValue?.organizationId) {
      this.generation++; this.rows = []; this.nextToken = null; this.connection = null; this.error = ''; this.query = '';
      // The existing capability belongs to the previous organization. Wait for
      // the host to provide the replacement before requesting any new data.
      this.api = null;
    }
    this.contextValue = context;
    this.render();
    if (this.isConnected && this.api) void this.loadConnection();
  }
  set hostApi(api: CloudCommandHostApi) {
    if (!api || typeof api.request !== 'function') throw new Error('Authenticated host API required');
    this.api = api;
    if (this.isConnected && this.contextValue) void this.loadConnection();
  }
  connectedCallback() { this.render(); if (this.api && this.contextValue) void this.loadConnection(); }
  disconnectedCallback() { this.generation++; }
  private async request<T>(path: string): Promise<T> {
    if (!this.api) throw new Error('The authenticated host API is unavailable.');
    const response = await this.api.request(path);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'Google Workspace request failed.');
    return body as T;
  }
  private async loadConnection() {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.render();
    try {
      const connection = await this.request<Connection>('/google/connection');
      if (generation !== this.generation) return;
      this.connection = connection;
      this.loading = false;
      this.render();
      if (connection.connected && connection.enabled) void this.loadPage(true);
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : 'Could not load Google Workspace.';
      this.loading = false; this.render();
    }
  }
  private async loadPage(reset: boolean) {
    if (this.loading || !this.connection?.enabled) return;
    const generation = this.generation;
    const token = reset ? null : this.nextToken;
    if (!reset && !token) return;
    this.loading = true; this.error = ''; this.render();
    try {
      const page = await this.request<Page>(`/google/directory/${this.kind}${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
      if (generation !== this.generation) return;
      this.rows = reset ? page.items : [...this.rows, ...page.items];
      this.nextToken = page.nextPageToken;
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not load directory.';
    }
    if (generation === this.generation) { this.loading = false; this.render(); }
  }
  private render() {
    const connected = this.connection?.connected && this.connection?.enabled;
    const columns = headers[this.kind];
    const visible = this.rows.filter(row => !this.query || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(this.query)));
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Google Workspace</p><h1>Directory</h1><p>${connected ? escape(this.connection?.customerDomain ?? 'Connected') : 'Users and groups for the selected organization.'}</p></div><button id="refresh" ${this.loading ? 'disabled' : ''}>Refresh</button></header>${this.error ? `<p class="error" role="alert">${escape(this.error)}</p>` : ''}${!this.connection && this.loading ? '<p role="status">Loading connection…</p>' : !connected ? `<div class="empty">${this.connection?.available === false ? 'Google Workspace is not enabled on this server.' : 'No active Google Workspace connection.'}<button id="connect">Open Connect</button></div>` : `<nav aria-label="Google directory"><button data-kind="users" aria-current="${this.kind === 'users'}">Users</button><button data-kind="groups" aria-current="${this.kind === 'groups'}">Groups</button></nav><label class="search">Search loaded ${this.kind}<input id="search" value="${escape(this.query)}" placeholder="Name or email"></label><p class="note">${this.nextToken ? 'Showing loaded results; more pages are available.' : 'Directory results loaded.'}</p><div class="table"><table><thead><tr>${columns.map(col => `<th>${col.label}</th>`).join('')}</tr></thead><tbody>${visible.map(row => `<tr>${columns.map(col => `<td>${cell(row, col.key)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${!visible.length && !this.loading ? '<p class="empty">No results in the loaded page.</p>' : ''}${this.nextToken ? `<button id="more" ${this.loading ? 'disabled' : ''}>Load more</button>` : ''}${this.loading ? '<p role="status">Loading…</p>' : ''}`}</main>`;
    this.root.querySelector('#refresh')?.addEventListener('click', () => { if (connected) void this.loadPage(true); else void this.loadConnection(); });
    this.root.querySelector('#connect')?.addEventListener('click', () => dispatchExtensionHostEvent(this, { version: 1, type: 'navigate', path: '/extensions/cloudcommand/connect#google' }));
    this.root.querySelector('#more')?.addEventListener('click', () => void this.loadPage(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(button => button.addEventListener('click', () => {
      const kind = button.dataset.kind as Kind;
      if (kind === this.kind) return;
      this.generation++; this.kind = kind; this.rows = []; this.nextToken = null; this.query = ''; this.loading = false;
      this.render(); void this.loadPage(true);
    }));
    this.root.querySelector<HTMLInputElement>('#search')?.addEventListener('input', event => {
      this.query = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.render(); this.root.querySelector<HTMLInputElement>('#search')?.focus();
    });
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font-family:var(--font-sans,system-ui)}*{box-sizing:border-box}main{padding:1rem 1.25rem}header{display:flex;justify-content:space-between;align-items:start;gap:1rem;border-bottom:1px solid hsl(var(--border));padding-bottom:.8rem}h1{font-size:1.4rem;margin:.1rem 0}p{margin:.25rem 0;color:hsl(var(--muted-foreground));font-size:.85rem}.eyebrow{font-size:.73rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--primary))}button{font:inherit;font-size:.85rem;min-height:36px;padding:.35rem .7rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--card));color:hsl(var(--foreground));cursor:pointer}button:disabled{opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid hsl(var(--ring))}nav{display:flex;gap:.5rem;margin:1rem 0}nav button[aria-current=true]{border-color:hsl(var(--primary));color:hsl(var(--primary))}.search{display:block;font-size:.82rem;color:hsl(var(--muted-foreground))}input{display:block;width:min(100%,350px);height:38px;margin-top:.35rem;border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);background:hsl(var(--background));color:hsl(var(--foreground));padding:.4rem .6rem;font:inherit}.note{margin:.75rem 0}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:.55rem .65rem;border-bottom:1px solid hsl(var(--border));text-align:left;white-space:nowrap}th{color:hsl(var(--muted-foreground));font-size:.72rem;text-transform:uppercase}.error{color:hsl(var(--destructive))}.empty{padding:1rem;border:1px dashed hsl(var(--border));margin-top:1rem}.empty button{display:block;margin-top:.7rem}@media(max-width:600px){main{padding:.8rem}header{flex-wrap:wrap}}`;
if (!customElements.get('cloudcommand-google-page')) customElements.define('cloudcommand-google-page', CloudCommandGooglePage);
