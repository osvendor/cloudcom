# Microsoft 365 interaction contract

Applies to every Cloud Command Microsoft 365 directory action, not only user accounts.

- Put applicable actions inline with the directory record. Each opens one focused panel with the record identity and a single visible Close control.
- Load current values when the panel opens. Do not require a second Show/Manage click. External navigation and message-trace searches remain explicit.
- Show loading, empty, failed and partial states distinctly. A failed lookup must not erase an independently loaded list. Offer a scoped retry.
- Show existing collection entries before add controls. Place an accessible × action on each supported removable entry. Identify precisely what will be removed with an explicit action button. Do not require a redundant confirmation checkbox.
- A × removes the selected relationship or permission, never the account, group or mailbox itself. Preserve last-owner, inherited-license, dynamic-group, synced-object and incomplete-inventory restrictions.
- Do not show nonworking removal actions. Explain read-only items. Status switches and Turn off are appropriate for forwarding and automatic replies.
- Preserve all loaded settings when editing one value. Automatic replies have independent internal/external messages and external audience.
- Never populate an editable phone field with a masked number. Show the current masked value separately and identify the replacement field clearly.
- Scope asynchronous responses to the organization, record and panel-opening request. Close/reopen must clear obsolete loading state. An uncertain creation outcome must not invite duplicate submission.
- Keep controls within panel width with min-width:0, wrapping labels and bounded scrollable collections. Use compact consistent typography, spacing and right-aligned removal controls.
- Connections must distinguish configured capability from a successful live provider read. Do not present a hard-coded Pending/Ready label as health.

Validation: extension browser/server tests, TypeScript/build checks, read-only production verification and screenshots. Use only verified QA objects for any external write-and-restore test. Ordinary deployment follows docs/cloudcom-direct-code-deployment.md; no additional checkout, image or GitHub workflow is needed.

Audit coverage and acceptance evidence: ignored internal/m365-menu-audit-20260929.md. Known limitations must remain explicit rather than being mistaken for completed action support.

After a verified write, render returned current state immediately. Keep uncertain writes locked until a successful read; never replay a write to obtain confirmation. Group SMTP aliases and supported authentication methods use typed removal endpoints, preserving protected addresses and methods.

Message trace uses header-edge drag resizing with keyboard resize/reset and sticky headers. Quarantine release must resolve the exact trace to a unique quarantine identity and original recipient, confirm the recipient, read back the result, and never retry an uncertain write automatically. Add user offers generated/custom passwords and an independent force-change option; clear custom passwords on close, tenant change and uncertain submission.

Message trace (owner revision): keep result rows compact; subject/Details opens the right-hand message drawer. Automatically load events and quarantine independently. Release confirmation belongs inside the drawer, not expanded rows or a separate lower panel. Preserve only factual provider status and returned metadata.

Quarantine release: the message drawer uses one Release message button, with the recipient visible. No redundant confirmation checkbox. Preserve exact message/recipient matching, authorization, busy state and duplicate-release protection.

Action controls: no acknowledgement-only checkboxes before Save, Add, Remove or security action buttons. Keep true settings as checkboxes, such as forwarding copy, external senders and force password change. Preserve typed target checks for destructive or privileged actions. Membership entries use separate rows with consistent names, secondary management reasons and aligned removal actions.
