import type { ExtensionHostApi } from "@breeze/extension-web-sdk";

type DocumentMetadata = { id: string; name: string; filename: string; mimeType: string; sourceOrganization: string; sourceId: string; sha256: string; sizeBytes: number; sheetCount: number; createdAt: string };
type SheetImage = { id: string; row: number | null; column: string | null; mimeType: string; dataBase64: string };
type Sheet = { name: string; rows: { row: number; cells: { column: string; text: string }[] }[]; imageCount: number; images?: SheetImage[]; imagesOmitted?: number };
type Preview = { document: DocumentMetadata; sheets: Sheet[]; previewTruncated: boolean };
class DocumentationRequestError extends Error {}
const errorMessage = (error: unknown): string => error instanceof DocumentationRequestError ? error.message : "Could not load documentation. Try again.";
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };

export class CredentialDocumentsPage extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private api: ExtensionHostApi | null = null;
  private org = "";
  private client = "";
  private revision = 0;
  private operation = 0;
  private query = "";
  private documents: DocumentMetadata[] = [];
  private preview: Preview | null = null;
  private status = "Choose a client to view documentation.";
  private error = false;
  private busy = false;
  private downloadBusy = false;
  private urls = new Set<string>();
  private imageUrls = new Set<string>();

  set context(value: unknown) {
    const context = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const org = typeof context.organizationId === "string" ? context.organizationId : "";
    this.client = typeof context.clientName === "string" ? context.clientName : "";
    if (org !== this.org) { this.clear(); this.org = org; this.query = ""; if (this.isConnected) void this.load(); else this.render(); }
    else this.render();
  }
  set hostApi(value: ExtensionHostApi | null) {
    this.clear(); this.api = value && typeof value.request === "function" ? value : null;
    if (this.isConnected) void this.load();
  }
  connectedCallback(): void { void this.load(); }
  disconnectedCallback(): void { this.clear(); this.render(); }
  private clearImageUrls(): void { this.imageUrls.forEach((url) => URL.revokeObjectURL(url)); this.imageUrls.clear(); }
  private clear(): void {
    this.revision++; this.operation++; this.documents = []; this.preview = null; this.busy = false; this.downloadBusy = false;
    this.clearImageUrls();
    this.urls.forEach((url) => URL.revokeObjectURL(url)); this.urls.clear();
  }
  private path(suffix = ""): string { return `/orgs/${encodeURIComponent(this.org)}/documents${suffix}`; }
  private current(revision: number, operation?: number): boolean { return this.isConnected && this.revision === revision && (operation === undefined || this.operation === operation); }
  private async request(path: string): Promise<Response> {
    if (!this.api) throw new DocumentationRequestError("Documentation service is unavailable.");
    const response = await this.api.request(path, { cache: "no-store" });
    if (!response.ok) throw new DocumentationRequestError(response.status === 401 || response.status === 403
      ? "Documentation access requires permission to reveal credentials and any required MFA verification."
      : "Could not load this documentation. Try again.");
    return response;
  }
  private async load(): Promise<void> {
    this.clear(); const revision = this.revision;
    this.error = false;
    if (!this.api || !this.org) { this.status = "Choose a client to view documentation."; this.render(); return; }
    this.busy = true; this.status = "Loading documentation…"; this.render();
    try {
      const response = await this.request(this.path(this.query ? `?q=${encodeURIComponent(this.query)}` : ""));
      const body = await response.json() as { documents: DocumentMetadata[] };
      if (!this.current(revision)) return;
      this.documents = Array.isArray(body.documents) ? body.documents : [];
      this.status = this.documents.length ? `${this.documents.length} document${this.documents.length === 1 ? "" : "s"} for this client.` : "No documentation found for this client.";
    } catch (error) { if (!this.current(revision)) return; this.error = true; this.status = errorMessage(error); }
    if (this.current(revision)) { this.busy = false; this.render(); }
  }
  private async open(item: DocumentMetadata): Promise<void> {
    const revision = this.revision, operation = ++this.operation;
    this.clearImageUrls(); this.preview = null; this.busy = true; this.error = false; this.status = "Opening documentation…"; this.render();
    try {
      const response = await this.request(this.path(`/${encodeURIComponent(item.id)}`));
      const body = await response.json() as Preview;
      if (!this.current(revision, operation)) return;
      this.preview = body; this.status = "Documentation opened.";
    } catch (error) { if (!this.current(revision, operation)) return; this.error = true; this.status = errorMessage(error); }
    if (this.current(revision, operation)) { this.busy = false; this.render(); }
  }
  private async download(item: DocumentMetadata): Promise<void> {
    const revision = this.revision;
    this.downloadBusy = true; this.error = false; this.render();
    try {
      const response = await this.request(this.path(`/${encodeURIComponent(item.id)}/download`));
      const blob = await response.blob();
      if (!this.current(revision)) return;
      const url = URL.createObjectURL(blob); this.urls.add(url);
      const link = node("a"); link.href = url; link.download = item.filename.replace(/[\x00-\x1f\x7f/\\]/g, "_") || "documentation.xlsx";
      link.hidden = true; this.root.append(link); link.click(); link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); }, 1_000);
      this.status = "Original workbook download started.";
    } catch (error) { if (!this.current(revision)) return; this.error = true; this.status = errorMessage(error); }
    if (this.current(revision)) { this.downloadBusy = false; this.render(); }
  }
  private button(label: string, click: () => void, disabled = false): HTMLButtonElement {
    const button = node("button", label); button.type = "button"; button.disabled = disabled; button.onclick = click; return button;
  }
  private renderImage(image: SheetImage, index: number): HTMLElement {
    const figure = node("figure"); figure.className = "embedded-image";
    const anchor = Number.isInteger(image.row) && image.row! > 0 && typeof image.column === "string" && /^[A-Z]{1,3}$/.test(image.column) ? `${image.column}${image.row}` : "unpositioned";
    if (anchor === "unpositioned") figure.append(node("figcaption", "Original image position unavailable"));
      try {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType) || typeof image.dataBase64 !== "string" || image.dataBase64.length > 12_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) throw new Error();
        const raw = atob(image.dataBase64), bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        const starts = (signature: number[]) => signature.every((byte, offset) => bytes[offset] === byte);
        const valid = image.mimeType === "image/png" ? starts([137,80,78,71,13,10,26,10]) : image.mimeType === "image/jpeg" ? starts([255,216,255]) : image.mimeType === "image/gif" ? /^GIF8[79]a/.test(raw) : raw.startsWith("RIFF") && raw.slice(8,12) === "WEBP";
        if (!valid) throw new Error();
        const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType })); this.imageUrls.add(url);
        const img = node("img"); img.alt = `Workbook image ${index + 1}, ${anchor}`; img.src = url;
        img.onerror = () => { URL.revokeObjectURL(url); this.imageUrls.delete(url); img.replaceWith(node("p", "This image could not be displayed. Download the original workbook to view it.")); };
        figure.append(img);
      } catch { figure.append(node("p", "This image could not be displayed. Download the original workbook to view it.")); }
    return figure;
  }
  private renderSheet(sheet: Sheet): HTMLElement {
    const container = node("article"); container.className = "note-sheet";
    container.append(node("h3", sheet.name));
    const images = sheet.images ?? [];
    const entries = sheet.rows.flatMap((row) => row.cells.map((cell) => ({ row: row.row, column: cell.column, text: cell.text, image: null as SheetImage | null, index: 0 })));
    images.forEach((image, index) => entries.push({ row: image.row ?? Number.MAX_SAFE_INTEGER, column: image.column ?? "", text: "", image, index }));
    const columnNumber = (column: string): number => /^[A-Z]{1,3}$/.test(column) ? [...column].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) : Number.MAX_SAFE_INTEGER;
    entries.sort((a, b) => a.row - b.row || columnNumber(a.column) - columnNumber(b.column));
    let rowNumber = -1, line: HTMLElement | null = null, column = "", cell: HTMLElement | null = null;
    for (const entry of entries) {
      if (entry.row !== rowNumber) { line = node("div"); line.className = "note-line"; line.dataset.row = String(entry.row); container.append(line); rowNumber = entry.row; column = ""; cell = null; }
      if (!cell || entry.column !== column) { cell = node("div"); cell.className = "note-cell"; cell.dataset.column = entry.column; line!.append(cell); column = entry.column; }
      if (entry.image) cell.append(this.renderImage(entry.image, entry.index));
      else cell.append(node("p", entry.text));
    }
    if (!entries.length) container.append(node("p", "This sheet is empty."));
    const omitted = sheet.imagesOmitted ?? Math.max(0, sheet.imageCount - images.length);
    if (omitted > 0) container.append(node("p", `${omitted} embedded image${omitted === 1 ? " is" : "s are"} unavailable in this preview. Download the original workbook to view all images.`));
    return container;
  }
  private render(): void {
    this.clearImageUrls(); this.root.replaceChildren();
    const style = node("style"); style.textContent = `:host{display:block;font:15px system-ui;color:hsl(var(--foreground));background:hsl(var(--background));min-width:0}*{box-sizing:border-box}main{padding:24px;max-width:1100px;margin:auto}h1{margin:0;font-size:24px}h2{font-size:21px;margin:0;overflow-wrap:anywhere}h3{font-size:16px;margin:0 0 18px}p{overflow-wrap:anywhere}.muted{color:hsl(var(--muted-foreground))}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:16px 0}label{flex:1;min-width:150px}input,button{font:inherit;color:inherit;background:transparent;border:1px solid hsl(var(--border));border-radius:6px;padding:8px 12px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,.notepad:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}input{width:100%}.entry{display:block;width:100%;text-align:left;margin:8px 0;padding:14px}.notepad{user-select:text;cursor:text;border:1px solid hsl(var(--border));border-radius:8px;padding:28px;line-height:1.65;background:hsl(var(--background))}.note-sheet+.note-sheet{border-top:1px solid hsl(var(--border));margin-top:32px;padding-top:24px}.note-line{display:flex;gap:24px;align-items:flex-start;min-height:1.65em}.note-cell{min-width:0;flex:1}.note-cell p{white-space:pre-wrap;margin:0 0 8px}.embedded-image{margin:12px 0;max-width:100%}.embedded-image img{display:block;max-width:100%;height:auto}.embedded-image figcaption{font-size:12px;color:hsl(var(--muted-foreground))}[role=alert]{color:hsl(var(--destructive))}@media(max-width:600px){main{padding:12px}.notepad{padding:16px}.note-line{gap:12px;flex-wrap:wrap}.note-cell{flex-basis:160px}}`;
    this.root.append(style); const main = node("main"); main.append(node("h1", "Documentation"));
    const client = node("p", this.client ? `Client: ${this.client}` : "Client-scoped documentation"); client.className = "muted"; main.append(client);
    if (this.error || this.busy || !this.preview) { const status = node("p", this.status); status.setAttribute("role", this.error ? "alert" : "status"); main.append(status); }
    if (!this.preview) {
      const toolbar = node("form"); toolbar.className = "toolbar";
      const label = node("label"); const input = node("input"); input.type = "search"; input.value = this.query; input.placeholder = "Search documents"; input.setAttribute("aria-label", "Search document names"); label.append(input); toolbar.append(label);
      const search = () => { this.query = input.value; void this.load(); };
      toolbar.onsubmit = (event) => { event.preventDefault(); search(); };
      toolbar.append(this.button("Search", search, this.busy || !this.org)); main.append(toolbar);
      const list = node("section"); list.setAttribute("aria-label", "Client documents");
      this.documents.forEach((item) => { const entry = this.button(item.name, () => { void this.open(item); }, this.busy); entry.className = "entry"; list.append(entry); }); main.append(list);
    } else {
      const preview = this.preview;
      const heading = node("div"); heading.className = "toolbar";
      heading.append(this.button("Back", () => { this.operation++; this.clearImageUrls(); this.preview = null; this.status = "Choose a document."; this.render(); }), node("h2", preview.document.name), this.button(this.downloadBusy ? "Downloading�" : "Download original", () => { void this.download(preview.document); }, this.downloadBusy)); main.append(heading);
      const section = node("section"); section.className = "notepad"; section.tabIndex = 0; section.setAttribute("aria-label", "Document reader"); section.setAttribute("data-sentry-mask", "true");
      if (preview.previewTruncated) section.append(node("p", "This preview is shortened. Download the original workbook for all content."));
      preview.sheets.forEach((sheet) => section.append(this.renderSheet(sheet))); main.append(section);
    }
    this.root.append(main);
  }
}
if (!customElements.get("cloudcom-credential-documents-page")) customElements.define("cloudcom-credential-documents-page", CredentialDocumentsPage);
