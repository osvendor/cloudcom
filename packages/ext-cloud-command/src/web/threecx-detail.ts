import type {
  DetailValue,
  ThreeCxDetail,
  ThreeCxDetailChanges,
} from "../threecx/detail-contract";
export type DetailTab =
  | "general"
  | "forwarding"
  | "phone"
  | "blf"
  | "voicemail"
  | "schedule"
  | "talk"
  | "options";
const tabs: { id: DetailTab; label: string; primary?: boolean }[] = [
  { id: "general", label: "General", primary: true },
  { id: "forwarding", label: "Call Forwarding", primary: true },
  { id: "phone", label: "IP Phone", primary: true },
  { id: "blf", label: "BLF", primary: true },
  { id: "voicemail", label: "Voicemail", primary: true },
  { id: "schedule", label: "Schedule" },
  { id: "talk", label: "3CX Talk" },
  { id: "options", label: "View & Options" },
];
const editable = new Set<keyof ThreeCxDetailChanges>([
  "FirstName",
  "LastName",
  "EmailAddress",
  "Mobile",
  "OutboundCallerID",
  "VMEnabled",
  "VMEmailOptions",
  "VMPlayCallerID",
  "VMPlayMsgDateTime",
]);
const email: Record<string, string> = {
  None: "No email",
  Notification: "Notification only",
  Attachment: "Attach recording",
  AttachmentAndDelete: "Attach recording and delete",
};
const date: Record<string, string> = {
  None: "Do not announce",
  Play12Hr: "12-hour",
  Play24Hr: "24-hour",
};
const labels: Record<string, string> = {
  NoAnswerTimeout: "No answer timeout",
  RingMobile: "Ring mobile",
  AwayRouting: "Away routing",
};
export const detailTab = (v: string | null): DetailTab =>
  tabs.some((t) => t.id === v) ? (v as DetailTab) : "general";
export const isDirty = (d: ThreeCxDetailChanges) => Object.keys(d).length > 0;
const esc = (v: unknown) =>
  String(v ?? "—").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ]!,
  );
const present = (v: DetailValue | undefined) =>
  v === undefined || v === null || v === "" ? "—" : esc(v);
const bool = (v: DetailValue | undefined) =>
  v === true ? "Enabled" : v === false ? "Disabled" : "—";
