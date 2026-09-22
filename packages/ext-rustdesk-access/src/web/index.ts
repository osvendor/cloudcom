import type { ExtensionHostApi } from "@breeze/extension-web-sdk";

type Settings = {
  enabled: boolean;
  webrtcEnabled: boolean;
  rustdeskEnabled: boolean;
};
type Assignment = {
  id: string;
  portalUserId: string;
  deviceId: string;
  enabled: boolean;
  expiresAt?: string | null;
  userName?: string;
  email?: string;
  hostname?: string;
};
type Options = {
  users: Array<{
    id: string;
    name: string;
    email: string;
    accessMode?: string;
  }>;
  devices: Array<{ id: string; hostname: string }>;
};

const elementName = "remoteaccess-settings-page";

export class RemoteAccessSettingsPage extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private organizationId = "";
  private _hostApi: ExtensionHostApi | null = null;
  private settings: Settings | null = null;
  private assignments: Assignment[] = [];
  private options: Options | null = null;
  private status = "Loading Remote Access…";
  private error = false;
  private revision = 0;
  private busy = false;

  set context(value: unknown) {
    const next =
      value &&
      typeof value === "object" &&
      typeof (value as { organizationId?: unknown }).organizationId === "string"
        ? (value as { organizationId: string }).organizationId
        : "";
    if (next !== this.organizationId) {
      this.organizationId = next;
      void this.load();
    }
  }
  set hostApi(value: ExtensionHostApi | null) {
    this._hostApi = value && typeof value.request === "function" ? value : null;
    if (this.isConnected) void this.load();
  }

  connectedCallback(): void {
    this.render();
    if (this.organizationId) void this.load();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this._hostApi)
      throw new Error("The authenticated host API is unavailable.");
    const response = await this._hostApi.request(path, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        body &&
          typeof body === "object" &&
          typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : "Remote Access request failed.",
      );
    return body as T;
  }
  private path(suffix: string): string {
    return `/orgs/${encodeURIComponent(this.organizationId)}${suffix}`;
  }
  private async load(): Promise<void> {
    const revision = ++this.revision;
    this.settings = null;
    this.options = null;
    this.assignments = [];
    this.busy = false;
    if (!this._hostApi || !this.organizationId) {
      this.status = "Choose an organization to manage Remote Access.";
      this.error = false;
      this.render();
      return;
    }
    this.status = "Loading Remote Access…";
    this.error = false;
    this.render();
    try {
      const [settings, assignments, options] = await Promise.all([
        this.request<Settings>(this.path("/settings")),
        this.request<{ assignments: Assignment[] }>(this.path("/assignments")),
        this.request<Options>(this.path("/options")),
      ]);
      if (revision !== this.revision) return;
      this.settings = settings;
      this.assignments = assignments.assignments;
      this.options = options;
      this.status = "Remote Access settings loaded.";
      this.render();
    } catch (e) {
      if (revision !== this.revision) return;
      this.status =
        e instanceof Error
          ? e.message
          : "Could not load Remote Access settings.";
      this.error = true;
      this.render();
    }
  }
  private async saveSettings(): Promise<void> {
    if (!this.settings) return;
    const controls = this.root.querySelectorAll<HTMLInputElement>(
      "input[data-setting]",
    );
    controls.forEach((input) => {
      const key = input.dataset.setting as keyof Settings;
      this.settings![key] = input.checked;
    });
    await this.mutate(
      () =>
        this.request<Settings>(this.path("/settings"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.settings),
        }),
      "Remote Access settings saved.",
    );
  }
  private async grant(): Promise<void> {
    const user = this.root.querySelector<HTMLSelectElement>("#user")?.value;
    const device = this.root.querySelector<HTMLSelectElement>("#device")?.value;
    const expiresAt =
      this.root.querySelector<HTMLInputElement>("#expiresAt")?.value;
    if (!user || !device) {
      this.status = "Select a portal user and computer.";
      this.error = true;
      this.render();
      return;
    }
    await this.mutate(
      () =>
        this.request<Assignment>(this.path("/assignments"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            portalUserId: user,
            deviceId: device,
            ...(expiresAt
              ? { expiresAt: new Date(expiresAt).toISOString() }
              : {}),
          }),
        }),
      "Access granted.",
    );
    if (!this.error) await this.load();
  }
  private async revoke(id: string): Promise<void> {
    await this.mutate(
      () =>
        this.request(this.path(`/assignments/${encodeURIComponent(id)}`), {
          method: "DELETE",
        }),
      "Access revoked.",
    );
    if (!this.error) await this.load();
  }
  private async mutate(
    action: () => Promise<unknown>,
    success: string,
  ): Promise<void> {
    if (!this._hostApi || this.busy) return;
    const revision = this.revision;
    const org = this.organizationId;
    this.busy = true;
    this.status = "Saving…";
    this.error = false;
    this.render();
    try {
      await action();
      if (revision === this.revision && org === this.organizationId)
        this.status = success;
    } catch (e) {
      if (revision === this.revision && org === this.organizationId) {
        this.status = e instanceof Error ? e.message : "The request failed.";
        this.error = true;
      }
    } finally {
      this.busy = false;
      if (revision === this.revision && org === this.organizationId)
        this.render();
    }
  }

  private label(text: string): HTMLLabelElement {
    const label = document.createElement("label");
    label.textContent = text;
    return label;
  }
  private render(): void {
    const disabled = !this._hostApi || !this.organizationId;
    this.root.replaceChildren();
    const style = document.createElement("style");
    style.textContent =
      ":host{display:block;font:14px system-ui;color:#17231d}main{max-width:760px;padding:20px}section{border:1px solid #d5ddd8;border-radius:8px;padding:16px;margin:16px 0}h1{font-size:22px}h2{font-size:16px}label{display:block;margin:10px 0}button,select,input{font:inherit;padding:7px;margin-top:4px}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}[data-error=true]{color:#a33}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}";
    this.root.append(style);
    const main = document.createElement("main");
    const heading = document.createElement("h1");
    heading.textContent = "Remote Access";
    main.append(heading);
    const status = document.createElement("p");
    status.textContent = this.status;
    status.dataset.error = String(this.error);
    status.setAttribute("role", this.error ? "alert" : "status");
    main.append(status);
    if (this.settings) {
      const section = document.createElement("section");
      const title = document.createElement("h2");
      title.textContent = "Connection methods";
      section.append(title);
      (
        [
          ["enabled", "Enable Remote Access"],
          ["webrtcEnabled", "Allow browser connections"],
          ["rustdeskEnabled", "Allow RustDesk connections"],
        ] as const
      ).forEach(([key, text]) => {
        const label = this.label(text);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = this.settings![key];
        input.disabled = disabled;
        input.dataset.setting = key;
        label.prepend(input);
        section.append(label);
      });
      const save = document.createElement("button");
      save.textContent = "Save settings";
      save.disabled = disabled;
      save.onclick = () => void this.saveSettings();
      section.append(save);
      const note = document.createElement("p");
      note.textContent =
        "Granting access changes this account to remote access only. The customer will see only their assigned computers.";
      section.append(note);
      main.append(section);
    }
    if (this.options) {
      const section = document.createElement("section");
      const title = document.createElement("h2");
      title.textContent = "Grant computer access";
      section.append(title);
      const row = document.createElement("div");
      row.className = "row";
      const userLabel = this.label("Portal user");
      const user = document.createElement("select");
      user.id = "user";
      user.dataset.testid = "remote-user";
      user.disabled = disabled;
      this.options.users.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.name} (${item.email})`;
        user.append(option);
      });
      userLabel.append(user);
      row.append(userLabel);
      const deviceLabel = this.label("Computer");
      const device = document.createElement("select");
      device.id = "device";
      device.dataset.testid = "remote-device";
      device.disabled = disabled;
      this.options.devices.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.hostname;
        device.append(option);
      });
      deviceLabel.append(device);
      row.append(deviceLabel);
      const expiry = this.label("Expires (optional)");
      const expiryInput = document.createElement("input");
      expiryInput.id = "expiresAt";
      expiryInput.type = "datetime-local";
      expiryInput.disabled = disabled;
      expiry.append(expiryInput);
      row.append(expiry);
      const grant = document.createElement("button");
      grant.textContent = "Grant access";
      grant.dataset.testid = "remote-grant";
      grant.disabled =
        disabled || !this.options.users.length || !this.options.devices.length;
      grant.onclick = () => void this.grant();
      row.append(grant);
      section.append(row);
      main.append(section);
    }
    const current = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = "Current access";
    current.append(title);
    if (!this.assignments.length) {
      const empty = document.createElement("p");
      empty.textContent = "No remote access assignments yet.";
      current.append(empty);
    } else
      this.assignments.forEach((assignment) => {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("span");
        text.textContent = `${assignment.userName || assignment.email || assignment.portalUserId} → ${assignment.hostname || assignment.deviceId}${assignment.expiresAt ? ` (expires ${assignment.expiresAt})` : ""}`;
        row.append(text);
        const revoke = document.createElement("button");
        revoke.textContent = "Revoke";
        revoke.dataset.testid = `remote-revoke-${assignment.id}`;
        revoke.disabled = disabled || !assignment.enabled;
        revoke.onclick = () => void this.revoke(assignment.id);
        row.append(revoke);
        current.append(row);
      });
    main.append(current);
    this.root.append(main);
  }
}

if (!customElements.get(elementName))
  customElements.define(elementName, RemoteAccessSettingsPage);
