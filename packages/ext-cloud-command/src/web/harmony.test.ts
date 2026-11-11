import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCommandHarmonyPage } from "./harmony";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = (organizationId = "org-a") => ({
  contractVersion: 1 as const,
  extensionName: "cloudcommand",
  path: "/extensions/cloudcommand/harmony",
  organizationId,
});
const status = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  connected: false,
  enabled: false,
  canConfigure: true,
  version: null,
  region: "us",
  checkedAt: null,
  status: "not_connected",
  errorCode: null,
  mappings: [],
  ...overrides,
});
const inventory = { computers: [], checkedAt: null, stale: true, devices: [] };
const pathOf = (path: string) => path.split("?")[0];
function mount(
  request: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const page = new CloudCommandHarmonyPage();
  page.context = context();
  page.hostApi = { request };
  document.body.append(page);
  return page;
}
async function reader(path: string) {
  return Response.json(
    pathOf(path) === "/harmony/connection" ? status() : inventory,
  );
}
afterEach(() => document.body.replaceChildren());

describe("Harmony page", () => {
  it("loads scoped state and never renders stored credentials", async () => {
    const request = vi.fn(reader);
    const page = mount(request);
    await flush();
    expect(request.mock.calls.map(([p]) => pathOf(p))).toEqual([
      "/harmony/connection",
      "/harmony/inventory",
    ]);
    expect(page.shadowRoot!.querySelector("#accessKey")).toBeTruthy();
    expect(page.shadowRoot!.textContent).not.toContain("stored-secret");
    expect(request.mock.calls[0][0]).toContain("orgId=org-a");
  });

  it("hides mapping removal controls from readers", async () => {
    const page = mount(async (path) =>
      pathOf(path) === "/harmony/connection"
        ? Response.json(
            status({
              canConfigure: false,
              mappings: [{ kind: "endpoint", externalId: "endpoint-1" }],
            }),
          )
        : reader(path),
    );
    await flush();
    expect(page.shadowRoot!.querySelector("[data-remove]")).toBeNull();
    expect(page.shadowRoot!.querySelector("#save")).toBeNull();
  });

  it("keeps reader linking read-only and preserves unknown cumulative counts", async () => {
    const page = mount(async (path) => {
      if (pathOf(path) === "/harmony/connection")
        return Response.json(status({ canConfigure: false }));
      return Response.json({
        computers: [
          {
            id: "c-1",
            name: "Laptop",
            deviceId: null,
            antiMalwareStatus: null,
            engineStatus: null,
            clientVersion: null,
            lastConnectedAt: null,
            infectedCount: null,
            quarantinedCount: null,
          },
        ],
        checkedAt: "2026-10-15T12:00:00Z",
        stale: false,
        devices: [],
      });
    });
    await flush();
    expect(page.shadowRoot!.querySelector("#link-device")).toBeNull();
    expect(page.shadowRoot!.textContent).toContain("Unlinked");
    expect(page.shadowRoot!.textContent).toContain(
      "Unknown infected cumulative · Unknown quarantined cumulative",
    );
  });

  it("saves credentials without prefilled or echoed secrets and surfaces errors", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (pathOf(path) === "/harmony/connection" && init?.method === "PUT")
        return Response.json({ error: "harmony_auth_failed" }, { status: 502 });
      return reader(path);
    });
    const page = mount(request);
    await flush();
    (page.shadowRoot!.querySelector("#clientId") as HTMLInputElement).value =
      "client-1";
    (page.shadowRoot!.querySelector("#accessKey") as HTMLInputElement).value =
      "entered-secret";
    (page.shadowRoot!.querySelector("#save") as HTMLButtonElement).click();
    await flush();
    await flush();
    const call = request.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      clientId: "client-1",
      accessKey: "entered-secret",
    });
    expect(page.shadowRoot!.textContent).toContain("harmony_auth_failed");
  });

  it("discovers exact scopes, saves mappings, syncs, and links an endpoint", async () => {
    const calls: string[] = [];
    let linkedDeviceId: string | null = null;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(pathOf(path));
      if (pathOf(path) === "/harmony/connection" && init?.method === "PUT")
        return Response.json(
          status({
            connected: true,
            enabled: true,
            version: 1,
            region: "us",
            status: "ready",
          }),
        );
      if (pathOf(path) === "/harmony/connection")
        return Response.json(
          status({
            connected: true,
            enabled: true,
            version: 1,
            status: "ready",
          }),
        );
      if (pathOf(path) === "/harmony/discover")
        return Response.json({
          version: 1,
          groups: [{ id: "g-1", name: "Custom", type: "GROUP" }],
          computers: [{ id: "c-1", name: "Laptop" }],
        });
      if (pathOf(path) === "/harmony/mappings")
        return Response.json(
          status({
            connected: true,
            enabled: true,
            version: 1,
            status: "ready",
            mappings: JSON.parse(String(init?.body)).mappings,
          }),
        );
      if (pathOf(path) === "/harmony/sync")
        return Response.json({
          checkedAt: "2026-10-15T12:00:00Z",
          count: 1,
          conflictedEndpointCount: 0,
          unavailableScopeCount: 0,
        });
      if (pathOf(path) === "/harmony/inventory")
        return Response.json({
          computers: [
            {
              id: "c-1",
              name: "Laptop",
              deviceId: linkedDeviceId,
              antiMalwareStatus: "Protected",
              engineStatus: "Running",
              clientVersion: "1.2",
              lastConnectedAt: "2026-10-15T12:00:00Z",
              infectedCount: 2,
              quarantinedCount: 1,
            },
          ],
          checkedAt: "2026-10-15T12:00:00Z",
          stale: false,
          devices: [{ id: "d-1", name: "Breeze Laptop" }],
        });
      if (pathOf(path) === "/harmony/link") {
        linkedDeviceId = JSON.parse(String(init?.body)).deviceId;
        return Response.json({ success: true });
      }
      return reader(path);
    });
    const page = mount(request);
    await flush();
    (page.shadowRoot!.querySelector("#discover") as HTMLButtonElement).click();
    await flush();
    await flush();
    (page.shadowRoot!.querySelector("#mapping") as HTMLSelectElement).value =
      "endpoint:c-1";
    (
      page.shadowRoot!.querySelector("#addMapping") as HTMLButtonElement
    ).click();
    (
      page.shadowRoot!.querySelector("#saveMappings") as HTMLButtonElement
    ).click();
    await flush();
    await flush();
    expect(calls).toContain("/harmony/mappings");
    (page.shadowRoot!.querySelector("#sync") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(page.shadowRoot!.textContent).toContain("Laptop");
    const select = page.shadowRoot!.querySelector(
      "#link-device",
    ) as HTMLSelectElement;
    select.value = "d-1";
    select.dispatchEvent(new Event("change"));
    await flush();
    await flush();
    expect(calls).toContain("/harmony/link");
    expect(
      (page.shadowRoot!.querySelector("#link-device") as HTMLSelectElement)
        .value,
    ).toBe("d-1");
  });

  it("ignores late discovery and mutation results after an organization switch", async () => {
    let resolveDiscovery!: (response: Response) => void;
    const request = vi.fn(async (path: string) => {
      if (pathOf(path) === "/harmony/discover")
        return new Promise<Response>((resolve) => {
          resolveDiscovery = resolve;
        });
      return reader(path);
    });
    const page = mount(request);
    await flush();
    (page.shadowRoot!.querySelector("#discover") as HTMLButtonElement).click();
    await flush();
    page.context = context("org-b");
    resolveDiscovery(
      Response.json({
        version: 1,
        groups: [{ id: "old", name: "Old client", type: "GROUP" }],
        computers: [],
      }),
    );
    await flush();
    await flush();
    expect(page.shadowRoot!.textContent).not.toContain("Old client");
    expect(page.shadowRoot!.textContent).not.toContain("old");
  });

  it("reloads the new organization while an old mutation is pending", async () => {
    let resolveSave!: (response: Response) => void;
    let reads = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (pathOf(path) === "/harmony/connection" && init?.method === "PUT")
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      if (pathOf(path) === "/harmony/connection") {
        reads++;
        return Response.json(
          status({ canConfigure: reads === 1, connected: false }),
        );
      }
      return reader(path);
    });
    const page = mount(request);
    await flush();
    (page.shadowRoot!.querySelector("#save") as HTMLButtonElement).click();
    await flush();
    page.context = context("org-b");
    await flush();
    expect(page.shadowRoot!.querySelector("#save")).toBeNull();
    resolveSave(
      Response.json(
        status({
          canConfigure: true,
          connected: true,
          enabled: true,
          status: "ready",
        }),
      ),
    );
    await flush();
    expect(page.shadowRoot!.querySelector("#save")).toBeNull();
    expect(
      request.mock.calls.filter(([p]) => pathOf(p) === "/harmony/connection"),
    ).toHaveLength(3);
  });
});
