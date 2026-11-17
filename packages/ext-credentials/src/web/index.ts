import type { ExtensionHostApi } from "@breeze/extension-web-sdk";
import "./documents";
import "./browserCompanion";

type Credential = { id: string; name: string; category?: string; username?: string; email?: string; url?: string; hasPassword: boolean; hasOtp: boolean; isAdministration?: boolean; isDraft?: boolean; temporaryPassword?: boolean };
type Context = { organizationId: string; clientName?: string };

const elementName = "cloudcom-credentials-page";

export class CredentialsPage extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private _hostApi: ExtensionHostApi | null = null;
  private organizationId = "";
  private clientName = "";
  private credentials: Credential[] = [];
  private revealed: Record<string, { field: string; value: string; timer: number }> = {};
  private revision = 0;
  private disclosureRevision = 0;
  private administration = false;
  private query = "";
  private status = "Choose a client to view credentials.";
  private error = false;

  set context(value: unknown) {
    const next = value && typeof value === "object" ? value as Partial<Context> : {};
    const org = typeof next.organizationId === "string" ? next.organizationId : "";
    if (org !== this.organizationId) { this.clearSecrets(); this.credentials = []; this.query = ""; this.organizationId = org; this.clientName = typeof next.clientName === "string" ? next.clientName : ""; void this.load(); }
    else if (typeof next.clientName === "string") { this.clientName = next.clientName; this.render(); }
  }
  set hostApi(value: ExtensionHostApi | null) { this._hostApi = value && typeof value.request === "function" ? value : null; if (this.isConnected) void this.load(); }
  connectedCallback(): void { this.render(); if (this.organizationId) void this.load(); }
  disconnectedCallback(): void { this.revision++; this.clearSecrets(); this.credentials = []; }
  private clearSecrets(): void { this.disclosureRevision++; Object.values(this.revealed).forEach((x) => window.clearTimeout(x.timer)); this.revealed = {}; }
  private path(suffix: string): string { return `/orgs/${encodeURIComponent(this.organizationId)}/credentials${suffix}`; }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this._hostApi) throw new Error("Credential service is unavailable.");
    const response = await this._hostApi.request(path, { ...init, cache: "no-store" });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error("Credential request failed.");
    return body as T;
  }
  private async load(): Promise<void> {
    const rev = ++this.revision; this.clearSecrets(); this.credentials = [];
    if (!this._hostApi || !this.organizationId) { this.status = "Choose a client to view credentials."; this.error = false; this.render(); return; }
    this.status = "Loading credentials…"; this.error = false; this.render();
    try { const q = this.query ? `?q=${encodeURIComponent(this.query)}` : ""; const body = await this.request<{ credentials: Credential[] }>(this.path(q)); if (rev !== this.revision) return; this.credentials = Array.isArray(body.credentials) ? body.credentials : []; this.status = "Credentials loaded."; this.render(); }
    catch { if (rev !== this.revision) return; this.error = true; this.status = "Could not load credentials."; this.render(); }
  }
  private async reveal(id: string, field: "password" | "otp"): Promise<void> { const rev = this.revision, disclosure = this.disclosureRevision; try { const body = await this.request<{ value?: string; code?: string; expiresAt?: string }>(this.path(`/${encodeURIComponent(id)}/${field === "otp" ? "otp" : "reveal"}`), { method: "POST", headers: { "Content-Type": "application/json" }, ...(field === "password" ? { body: JSON.stringify({ field }) } : {}) }); if (rev !== this.revision || disclosure !== this.disclosureRevision) return; const value = body.value ?? body.code ?? ""; const expiry = field === "otp" && body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 30_000; const timer = window.setTimeout(() => { delete this.revealed[id]; this.render(); }, Math.max(0, expiry - Date.now())); this.revealed[id] = { field, value, timer }; this.render(); } catch { if (rev === this.revision) { this.error = true; this.status = "Could not reveal that credential."; this.render(); } } }
  private render(): void {
    this.root.replaceChildren();
    const style = document.createElement("style");
    style.textContent = ":host{display:block;font:14px system-ui;color:hsl(var(--foreground));background:hsl(var(--background))}main{max-width:820px;padding:20px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.search{margin:16px 0}label{display:block;flex:1}input,button{font:inherit;padding:7px;margin-top:4px;color:inherit;background:hsl(var(--input,var(--background)));border:1px solid hsl(var(--border));border-radius:4px}button{cursor:pointer}button:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}[data-error=true]{color:hsl(var(--destructive))}.secret{font-family:monospace;word-break:break-all}.sections{display:flex;gap:8px;border-bottom:1px solid hsl(var(--border));padding-bottom:10px}.sections [aria-pressed=true]{border-color:hsl(var(--primary));font-weight:600}.credential{padding:16px 0;border-bottom:1px solid hsl(var(--border))}.description{flex:1;min-width:200px}.description strong{display:block}.meta{color:hsl(var(--muted-foreground));font-size:12px;margin-top:4px}.actions{display:flex;gap:8px;flex-wrap:wrap}a{overflow-wrap:anywhere}";
    this.root.append(style);
    const main = document.createElement("main"), heading = document.createElement("h1"); heading.textContent = "Credentials"; main.append(heading);
    const scope = document.createElement("p"); scope.textContent = this.clientName ? `Client: ${this.clientName}` : "Client-scoped credentials"; main.append(scope);
    const status = document.createElement("p"); status.textContent = this.status; status.dataset.error = String(this.error); status.setAttribute("role", this.error ? "alert" : "status"); main.append(status);
    const searchRow = document.createElement("div"); searchRow.className = "row search";
    const label = document.createElement("label"); label.textContent = "Search credentials";
    const input = document.createElement("input"); input.type = "search"; input.value = this.query; input.setAttribute("aria-label", "Search credentials");
    const search = document.createElement("button"); search.textContent = "Search"; search.onclick = () => { this.query = input.value; void this.load(); };
    input.onkeydown = event => { if (event.key === "Enter") search.click(); };
    label.append(input); searchRow.append(label, search); main.append(searchRow);
    const sections = document.createElement("nav"); sections.className = "sections"; sections.setAttribute("aria-label", "Credential sections");
    for (const [isAdministration, title] of [[false, "User accounts"], [true, "Client administration"]] as const) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = title; button.setAttribute("aria-pressed", String(this.administration === isAdministration));
      button.onclick = () => { this.clearSecrets(); this.administration = isAdministration; this.render(); }; sections.append(button);
    }
    main.append(sections);
    const selected = this.credentials.filter(item => Boolean(item.isAdministration) === this.administration);
    for (const item of selected) {
      const card = document.createElement("article"); card.className = "credential";
      const row = document.createElement("div"); row.className = "row";
      const description = document.createElement("div"); description.className = "description";
      const name = document.createElement("strong"); name.textContent = item.name || item.category || "Credential";
      const username = document.createElement("div"); username.textContent = item.username || item.email || "No username";
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = `${item.category || "Unclassified"} · Account / tenant administration: ${item.isAdministration ? "Yes" : "No"}${item.isDraft ? " · Draft" : ""}${item.temporaryPassword ? " · Temporary password" : ""}`;
      description.append(name, username, meta); row.append(description); card.append(row);
      if (item.url) { try { const parsed = new URL(item.url); if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) { const link = document.createElement("a"); link.textContent = item.url; link.href = parsed.href; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link); } } catch { /* Invalid URLs are not links. */ } }
      const actions = document.createElement("div"); actions.className = "actions";
      for (const field of ["password", "otp"] as const) {
        if (!(field === "password" ? item.hasPassword : item.hasOtp)) continue;
        const shown = this.revealed[item.id]?.field === field;
        const button = document.createElement("button"); button.textContent = shown ? "Hide" : field === "otp" ? "Show code" : "Reveal password"; button.setAttribute("aria-label", `${shown ? "Hide" : "Reveal"} ${field}`);
        button.onclick = () => { if (shown) { window.clearTimeout(this.revealed[item.id].timer); delete this.revealed[item.id]; this.render(); } else void this.reveal(item.id, field); };
        actions.append(button);
        if (shown) { const secret = document.createElement("span"); secret.className = "secret"; secret.textContent = this.revealed[item.id].value; secret.setAttribute("aria-live", "polite"); actions.append(secret); }
      }
      card.append(actions); main.append(card);
    }
    if (!selected.length && this.organizationId && !this.error) { const empty = document.createElement("p"); empty.textContent = "No credentials found in this section."; main.append(empty); }
    this.root.append(main);
  }
}
if (!customElements.get(elementName)) customElements.define(elementName, CredentialsPage);
