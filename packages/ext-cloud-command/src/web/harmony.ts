import {
  parseExtensionPageContextV1,
  type ExtensionPageContextV1,
} from "@breeze/extension-web-sdk";
import type { CloudCommandHostApi } from "./index";
import type {
  HarmonyClientInventory,
  HarmonyConnectionStatus,
  HarmonyScope,
} from "../server/native-harmony";

type Scope = HarmonyScope;
type Status = HarmonyConnectionStatus;
type Inventory = HarmonyClientInventory;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export class CloudCommandHarmonyPage extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private ctx: ExtensionPageContextV1 | null = null;
  private api: CloudCommandHostApi | null = null;
  private generation = 0;
  private status: Status = {
    available: true,
    connected: false,
    enabled: false,
    canConfigure: false,
    version: null,
    region: null,
    checkedAt: null,
    status: "not_connected",
    errorCode: null,
    mappings: [],
  };
  private inventory: Inventory = {
    computers: [],
    checkedAt: null,
    stale: true,
    devices: [],
  };
  private discovery: {
    version: number;
    groups: Array<{ id: string; name: string; type?: string }>;
    computers: Array<{ id: string; name: string }>;
  } | null = null;
  private message = "";
  private error = false;
  private busy = false;
  set context(input: unknown) {
    const c = parseExtensionPageContextV1(input);
    if (c.extensionName !== "cloudcommand")
      throw new Error("Wrong extension context");
    const changed = c.organizationId !== this.ctx?.organizationId;
    if (changed) {
      this.generation++;
      this.busy = false;
      this.status = {
        available: true,
        connected: false,
        enabled: false,
        canConfigure: false,
        version: null,
        region: null,
        checkedAt: null,
        status: "not_connected",
        errorCode: null,
        mappings: [],
      };
      this.inventory = {
        computers: [],
        checkedAt: null,
        stale: true,
        devices: [],
      };
      this.discovery = null;
      this.message = "";
      this.error = false;
    }
    this.ctx = c;
    this.render();
    if (changed && this.isConnected && this.api) void this.load();
  }
  set hostApi(api: CloudCommandHostApi) {
    this.api = api;
    if (this.isConnected && this.ctx) void this.load();
  }
  connectedCallback() {
    this.render();
    if (this.ctx && this.api) void this.load();
  }
  disconnectedCallback() {
    this.generation++;
  }
  private url(path: string) {
    return `/harmony${path}?orgId=${encodeURIComponent(this.ctx!.organizationId)}`;
  }
  private async req<T>(path: string, init?: RequestInit) {
    const gen = this.generation,
      api = this.api!;
    const r = await api.request(this.url(path), init);
    const body = await r.json();
    if (gen !== this.generation || api !== this.api)
      throw new Error("Organization changed; reload the selected client.");
    if (!r.ok || body.success === false)
      throw new Error(body.error || body.code || "Harmony request failed");
    return body as T;
  }
  private async action(fn: () => Promise<void>) {
    if (this.busy) return;
    const g = this.generation;
    this.busy = true;
    this.error = false;
    this.message = "Working…";
    try {
      await fn();
    } catch (e) {
      if (g === this.generation) {
        this.error = true;
        this.message = e instanceof Error ? e.message : "Request failed";
      }
    } finally {
      if (g === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }
  private async load() {
    await this.action(async () => {
      this.status = await this.req<Status>("/connection", { method: "GET" });
      this.inventory = await this.req<Inventory>("/inventory", {
        method: "GET",
      });
      this.message = this.status.connected
        ? "Harmony status updated."
        : "Connect Harmony to begin discovery.";
    });
  }
  private body(id: string) {
    return (
      this.root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)
        ?.value ?? ""
    ).trim();
  }
  private render() {
    const admin = this.status.canConfigure;
    const d = this.discovery;
    this.root.innerHTML = `<style>${styles}</style><main><header><div><p class="eyebrow">Cloud Command</p><h1>Harmony Endpoint</h1><p class="subtle">Scoped endpoint protection inventory for this organization.</p></div><button id="refresh" class="secondary">Refresh</button></header><p class="status" data-error="${this.error}">${esc(this.message)}</p>${admin ? `<section class="card"><h2>Connection</h2><div class="fields"><label>Region<select id="region"><option value="us" ${this.status.region === "us" ? "selected" : ""}>US</option><option value="eu" ${this.status.region === "eu" ? "selected" : ""}>EU</option><option value="ap" ${this.status.region === "ap" ? "selected" : ""}>AP</option></select></label><label>Client ID<input id="clientId" autocomplete="off" value=""></label><label>Access key<input id="accessKey" type="password" autocomplete="new-password" placeholder="${this.status.connected ? "Leave blank to keep stored key" : "Access key"}"></label></div><div class="actions"><button id="save">${this.status.enabled ? "Update" : "Save"} connection</button><button id="disable" class="secondary">Disable</button><button id="discover" class="secondary">Discover</button></div></section>` : ""}<section class="card"><div class="section-title"><div><h2>Scope mappings</h2><p class="subtle">Exact Harmony group or endpoint IDs are required.</p></div><span class="badge">${esc(this.status.status)}</span></div>${
      d
        ? `<div class="fields"><label>Mapping<select id="mapping">${d.groups
            .filter((g) => g.type === "GROUP")
            .map(
              (g) =>
                `<option value="group:${esc(g.id)}">Group · ${esc(g.name)} (${esc(g.id)})</option>`,
            )
            .join(
              "",
            )}${d.computers.map((c) => `<option value="endpoint:${esc(c.id)}">Endpoint · ${esc(c.name)} (${esc(c.id)})</option>`).join("")}</select></label></div><button id="addMapping" class="secondary">Add mapping</button>`
        : ""
    }<div class="mapping-list">${this.status.mappings.map((m, i) => `<span>${esc(m.kind)} · ${esc(m.externalId)} ${admin ? `<button class="compact" data-remove="${i}" aria-label="Remove mapping">×</button>` : ""}</span>`).join("") || '<span class="subtle">No mappings saved.</span>'}</div>${d ? '<button id="saveMappings">Save mappings</button>' : ""}</section><section class="card"><div class="section-title"><div><h2>Inventory</h2><p class="subtle">${this.inventory.stale ? "Last sync is stale." : ""} ${this.inventory.checkedAt ? `Checked ${esc(this.inventory.checkedAt)}` : "Not synced yet."}</p></div><button id="sync" class="secondary" ${admin ? "" : "disabled"}>Sync</button></div>${this.table()}</section><section class="card"><h2>Threat Hunting</h2><p class="subtle">External API connection is pending; no Threat Hunting controls are available.</p></section></main>`;
    this.root
      .querySelector("#refresh")
      ?.addEventListener("click", () => void this.load());
    this.root.querySelector("#discover")?.addEventListener(
      "click",
      () =>
        void this.action(async () => {
          this.discovery = await this.req("/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          this.message = "Discovery complete. Choose exact IDs to map.";
        }),
    );
    this.root.querySelector("#save")?.addEventListener(
      "click",
      () =>
        void this.action(async () => {
          const input: any = {
            version: this.status.version,
            region: this.body("region"),
            enabled: true,
          };
          const clientId = this.body("clientId"),
            accessKey = this.body("accessKey");
          if (clientId) input.clientId = clientId;
          if (accessKey) input.accessKey = accessKey;
          this.status = await this.req("/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          });
          this.inventory = await this.req<Inventory>("/inventory", {
            method: "GET",
          });
          this.message = "Harmony connection saved.";
        }),
    );
    this.root.querySelector("#disable")?.addEventListener(
      "click",
      () =>
        void this.action(async () => {
          this.status = await this.req("/connection", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: this.status.version,
              region: this.status.region ?? "us",
              enabled: false,
            }),
          });
          this.inventory = await this.req<Inventory>("/inventory", {
            method: "GET",
          });
          this.message = "Harmony connection disabled.";
        }),
    );
    this.root.querySelector("#sync")?.addEventListener(
      "click",
      () =>
        void this.action(async () => {
          const r = await this.req<any>("/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          this.message = `Sync complete: ${r.count} endpoint${r.count === 1 ? "" : "s"} checked.`;
          this.status = await this.req("/connection", { method: "GET" });
          this.inventory = await this.req("/inventory", { method: "GET" });
        }),
    );
    this.root.querySelector("#addMapping")?.addEventListener("click", () => {
      const v = this.body("mapping").split(":");
      if (
        v.length === 2 &&
        !this.status.mappings.some(
          (m) => m.kind === v[0] && m.externalId === v[1],
        )
      )
        this.status = {
          ...this.status,
          mappings: [
            ...this.status.mappings,
            { kind: v[0] as any, externalId: v[1] },
          ],
        };
      this.render();
    });
    if (admin)
      this.root.querySelectorAll<HTMLElement>("[data-remove]").forEach((b) =>
        b.addEventListener("click", () => {
          const i = Number(b.dataset.remove);
          this.status = {
            ...this.status,
            mappings: this.status.mappings.filter((_, n) => n !== i),
          };
          this.render();
        }),
      );
    this.root.querySelector("#saveMappings")?.addEventListener(
      "click",
      () =>
        void this.action(async () => {
          this.status = await this.req("/mappings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: this.status.version,
              mappings: this.status.mappings,
            }),
          });
          this.inventory = await this.req("/inventory", { method: "GET" });
          this.message = "Harmony mappings saved.";
        }),
    );
    if (this.status.canConfigure)
      this.root
        .querySelectorAll<HTMLSelectElement>("#link-device")
        .forEach((s) =>
          s.addEventListener(
            "change",
            () =>
              void this.action(async () => {
                const row = (s as any).dataset.externalId;
                await this.req("/link", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    externalId: row,
                    deviceId: s.value || null,
                    checkedAt: this.inventory.checkedAt,
                  }),
                });
                this.inventory = await this.req<Inventory>("/inventory", {
                  method: "GET",
                });
                this.message = "Device link saved.";
              }),
          ),
        );
    this.root
      .querySelectorAll("button")
      .forEach((b) => ((b as HTMLButtonElement).disabled ||= this.busy));
  }
  private table() {
    if (!this.inventory.computers.length)
      return '<p class="empty">No cached endpoints for this organization.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Anti-malware</th><th>Engine</th><th>Version</th><th>Last seen</th><th>Breeze device</th></tr></thead><tbody>${this.inventory.computers.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.antiMalwareStatus ?? "Unknown")}<small>${c.infectedCount == null ? "Unknown" : c.infectedCount} infected cumulative · ${c.quarantinedCount == null ? "Unknown" : c.quarantinedCount} quarantined cumulative</small></td><td>${esc(c.engineStatus ?? "Unknown")}</td><td>${esc(c.clientVersion ?? "Unknown")}</td><td>${esc(c.lastConnectedAt ?? "Unknown")}</td><td>${this.status.canConfigure ? `<select id="link-device" data-external-id="${esc(c.id)}"><option value="">Unlinked</option>${this.inventory.devices.map((d) => `<option value="${esc(d.id)}" ${c.deviceId === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select>` : c.deviceId ? `Linked to Breeze${this.inventory.devices.find((d) => d.id === c.deviceId) ? ` · ${esc(this.inventory.devices.find((d) => d.id === c.deviceId)!.name)}` : ""}` : "Unlinked"}</td></tr>`).join("")}</tbody></table></div>`;
  }
}
const styles = `:host{display:block;color:hsl(var(--foreground));font:14px/1.5 var(--font-sans,system-ui)}*{box-sizing:border-box}main{max-width:1100px;margin:auto;padding:24px}header,.section-title,.actions{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}h1,h2,p{margin:0}h1{font-size:24px}h2{font-size:17px}.eyebrow{color:hsl(var(--primary));font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.subtle,.status,small{color:hsl(var(--muted-foreground));font-size:13px}.status{min-height:20px;margin-top:10px}.status[data-error=true]{color:hsl(var(--destructive))}.card{border:1px solid hsl(var(--border));border-radius:8px;padding:18px;margin-top:16px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-top:15px}label{display:grid;gap:5px;color:hsl(var(--muted-foreground))}input,select,button{font:inherit;border:1px solid hsl(var(--border));border-radius:6px;padding:8px 10px;background:hsl(var(--background));color:inherit}button{background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600}.secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}.compact{padding:0 5px;background:transparent;color:inherit;border:0}.badge{padding:3px 8px;border-radius:999px;background:hsl(var(--muted));font-size:12px}.mapping-list{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.mapping-list span{border:1px solid hsl(var(--border));border-radius:999px;padding:4px 8px}.table-wrap{overflow:auto;margin-top:12px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:10px;border-bottom:1px solid hsl(var(--border));vertical-align:top}th{font-size:11px;color:hsl(var(--muted-foreground));text-transform:uppercase}small{display:block}.empty{padding:20px;text-align:center;border:1px dashed hsl(var(--border))}@media(max-width:600px){main{padding:14px}header,.section-title{flex-direction:column}.actions{flex-wrap:wrap}}`;
if (!customElements.get("cloudcommand-harmony-page"))
  customElements.define("cloudcommand-harmony-page", CloudCommandHarmonyPage);