const friendly = (key: string) =>
  labels[key] ??
  key
    .replace(/AvailableRoute[._]?/, "")
    .replace(/(Busy|NoAnswer|NotRegistered)(Internal|External)/, "$1 · $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " · ");
const group = (d: ThreeCxDetail) =>
  d.groups.find((g) => g.id === d.user.PrimaryGroupId) ?? null;
const note = (text: string) => `<p class="readonly-note">${esc(text)}</p>`;
const dl = (values: Record<string, DetailValue>) =>
  Object.keys(values).length
    ? `<dl class="detail-list">${Object.entries(values)
        .map(
          ([k, v]) =>
            `<div><dt>${esc(friendly(k))}</dt><dd>${present(v)}</dd></div>`,
        )
        .join("")}</dl>`
    : note("No information is available from this PBX.");
function input(
  d: ThreeCxDetail,
  draft: ThreeCxDetailChanges,
  key: Exclude<keyof ThreeCxDetailChanges, "ForwardingProfiles">,
  label: string,
  ok: boolean,
  type = "text",
) {
  const value = draft[key] ?? d.user[key] ?? "";
  return ok
    ? `<label>${label}<input data-detail-field="${key}" type="${type}" value="${esc(value)}"></label>`
    : `<div class="read-field"><dt>${label}</dt><dd>${present(value)}</dd></div>`;
}
function select(
  key: "VMEmailOptions" | "VMPlayMsgDateTime",
  label: string,
  map: Record<string, string>,
  value: unknown,
) {
  return `<label>${label}<select data-detail-field="${key}">${Object.entries(
    map,
  )
    .map(
      ([raw, text]) =>
        `<option value="${raw}" ${String(value ?? "") === raw ? "selected" : ""}>${text}</option>`,
    )
    .join("")}</select></label>`;
}
function forwarding(d: ThreeCxDetail) {
  const profiles = d.forwardingProfiles.length
    ? d.forwardingProfiles
        .map(
          (p) =>
            `<article class="detail-card"><h4>${esc(p.Name)}</h4>${dl(p.fields)}${p.destinations.length ? `<ul class="destination-list">${p.destinations.map((x) => `<li><strong>${esc(friendly(x.label))}</strong><span>${esc(friendly(x.type))}${x.target ? ` · ${esc(x.target)}` : ""}</span></li>`).join("")}</ul>` : note("No routing destinations are available for this profile.")}</article>`,
        )
        .join("")
    : note("Forwarding profiles are unavailable from this PBX.");
  const exceptions = d.forwardingExceptions.length
    ? `<h4>Exceptions</h4>${d.forwardingExceptions.map((x) => `<article class="detail-card">${dl(x.fields)}<p class="readonly-note">Destination: ${present(x.destination)}</p></article>`).join("")}`
    : "";
  return `<section><h3>Call Forwarding</h3>${profiles}${exceptions}${note(d.editable.forwarding ? "Ring controls are editable; routing destinations remain read-only." : "You have read-only access to forwarding settings.")}</section>`;
}
function extra(tab: DetailTab, user: ThreeCxDetail["user"]) {
  if (tab === "schedule")
    return `<section><h3>Schedule</h3>${note("Schedule settings are not available in Breeze yet.")}</section>`;
  const fields =
    tab === "talk"
      ? [
          ["WebMeetingFriendlyName", "Meeting display name"],
          ["WebMeetingApproveParticipants", "Approve participants"],
        ]
      : [
          ["HideInPhonebook", "Hide in phonebook"],
          ["MyPhone", "MyPhone"],
          ["SendEmailMissedCalls", "Send email for missed calls"],
        ];
  const rows = fields
    .filter(([k]) => user[k] !== undefined)
    .map(([k, l]) => `<div><dt>${l}</dt><dd>${present(user[k])}</dd></div>`)
    .join("");
  return `<section><h3>${tab === "talk" ? "3CX Talk" : "View & Options"}</h3>${rows ? `<dl class="detail-list">${rows}</dl>` : note("This PBX did not provide values for this section.")}</section>`;
}
export function renderThreeCxDetail(
  d: ThreeCxDetail,
  tab: DetailTab,
  draft: ThreeCxDetailChanges,
  busy: boolean,
  status: string,
  error: boolean,
) {
  const general = d.editable.general,
    vm = d.editable.voicemail,
    g = group(d),
    name =
      [d.user.FirstName, d.user.LastName].filter(Boolean).join(" ") ||
      d.user.Number;
  const section =
    tab === "general"
      ? `<div class="detail-sections"><section><h3>Identity</h3><div class="detail-fields">${input(d, draft, "FirstName", "First name", general)}${input(d, draft, "LastName", "Last name", general)}<div class="read-field"><dt>Extension number</dt><dd>${present(d.user.Number)}</dd></div>${input(d, draft, "EmailAddress", "Email", general, "email")}${input(d, draft, "Mobile", "Mobile", general, "tel")}</div></section><section><h3>Numbers</h3><div class="detail-fields">${input(d, draft, "OutboundCallerID", "Outbound caller ID", general)}</div>${note("Assigned DID numbers are not available here yet. Manage them in 3CX.")}</section><section><h3>Access</h3><dl class="detail-list"><div><dt>Main department</dt><dd>${esc(g?.name ?? "—")}</dd></div><div><dt>Department role</dt><dd>${esc(g?.role ?? "—")}</dd></div><div><dt>Account</dt><dd>${bool(d.user.Enabled)}</dd></div><div><dt>Two-factor authentication</dt><dd>${bool(d.user.Enable2FA)}</dd></div><div><dt>2FA enforcement</dt><dd>${bool(d.user.Require2FA)}</dd></div></dl>${note("Use 3CX to reset passwords or generate a setup QR code.")}</section></div>`
      : tab === "forwarding"
        ? forwarding(d)
        : tab === "phone"
          ? `<section><h3>IP Phone</h3>${d.phones.length ? `<div class="table-wrap"><table><thead><tr><th>Phone</th><th>Template</th><th>MAC</th><th>Interface</th></tr></thead><tbody>${d.phones.map((p) => `<tr><td>${esc(p.name)}</td><td>${present(p.template)}</td><td>${present(p.macAddress)}</td><td>${present(p.interface)}</td></tr>`).join("")}</tbody></table></div>` : note("No assigned phone metadata is available.")}${note("Use 3CX to provision, restart, or edit a phone.")}</section>`
          : tab === "blf"
            ? `<section><h3>BLF</h3>${d.blf.entries.length ? `<div class="table-wrap"><table><thead><tr><th>Position</th><th>Type</th><th>Target</th><th>Label</th></tr></thead><tbody>${d.blf.entries.map((x) => `<tr><td>${x.position}</td><td>${esc(x.type)}</td><td>${esc(x.target)}</td><td>${esc(x.label)}</td></tr>`).join("")}</tbody></table></div>` : note(d.blf.configured ? "BLF is configured, but its provider format is not supported yet." : "No BLF keys are configured.")}${note("Use 3CX to edit BLF keys.")}</section>`
            : tab === "voicemail"
              ? `<section><h3>Voicemail</h3><div class="detail-fields">${vm ? `<label class="check"><input data-detail-field="VMEnabled" type="checkbox" ${(draft.VMEnabled ?? d.user.VMEnabled) === true ? "checked" : ""}>Voicemail enabled</label>${select("VMEmailOptions", "Email delivery", email, draft.VMEmailOptions ?? d.user.VMEmailOptions)}<label class="check"><input data-detail-field="VMPlayCallerID" type="checkbox" ${(draft.VMPlayCallerID ?? d.user.VMPlayCallerID) === true ? "checked" : ""}>Play caller ID</label>${select("VMPlayMsgDateTime", "Message date playback", date, draft.VMPlayMsgDateTime ?? d.user.VMPlayMsgDateTime)}` : `<dl class="detail-list"><div><dt>Voicemail</dt><dd>${bool(d.user.VMEnabled)}</dd></div><div><dt>Email delivery</dt><dd>${esc(email[String(d.user.VMEmailOptions)] ?? "—")}</dd></div><div><dt>Play caller ID</dt><dd>${bool(d.user.VMPlayCallerID)}</dd></div><div><dt>Message date playback</dt><dd>${esc(date[String(d.user.VMPlayMsgDateTime)] ?? "—")}</dd></div></dl>`}</div><h4>Greetings</h4>${d.greetings.length ? `<ul class="destination-list">${d.greetings.map((x) => `<li><strong>${esc(x.name)}</strong><span>${present(x.profile)}</span></li>`).join("")}</ul>` : note("No greeting metadata is available.")}${note("Use 3CX to reset the voicemail PIN or manage greeting files.")}</section>`
              : extra(tab, d.user);
  const reg =
      d.user.IsRegistered === true
        ? "Registered"
        : d.user.IsRegistered === false
          ? "Not registered"
          : "Registration unavailable",
    primary = tabs.filter((t) => t.primary),
    more = tabs.filter((t) => !t.primary);
  return `<section class="threecx-detail" aria-labelledby="detail-title"><header class="detail-header"><button class="secondary compact" id="detail-back" type="button">Back to extensions</button><div class="detail-identity"><p class="eyebrow">Extension ${esc(d.user.Number)}</p><h2 id="detail-title">${esc(name)}</h2><p class="subtle">${reg} · ${esc(g?.name ?? "No department available")}</p></div><div class="detail-actions"><span data-detail-dirty>${isDirty(draft) ? "Pending changes" : ""}</span><button class="secondary" id="detail-discard" type="button" ${isDirty(draft) && !busy ? "" : "disabled"}>Discard</button><button id="detail-save" type="button" ${isDirty(draft) && (general || vm) && !busy ? "" : "disabled"}>${busy ? "Saving…" : "Save changes"}</button></div></header><p class="status" data-status data-error="${error}" aria-live="polite">${esc(status)}</p><nav class="detail-tabs" role="tablist" aria-label="Extension details">${primary.map((x) => `<button id="threecx-detail-${x.id}" role="tab" tabindex="${tab === x.id ? "0" : "-1"}" aria-selected="${tab === x.id}" aria-controls="threecx-detail-${x.id}-panel" data-detail-tab="${x.id}" type="button">${x.label}</button>`).join("")}<details class="more-tabs" ${more.some((x) => x.id === tab) ? "open" : ""}><summary>More</summary><div role="menu">${more.map((x) => `<button id="threecx-detail-${x.id}" role="menuitem" tabindex="0" data-detail-tab="${x.id}" type="button">${x.label}</button>`).join("")}</div></details></nav><div class="detail-panel" id="threecx-detail-${tab}-panel" role="tabpanel" aria-labelledby="threecx-detail-${tab}">${section}</div></section>`;
}
export function bindThreeCxDetail(
  root: ShadowRoot,
  h: {
    back(): void;
    discard(): void;
    save(): void;
    tab(tab: DetailTab): void;
    change(key: keyof ThreeCxDetailChanges, value: string | boolean): void;
  },
) {
  root.querySelector("#detail-back")?.addEventListener("click", h.back);
  root.querySelector("#detail-discard")?.addEventListener("click", h.discard);
  root.querySelector("#detail-save")?.addEventListener("click", h.save);
  const all = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-detail-tab]"),
    ],
    primary = all.filter((x) => x.closest(".more-tabs") === null);
  all.forEach((b) => {
    b.addEventListener("click", () =>
      h.tab(detailTab(b.dataset.detailTab ?? null)),
    );
    b.addEventListener("keydown", (e) => {
      if (!primary.includes(b)) return;
      let i = primary.indexOf(b);
      if (e.key === "ArrowRight") i = (i + 1) % primary.length;
      else if (e.key === "ArrowLeft")
        i = (i + primary.length - 1) % primary.length;
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = primary.length - 1;
      else return;
      e.preventDefault();
      const nextTab = detailTab(primary[i]!.dataset.detailTab ?? null);
      h.tab(nextTab);
      root
        .querySelector<HTMLButtonElement>(`[data-detail-tab="${nextTab}"]`)
        ?.focus();
    });
  });
  root
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "[data-detail-field]",
    )
    .forEach((x) =>
      x.addEventListener(
        x instanceof HTMLInputElement && x.type === "checkbox"
          ? "change"
          : "input",
        () => {
          const key = x.dataset.detailField as keyof ThreeCxDetailChanges;
          if (editable.has(key))
            h.change(
              key,
              x instanceof HTMLInputElement && x.type === "checkbox"
                ? x.checked
                : x.value,
            );
        },
      ),
    );
}
export const detailStyles =
  ".threecx-detail{margin-top:1rem}.detail-header{align-items:center;display:grid;gap:1rem;grid-template-columns:auto 1fr auto}.detail-identity h2{font-size:1.4rem}.detail-actions{align-items:center;display:flex;gap:.5rem}.detail-actions [data-detail-dirty]{color:hsl(var(--warning-strong));font-size:.82rem}.detail-tabs{align-items:center;border-bottom:1px solid hsl(var(--border));display:flex;gap:.2rem;margin:1rem 0;overflow:visible}.detail-tabs>button,.more-tabs summary{background:transparent;border-radius:0;color:hsl(var(--muted-foreground));min-height:2.5rem;padding:.5rem .75rem;white-space:nowrap}.detail-tabs>button[aria-selected=true]{border-bottom:2px solid hsl(var(--primary));color:hsl(var(--foreground))}.more-tabs{border:0;margin:0 0 0 auto;padding:0;position:relative}.more-tabs summary{cursor:pointer;font-weight:700;list-style:none}.more-tabs [role=menu]{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);box-shadow:0 6px 18px hsl(var(--foreground)/.14);display:none;min-width:13rem;padding:.25rem;position:absolute;right:0;top:100%;z-index:4}.more-tabs[open] [role=menu]{display:block}.more-tabs button{background:transparent;color:hsl(var(--foreground));display:block;margin:0;text-align:left;width:100%}.more-tabs button:hover{background:hsl(var(--accent))}.detail-panel{max-width:1000px}.detail-sections{display:grid;gap:1.5rem}.detail-panel section{border:1px solid hsl(var(--border));border-radius:var(--radius,.5rem);padding:1rem}.detail-panel h3,.detail-panel h4{margin:.1rem 0 1rem}.detail-panel h4{margin-top:1.25rem}.detail-fields{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}.read-field{display:grid;gap:.4rem}.read-field dt,.detail-list dt{color:hsl(var(--muted-foreground));font-size:.78rem;font-weight:700;text-transform:uppercase}.read-field dd{margin:0;overflow-wrap:anywhere}.detail-card{border-top:1px solid hsl(var(--border));padding:1rem 0}.detail-card:first-of-type{border-top:0;padding-top:0}.destination-list{display:grid;gap:.45rem;list-style:none;margin:1rem 0;padding:0}.destination-list li{align-items:baseline;display:flex;gap:.5rem;justify-content:space-between}.destination-list span{color:hsl(var(--muted-foreground));overflow-wrap:anywhere}@media(max-width:700px){.detail-header{align-items:stretch;grid-template-columns:1fr}.detail-actions{flex-wrap:wrap}.detail-tabs{margin-left:-1rem;margin-right:-1rem;flex-wrap:wrap;padding:0 1rem}.more-tabs{margin-left:0}.more-tabs [role=menu]{left:0;right:auto}.destination-list li{align-items:flex-start;flex-direction:column;gap:.1rem}}";
