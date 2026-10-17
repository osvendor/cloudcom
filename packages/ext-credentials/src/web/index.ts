import type { ExtensionHostApi } from "@breeze/extension-web-sdk";
import "./documents";
import "./browserCompanion";

type Credential = { id: string; name: string; category?: string; username?: string; email?: string; url?: string; hasPassword: boolean; hasOtp: boolean };
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
  private clearSecrets(): void { Object.values(this.revealed).forEach((x) => window.clearTimeout(x.timer)); this.revealed = {}; }
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
  private async reveal(id: string, field: "password" | "otp"): Promise<void> { const rev = this.revision; try { const body = await this.request<{ value?: string; code?: string; expiresAt?: string }>(this.path(`/${encodeURIComponent(id)}/${field === "otp" ? "otp" : "reveal"}`), { method: "POST", headers: { "Content-Type": "application/json" }, ...(field === "password" ? { body: JSON.stringify({ field }) } : {}) }); if (rev !== this.revision) return; const value = body.value ?? body.code ?? ""; const expiry = field === "otp" && body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 30_000; const timer = window.setTimeout(() => { delete this.revealed[id]; this.render(); }, Math.max(0, expiry - Date.now())); this.revealed[id] = { field, value, timer }; this.render(); } catch { if (rev === this.revision) { this.error = true; this.status = "Could not reveal that credential."; this.render(); } } }
  private render(): void {
    this.root.replaceChildren(); const style = document.createElement("style"); style.textContent = ":host{display:block;font:14px system-ui;color:hsl(var(--foreground));background:hsl(var(--background))}main{max-width:820px;padding:20px}section{border:1px solid hsl(var(--border));background:hsl(var(--card));border-radius:8px;padding:16px;margin:16px 0}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}label{display:block;flex:1}input,button{font:inherit;padding:7px;margin-top:4px;color:inherit;background:hsl(var(--input,var(--background)));border:1px solid hsl(var(--border));border-radius:4px}button{cursor:pointer}button:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}[data-error=true]{color:hsl(var(--destructive))}.secret{font-family:monospace;word-break:break-all}"; this.root.append(style);
    const main = document.createElement("main"), h = document.createElement("h1"); h.textContent = "Credentials"; main.append(h); const scope = document.createElement("p"); scope.textContent = this.clientName ? `Client: ${this.clientName}` : "Client-scoped credentials"; main.append(scope); const status = document.createElement("p"); status.textContent = this.status; status.dataset.error = String(this.error); status.setAttribute("role", this.error ? "alert" : "status"); main.append(status);
    const section = document.createElement("section"), row = document.createElement("div"); row.className = "row"; const label = document.createElement("label"); label.textContent = "Search credentials"; const input = document.createElement("input"); input.type = "search"; input.value = this.query; input.setAttribute("aria-label", "Search credentials"); input.onkeydown = (e) => { if (e.key === "Enter") { this.query = input.value; void this.load(); } }; label.append(input); row.append(label); const search = document.createElement("button"); search.textContent = "Search"; search.onclick = () => { this.query = input.value; void this.load(); }; row.append(search); section.append(row);
    this.credentials.forEach((item) => { const card = document.createElement("div"); card.className = "row"; const text = document.createElement("span"); text.textContent = `${item.name}${item.category ? ` · ${item.category}` : ""}${item.username || item.email ? ` — ${item.username || item.email}` : ""}`; card.append(text); if (item.url) { try { const parsed = new URL(item.url); if (parsed.protocol === "http:" || parsed.protocol === "https:") { const link = document.createElement("a"); link.textContent = item.url; link.href = parsed.href; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link); } } catch { /* malformed imported URLs stay text-free */ } } (["password", "otp"] as const).forEach((field) => { const available = field === "password" ? item.hasPassword : item.hasOtp; if (!available) return; const shown = this.revealed[item.id]?.field === field; const button = document.createElement("button"); button.textContent = shown ? "Hide" : field === "otp" ? "Show code" : "Reveal password"; button.setAttribute("aria-label", `${shown ? "Hide" : "Reveal"} ${field}`); button.onclick = () => { if (shown) { window.clearTimeout(this.revealed[item.id].timer); delete this.revealed[item.id]; this.render(); } else void this.reveal(item.id, field); }; card.append(button); if (shown) { const secret = document.createElement("span"); secret.className = "secret"; secret.textContent = this.revealed[item.id].value; secret.setAttribute("aria-live", "polite"); card.append(secret); } }); section.append(card); }); if (!this.credentials.length && this.organizationId && !this.error) { const empty = document.createElement("p"); empty.textContent = "No credentials found for this client."; section.append(empty); } main.append(section); this.root.append(main);
  }
}
if (!customElements.get(elementName)) customElements.define(elementName, CredentialsPage);
