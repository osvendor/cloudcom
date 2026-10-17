import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialDocumentsPage } from "./documents";

const item = { id: "doc/a", name: "Network notes", filename: "notes.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sourceOrganization: "Example", sourceId: "42", sha256: "hash", sizeBytes: 1024, sheetCount: 2, createdAt: "2026-01-01" };
const preview = { document: item, sheets: [{ name: "Notes", rows: [{ row: 2, cells: [{ column: "A", text: "password <img src=x onerror=alert(1)>" }] }], imageCount: 1 }, { name: "Empty", rows: [], imageCount: 0 }], previewTruncated: false };
const nativePreview = { document: item, sheets: [{ name: "Imported notes", imageCount: 0, rows: [
  { row: 1, cells: [{ column: "A", text: "Network" }] },
  { row: 2, cells: [{ column: "A", text: "Router is in the closet." }] },
  { row: 5, cells: [{ column: "A", text: "Email" }] },
  { row: 6, cells: [{ column: "A", text: "Username" }, { column: "B", text: "synthetic@example.invalid" }] },
  { row: 7, cells: [{ column: "A", text: "Password: synthetic-only" }] },
  { row: 10, cells: [{ column: "A", text: "someone@example.invalid" }, { column: "B", text: "synthetic-opaque" }] },
] }, { name: "Empty", imageCount: 0, rows: [] }], previewTruncated: false };
const syntheticImage = { id: "drawing:1", row: 3, column: "B", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYoQAAAAASUVORK5CYII=" };
const imagePreview = { ...nativePreview, sheets: [
  { ...nativePreview.sheets[0], images: [syntheticImage, { ...syntheticImage, id: "drawing:2", row: 8 }], imageCount: 2, imagesOmitted: 0 },
  { name: "Image only", rows: [], imageCount: 1, images: [{ ...syntheticImage, row: null, column: null }] },
] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (el: CredentialDocumentsPage, text: string) => Array.from(el.shadowRoot!.querySelectorAll("button")).find((b) => b.textContent === text)!;
const setup = async (request: (path: string, init?: RequestInit) => Promise<Response>, org = "org/a") => { const el = new CredentialDocumentsPage(); el.context = { organizationId: org, clientName: "Example client" }; el.hostApi = { request }; document.body.append(el); await tick(); return el; };

describe("client documentation", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("searches only document metadata in the host client and disables caching", async () => {
    const request = vi.fn(async () => response({ documents: [] })); const el = await setup(request);
    const input = el.shadowRoot!.querySelector("input")!; input.value = "vpn & notes"; button(el, "Search").click(); await tick();
    expect(request).toHaveBeenLastCalledWith("/orgs/org%2Fa/documents?q=vpn%20%26%20notes", { cache: "no-store" });
    expect(el.shadowRoot!.textContent).toContain("Client: Example client"); expect(el.shadowRoot!.textContent).toContain("No documentation found for this client."); expect(el.shadowRoot!.querySelector("select")).toBeNull();
  });

  it("shows raw selectable text safely and all sheets together without extra controls", async () => {
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? preview : { documents: [item] }));
    button(el, "Network notes").click(); await tick();
    expect(el.shadowRoot!.textContent).toContain("<img src=x onerror=alert(1)>"); expect(el.shadowRoot!.querySelector("img")).toBeNull();
    expect(el.shadowRoot!.textContent).toContain("1 embedded image is unavailable in this preview.");
    expect(el.shadowRoot!.textContent).toContain("This sheet is empty.");
    expect([...el.shadowRoot!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Back", "Download original"]);
    expect(el.shadowRoot!.querySelector("[contenteditable]")).toBeNull();
    button(el, "Back").click(); expect(el.shadowRoot!.querySelector("[aria-label='Document reader']")).toBeNull();
  });

  it("clears the loaded document immediately on client change", async () => {
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? preview : { documents: [item] })); button(el, "Network notes").click(); await tick();
    expect(el.shadowRoot!.textContent).toContain("<img src=x");
    el.context = { organizationId: "other", clientName: "Other" }; expect(el.shadowRoot!.textContent).not.toContain("<img src=x"); expect(el.shadowRoot!.textContent).toContain("Client: Other");
  });

  it("discards in-flight document reads when client changes or component disconnects", async () => {
    let resolve!: (r: Response) => void;
    const el = await setup(async (path) => path.endsWith("/doc%2Fa") ? new Promise<Response>((r) => { resolve = r; }) : response({ documents: [item] }));
    button(el, "Network notes").click(); el.context = { organizationId: "other" }; resolve(response(preview)); await tick(); expect(el.shadowRoot!.textContent).not.toContain("<img src=x");
    button(el, "Network notes").click(); el.remove(); resolve(response(preview)); await tick(); expect(el.shadowRoot!.textContent).not.toContain("<img src=x");
  });

  it("shows permission and MFA guidance without leaking error response contents", async () => {
    const el = await setup(async () => response({ error: "private backend details" }, 403));
    expect(el.shadowRoot!.querySelector("[role=alert]")!.textContent).toContain("permission to reveal credentials"); expect(el.shadowRoot!.textContent).not.toContain("private backend");
  });

  it("does not echo untrusted network exceptions", async () => {
    const el = await setup(async () => { throw new Error("private connection details"); });
    expect(el.shadowRoot!.querySelector("[role=alert]")!.textContent).toBe("Could not load documentation. Try again.");
    expect(el.shadowRoot!.textContent).not.toContain("private connection");
  });

  it("downloads through scoped host request and revokes its object URL", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"); const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const request = vi.fn(async (path: string) => path.endsWith("/download") ? new Response(new Blob(["workbook"])) : response(path.endsWith("/doc%2Fa") ? preview : { documents: [item] }));
    const el = await setup(request); button(el, "Network notes").click(); await tick(); button(el, "Download original").click(); await tick();
    expect(request).toHaveBeenLastCalledWith("/orgs/org%2Fa/documents/doc%2Fa/download", { cache: "no-store" }); expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce();
    el.context = { organizationId: "other" }; expect(revoke).toHaveBeenCalledWith("blob:test");
  });

  it("does not start a stale download after the client changes", async () => {
    let resolve!: (r: Response) => void;
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const el = await setup(async (path) => path.endsWith("/download") ? new Promise<Response>((r) => { resolve = r; }) : response(path.endsWith("/doc%2Fa") ? preview : { documents: [item] }));
    button(el, "Network notes").click(); await tick(); button(el, "Download original").click(); el.context = { organizationId: "other" }; resolve(new Response(new Blob(["workbook"]))); await tick();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps authorized text visible while reading and switching browser focus", async () => {
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? nativePreview : { documents: [item] })); button(el, "Network notes").click(); await tick();
    vi.useFakeTimers(); vi.advanceTimersByTime(60_000);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
    expect(el.shadowRoot!.textContent).toContain("Password: synthetic-only");
    expect(el.shadowRoot!.textContent).toContain("synthetic-opaque");
  });

  it("interleaves text and inline images by row and column, including image-only sheets", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:embedded");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const mixed = { ...imagePreview, sheets: [{ ...imagePreview.sheets[0], rows: [...imagePreview.sheets[0]!.rows, { row: 3, cells: [{ column: "C", text: "After image" }, { column: "A", text: "Before image" }] }] }, imagePreview.sheets[1]] };
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? mixed : { documents: [item] })); button(el, "Network notes").click(); await tick();
    expect(el.shadowRoot!.querySelectorAll("img")).toHaveLength(3);
    const row = el.shadowRoot!.querySelector('[data-row="3"]')!;
    expect([...row.children].map((cell) => (cell as HTMLElement).dataset.column)).toEqual(["A", "B", "C"]);
    expect(row.children[1]!.querySelector("img")).not.toBeNull();
    expect(el.shadowRoot!.textContent).toContain("Original image position unavailable");
    expect(create.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect([...el.shadowRoot!.querySelectorAll(".note-sheet:first-child .note-line")].map((line) => Number((line as HTMLElement).dataset.row))).toEqual([1,2,3,5,6,7,8,10]);
  });

  it("revokes image resources on close, client changes and unmount", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:embedded"); const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? imagePreview : { documents: [item] })); button(el, "Network notes").click(); await tick();
    button(el, "Back").click(); expect(revoke).toHaveBeenCalledWith("blob:embedded"); expect(el.shadowRoot!.querySelector("img")).toBeNull();
    button(el, "Network notes").click(); await tick(); revoke.mockClear();
    el.context = { organizationId: "other" }; expect(revoke).toHaveBeenCalledWith("blob:embedded"); expect(el.shadowRoot!.querySelector("img")).toBeNull(); await tick();
    button(el, "Network notes").click(); await tick(); revoke.mockClear(); el.remove(); expect(revoke).toHaveBeenCalledWith("blob:embedded"); expect(el.shadowRoot!.querySelector("img")).toBeNull();
  });

  it("does not render SVG, remote URLs or mislabeled image bytes", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:embedded");
    const unsafe = { ...imagePreview, sheets: [{ ...imagePreview.sheets[0], images: [
      { ...syntheticImage, mimeType: "image/svg+xml", dataBase64: btoa('<svg onload="alert(1)"/>') },
      { ...syntheticImage, dataBase64: "https://example.invalid/image.png" },
      { ...syntheticImage, dataBase64: btoa("<svg/>") },
    ], imageCount: 3 }] };
    const el = await setup(async (path) => response(path.endsWith("/doc%2Fa") ? unsafe : { documents: [item] })); button(el, "Network notes").click(); await tick();
    expect(create).not.toHaveBeenCalled(); expect(el.shadowRoot!.querySelector("img")).toBeNull(); expect(el.shadowRoot!.textContent).toContain("This image could not be displayed.");
  });
});
