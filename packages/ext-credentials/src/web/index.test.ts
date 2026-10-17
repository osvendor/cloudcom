import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsPage } from "./index";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cloudcom-credentials-page", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("scopes search URLs to the current organization", async () => {
    const request = vi.fn(async (_path: string) => response({ credentials: [] }));
    const el = new CredentialsPage(); el.context = { organizationId: "org/a", clientName: "Acme" }; el.hostApi = { request }; document.body.append(el); await tick();
    const input = el.shadowRoot!.querySelector("input") as HTMLInputElement; input.value = "vpn"; el.shadowRoot!.querySelector("button")!.click(); await tick();
    expect(request.mock.calls.at(-1)?.[0]).toBe("/orgs/org%2Fa/credentials?q=vpn");
  });

  it("ignores stale organization responses and clears revealed secrets", async () => {
    let oldResolve!: (r: Response) => void;
    const request = vi.fn((path: string) => path.includes("old") ? new Promise<Response>((resolve) => { oldResolve = resolve; }) : Promise.resolve(response({ credentials: [{ id: "new", name: "New", hasPassword: true, hasOtp: false }] })));
    const el = new CredentialsPage(); el.hostApi = { request }; el.context = { organizationId: "old" }; document.body.append(el); el.context = { organizationId: "new" }; await tick();
    expect(el.shadowRoot?.textContent).toContain("New"); oldResolve(response({ credentials: [{ id: "old", name: "Old", hasPassword: true, hasOtp: false }] })); await tick(); expect(el.shadowRoot?.textContent).not.toContain("Old");
  });

  it("clears a loaded secret when the context changes", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => init?.method === "POST" ? response({ value: "super-secret" }) : response({ credentials: [{ id: "c", name: "Entry", hasPassword: true, hasOtp: false }] }));
    const el = new CredentialsPage(); el.hostApi = { request }; el.context = { organizationId: "one" }; document.body.append(el); await tick(); el.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label='Reveal password']")!.click(); await tick(); expect(el.shadowRoot?.textContent).toContain("super-secret"); el.context = { organizationId: "two" }; expect(el.shadowRoot?.textContent).not.toContain("super-secret");
  });

  it("does not turn an imported javascript URL into a link", async () => {
    const el = new CredentialsPage(); el.hostApi = { request: async () => response({ credentials: [{ id: "x", name: "Imported", url: "javascript:alert(1)", hasPassword: false, hasOtp: false }] }) }; el.context = { organizationId: "org" }; document.body.append(el); await tick();
    expect(el.shadowRoot?.querySelector("a")).toBeNull();
  });

  it("discards an in-flight reveal after the organization changes", async () => {
    let resolveReveal!: (r: Response) => void;
    const request = vi.fn((path: string, init?: RequestInit) => init?.method === "POST" ? new Promise<Response>((resolve) => { resolveReveal = resolve; }) : Promise.resolve(response({ credentials: [{ id: "x", name: "Entry", hasPassword: true, hasOtp: false }] })));
    const el = new CredentialsPage(); el.hostApi = { request }; el.context = { organizationId: "one" }; document.body.append(el); await tick(); el.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label='Reveal password']")!.click(); el.context = { organizationId: "two" }; resolveReveal(response({ value: "stale-secret" })); await tick(); expect(el.shadowRoot?.textContent).not.toContain("stale-secret");
  });
});
