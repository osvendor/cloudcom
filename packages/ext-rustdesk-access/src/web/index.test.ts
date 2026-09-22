import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteAccessSettingsPage } from "./index";

const response = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), {
    status: ok ? 200 : 403,
    headers: { "content-type": "application/json" },
  });

describe("remoteaccess-settings-page", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("accepts hostApi injection without recursive setter calls", async () => {
    const el = new RemoteAccessSettingsPage();
    const request = vi.fn(async (path: string) =>
      path.endsWith("/settings")
        ? response({
            enabled: true,
            webrtcEnabled: true,
            rustdeskEnabled: false,
          })
        : path.endsWith("/assignments")
          ? response({ assignments: [] })
          : response({ users: [], devices: [] }),
    );
    el.context = { organizationId: "org-1" };
    el.hostApi = { request };
    document.body.append(el);
    await Promise.resolve();
    expect(request).toHaveBeenCalled();
  });

  it("renders empty state and escapes script-like labels as text", async () => {
    const el = new RemoteAccessSettingsPage();
    el.context = { organizationId: "org-1" };
    el.hostApi = {
      request: async (path) =>
        path.endsWith("/settings")
          ? response({
              enabled: true,
              webrtcEnabled: true,
              rustdeskEnabled: true,
            })
          : path.endsWith("/assignments")
            ? response({ assignments: [] })
            : response({
                users: [
                  { id: "u", name: "<script>alert(1)</script>", email: "x@y" },
                ],
                devices: [],
              }),
    };
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.shadowRoot?.textContent).toContain("<script>alert(1)</script>");
    expect(el.shadowRoot?.querySelector("script")).toBeNull();
  });

  it("posts a grant for the selected user and device in the current organization", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      path.endsWith("/settings")
        ? response({
            enabled: true,
            webrtcEnabled: true,
            rustdeskEnabled: true,
          })
        : path.endsWith("/assignments")
          ? response({ assignments: [] })
          : response({
              users: [{ id: "u", name: "User", email: "u@y" }],
              devices: [{ id: "d", hostname: "pc" }],
            }),
    );
    const el = new RemoteAccessSettingsPage();
    el.context = { organizationId: "org-2" };
    el.hostApi = { request };
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const user = el.shadowRoot!.querySelector<HTMLSelectElement>(
      '[data-testid="remote-user"]',
    )!;
    const device = el.shadowRoot!.querySelector<HTMLSelectElement>(
      '[data-testid="remote-device"]',
    )!;
    user.value = "u";
    device.value = "d";
    el.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-testid="remote-grant"]',
    )!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = request.mock.calls.find(
      ([path, init]) =>
        String(path) === "/orgs/org-2/assignments" && init?.method === "POST",
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      portalUserId: "u",
      deviceId: "d",
    });
  });

  it("posts DELETE when revoking an assignment", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      path.endsWith("/settings")
        ? response({
            enabled: true,
            webrtcEnabled: true,
            rustdeskEnabled: true,
          })
        : path.endsWith("/assignments") && init?.method !== "DELETE"
          ? response({
              assignments: [
                {
                  id: "a1",
                  portalUserId: "u",
                  deviceId: "d",
                  enabled: true,
                  userName: "User",
                  hostname: "pc",
                },
              ],
            })
          : path.endsWith("/options")
            ? response({ users: [], devices: [] })
            : response({ success: true }),
    );
    const el = new RemoteAccessSettingsPage();
    el.context = { organizationId: "org-3" };
    el.hostApi = { request };
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    el.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-testid="remote-revoke-a1"]',
    )!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      request.mock.calls.some(
        ([path, init]) =>
          String(path) === "/orgs/org-3/assignments/a1" &&
          init?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("shows a failed mutation while retaining the current page state", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? response({ error: "Denied" }, false)
        : path.endsWith("/settings")
          ? response({
              enabled: true,
              webrtcEnabled: true,
              rustdeskEnabled: true,
            })
          : path.endsWith("/assignments")
            ? response({ assignments: [] })
            : response({
                users: [{ id: "u", name: "User", email: "u@y" }],
                devices: [{ id: "d", hostname: "pc" }],
              }),
    );
    const el = new RemoteAccessSettingsPage();
    el.context = { organizationId: "org-4" };
    el.hostApi = { request };
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    el.shadowRoot!.querySelector<HTMLSelectElement>(
      '[data-testid="remote-user"]',
    )!.value = "u";
    el.shadowRoot!.querySelector<HTMLSelectElement>(
      '[data-testid="remote-device"]',
    )!.value = "d";
    el.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-testid="remote-grant"]',
    )!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.shadowRoot?.textContent).toContain("Denied");
  });

  it("does not let a deferred old organization response overwrite the new one", async () => {
    const oldResolvers: Array<(value: Response) => void> = [];
    const request = vi.fn((path: string) =>
      path.includes("org-old")
        ? new Promise<Response>((resolve) => {
            oldResolvers.push(resolve);
          })
        : Promise.resolve(
            path.endsWith("/settings")
              ? response({
                  enabled: false,
                  webrtcEnabled: false,
                  rustdeskEnabled: false,
                })
              : path.endsWith("/assignments")
                ? response({ assignments: [] })
                : response({
                    users: [
                      {
                        id: "new-user",
                        name: "New user",
                        email: "new@example.test",
                      },
                    ],
                    devices: [],
                  }),
          ),
    );
    const el = new RemoteAccessSettingsPage();
    el.hostApi = { request };
    el.context = { organizationId: "org-old" };
    document.body.append(el);
    el.context = { organizationId: "org-new" };
    await new Promise((resolve) => setTimeout(resolve, 0));
    oldResolvers.forEach((resolve, index) =>
      resolve(
        index === 0
          ? response({
              enabled: true,
              webrtcEnabled: true,
              rustdeskEnabled: true,
            })
          : index === 1
            ? response({
                assignments: [
                  {
                    id: "old",
                    portalUserId: "old-user",
                    deviceId: "old-device",
                    enabled: true,
                    userName: "Old user",
                    hostname: "old-pc",
                  },
                ],
              })
            : response({
                users: [
                  {
                    id: "old-user",
                    name: "Old user",
                    email: "old@example.test",
                  },
                ],
                devices: [],
              }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const checkbox = el.shadowRoot!.querySelector<HTMLInputElement>(
      'input[data-setting="webrtcEnabled"]',
    );
    expect(checkbox?.checked).toBe(false);
    expect(el.shadowRoot?.textContent).toContain("New user");
    expect(el.shadowRoot?.textContent).not.toContain("Old user");
  });

  it("shows denied responses as an error", async () => {
    const el = new RemoteAccessSettingsPage();
    el.context = { organizationId: "org-1" };
    el.hostApi = { request: async () => response({ error: "Denied" }, false) };
    document.body.append(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.shadowRoot?.textContent).toContain("Denied");
  });
});
