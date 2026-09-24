# CIPP native-source map: UI capability reference only

This is a read-only source audit. It describes what the pinned CIPP source implements; it does not assume or require a running CIPP instance.

## Pins and audit boundary

* UI: [`KelvinTegelaar/CIPP@e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e`](https://github.com/KelvinTegelaar/CIPP/tree/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e), 1,795 tracked blobs.
* API: [`KelvinTegelaar/CIPP-API@c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600`](https://github.com/KelvinTegelaar/CIPP-API/tree/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600), 4,024 tracked blobs.
* **Sampled exhaustively within the selected surfaces:** 4 list/detail roots, all 6 user-detail tabs, 1 group-detail tab, and 36 named CIPP API handlers referenced by these files (excluding the UI helper `/api/ApiCall`). This is not an exhaustive map of the 1,795/4,024-file repositories or every CIPP menu item.

## Navigation and configuration source of truth

[`src/layouts/config.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/layouts/config.jsx) exports `nativeMenuItems`, the nested main navigation inventory. Each entry carries a title, route path where applicable, permission patterns, and sometimes `scope: 'global'`. The file covers high-level sections including Dashboard, Identity Management, Tenant Administration, Security & Compliance, Copilot & AI, Intune, Email & Exchange, Teams & SharePoint, Tools, and CIPP settings. Feature flags may hide/swap menu paths; the file explicitly notes the Baselines vs classic Standards/Drift switch.

Relevant route roots:

* [`src/pages/identity/administration/users/index.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/index.jsx)
* [`src/pages/identity/administration/groups/index.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/groups/index.jsx)
* [`src/layouts/side-nav.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/layouts/side-nav.jsx) and [`src/layouts/mobile-nav.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/layouts/mobile-nav.jsx) render that configuration.

## User detail surface (6 configured tabs)

[`user/tabOptions.json`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/tabOptions.json) names six tabs. The table below is exhaustive for those tab route files, while endpoint lists are direct literals found in the file.

| Tab / UI source | Capability and direct API literals | Backend dependence indicated by pinned handler source |
|---|---|---|
| [View User](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/index.jsx) | Reads user, sign-in, roles; UI actions reset MFA and set default MFA. `ListUsers`, `ListUserSigninLogs`, `ListRoleAssignments`, `ListGraphBulkRequest`, `ExecResetMFA`, `ExecSetDefaultMFAMethod`. | `ListUsers` uses Microsoft Graph; optional logon details also uses Exchange Unified Audit Log. Sign-ins use Graph. Roles reads CIPP reporting DB. Bulk Graph is a Graph batch proxy. |
| [Edit User](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/edit.jsx) | User edit view and save: `ListUsers`, `EditUser`. | Handler is the API entrypoint for Entra user updates; underlying graph helper calls are in CIPP core/helper layers rather than named directly in this entrypoint. |
| [Exchange Settings](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/exchange.jsx) | Mailbox detail/rules/permissions/calendar/contact/OoO and trusted/blocked sender reads, plus 19 POST action definitions for aliases, rules, permissions, and sender management. | Mix of Exchange Online and Graph: direct `New-ExoRequest` appears in ListUserMailboxRules, ListCalendarPermissions, ListContactPermissions, ListUserTrustedBlockedSenders, and EditUserAliases; several permission actions combine Graph lookup with EXO. |
| [OneDrive Shortcuts](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/onedrive-shortcuts.jsx) | Shortcut inventory plus create/remove/migrate actions: `ListUserOneDriveShortcuts`, `ListSites`, `ExecOneDriveShortCut`, `ExecRemoveOneDriveShortCut`, `ExecMigrateOneDriveShortCuts`. | Shortcut inventory uses Graph. Site listing uses SharePoint/Graph and can use report data. Mutation handlers are separate CIPP entrypoints. |
| [Compromise Remediation](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/bec.jsx) | `execBECCheck` scan/action surface. | Handler starts a CIPP durable orchestrator and reads CIPP Azure-table data; it is a background-job capability rather than a simple synchronous Graph read. |
| [Conditional Access](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/users/user/conditional-access.jsx) | `ExecCACheck`, `ListGraphRequest`, `ListUsers`. | Conditional-access evaluation is exposed by the API entrypoint; generic Graph access is used for supporting reads. |

## Group detail and group-list surface

[`group/tabOptions.json`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/groups/group/tabOptions.json) contains one tab, [View Group](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/groups/group/index.jsx). It exposes group read/edit information and calls `ListGraphBulkRequest`, `ListGraphRequest`, `EditGroup`, `ExecGroupsDelete`, `ExecGroupsDeliveryManagement`, `ExecGroupsHideFromGAL`, `ExecSetCloudManaged`, `AddGroupTemplate`, and `AddGroupTeam`.

The group list is the richer action registry: [`groups/index.jsx`](https://github.com/KelvinTegelaar/CIPP/blob/e406c4fd5ebd5634cc3aeedcaf9ed98c3b1bb52e/src/pages/identity/administration/groups/index.jsx) has **11** direct POST action definitions and member/owner subtables. It reads `ListGroups`; it uses `ListGroups?groupID=...&members=true` and `owners=true` for nested views; and it adds/removes members/owners via `ExecGroupMembers`. Its visible mutations include create team/template, edit, member/owner changes, GAL visibility, group visibility, delivery management, cloud-management source, and delete.

Backend dependency facts from the mapped entrypoints:

* [`Invoke-ListGroups.ps1`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Groups/Invoke-ListGroups.ps1) uses Graph bulk/get and Exchange Online. It supports CIPP report-db reads and cached manual pagination.
* [`Invoke-EditGroup.ps1`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Groups/Invoke-EditGroup.ps1) mixes Graph bulk/get and EXO.
* Group members, team creation, templates, delivery/GAL management, source-of-authority, and deletion are independent API handlers. Several entrypoints delegate their implementation into CIPP core cmdlets; their entrypoint files alone should not be read as a complete dependency inventory.

## Corresponding API handler locations

The API uses a catch-all HTTP route. [`CIPPHttpTrigger/function.json`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/CIPPHttpTrigger/function.json) accepts all normal verbs and routes `{*CIPPEndpoint}`. The generated pinned [`Config/openapi.json`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Config/openapi.json) states that `/api/<Name>` resolves one-to-one to `Invoke-<Name>` and is rebuilt from entrypoint source.

The direct endpoint-to-handler mapping follows this reproducible path pattern:

`Modules/CIPPHTTP/Public/Entrypoints/HTTP Functions/<area>/Invoke-<endpoint>.ps1`

Examples with pinned files: [`ListUsers`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Users/Invoke-ListUsers.ps1), [`ListUserMailboxDetails`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Users/Invoke-ListUserMailboxDetails.ps1), [`ListSites`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Teams-Sharepoint/Invoke-ListSites.ps1), [`ExecBECCheck`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Users/Invoke-ExecBECCheck.ps1), and [`ExecGroupMembers`](https://github.com/KelvinTegelaar/CIPP-API/blob/c04bde0f4b53280c1ed21d838ba2c4bbcfc8a600/Modules/CIPPHTTP/Public/Entrypoints/HTTP%20Functions/Identity/Administration/Groups/Invoke-ExecGroupMembers.ps1).

## Recommended exact inventory method for full menu-depth coverage

For a complete, repeatable capability inventory at any pin:

1. Parse `src/layouts/config.jsx` with a JSX-capable AST parser, evaluate only the `nativeMenuItems` literal, recursively emit every node with `title`, `path`, permission patterns, scope, and nesting ancestry. Do not use regex: it misses nested objects and feature-flag commentary.
2. Parse all `src/pages/**/*.{js,jsx,ts,tsx}`. Convert the Next.js file path to a route, then statically collect API URL literals, `CippTablePage` sources, action labels/types/data, `rowOpen` links, and imported `tabOptions.json` data. Join each route to the navigation inventory and retain orphaned routes as non-menu surfaces.
3. Resolve feature visibility from the feature-configuration source used by the UI and record default/flag-gated paths separately; enumerate permission and tenant-scope gates rather than treating all paths as universally visible.
4. Parse pinned `CIPP-API/Config/openapi.json` for every exposed operation, then join `/api/X` to the handler `Invoke-X.ps1`. AST-extract each handler's query/body fields, role annotation, Graph/EXO helper calls, durable-orchestrator/queue invocations, storage/DB access, and downstream helper references.
5. Emit counts at each join: configured menu leaves, configured menu nodes, page routes, orphan routes, UI endpoint literals, OpenAPI operations, handlers resolved, unresolved dynamic endpoints, Graph-backed, EXO-backed, storage-backed, and background-job-backed handlers. Pin both SHAs in the generated output.

That method gives full depth and makes the sampled user/group map above a small, traceable subset rather than a claim of feature parity.
