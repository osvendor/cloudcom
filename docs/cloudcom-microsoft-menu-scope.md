# Microsoft extension menu scope

The user excludes capabilities requiring Entra ID P1, P2, Entra Suite or additional premium administration/security licenses. This overrides the earlier plan to reproduce the whole CIPP navigation. CIPP is a reference inventory, not the shipped menu specification.

## Included scope

Keep standard user lifecycle management, password reset, session revocation, supported basic authentication-method administration, static groups and membership, direct user license assignment, and ordinary Exchange, Teams, SharePoint and OneDrive administration. These still require their normal service subscriptions, provider permissions and Breeze authorization. The Licenses menu remains useful for existing subscriptions; this request does not remove purchased SKU records or change tenant licensing.

## Excluded menu surfaces

- Conditional Access, policy templates/evaluation and risk-based access policies.
- Identity Protection, risky users/sign-ins and premium risk reporting.
- PIM, access reviews, entitlement management and premium identity-governance workflows.
- Dynamic user membership rules and premium-dependent group automation.
- Graph sign-in logs, signInActivity reporting and dashboards/actions that depend on premium sign-in data.
- Intune, premium Defender/Purview, Copilot and other separately licensed advanced administration areas are outside this delivery scope. Basic Exchange protection and normal service administration are not removed wholesale.

Do not show excluded features as disabled items or upsell placeholders. Apply the exclusion to navigation, search, detail tabs, expanding drawers, context menus, bulk actions, templates and dashboard shortcuts. Remove empty parent sections. Do not request broader permissions or execute premium-feature probes merely to support an excluded item. Do not alter tenant policies, subscriptions or existing data.

Mixed-license features require operation-level review: preserve eligible base functionality and omit only the premium action or field. Verify group-based licensing eligibility separately; do not assume it is equivalent to ordinary direct license assignment. Unclassified imported CIPP features remain outside the delivered menu until licensing and backend support are established.

## Current implementation and update checks

The current Microsoft extension exposes Users, Groups, Licenses and Sites inventory. No premium navigation is implemented there. This document governs expansion; it does not claim the full administration UI is already delivered.

For each added operation, record its service/license prerequisite, upstream source, native executor, authorization and UI test. Check direct routes as well as menus. An upstream/CIPP update must not automatically reintroduce excluded items. Keep source inventories intact as audit evidence, with exclusions recorded explicitly rather than treating those inventories as approved scope.

## Primary references

- [Conditional Access licensing](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview): P1; risk-based policies require P2.
- [Graph sign-in resource](https://learn.microsoft.com/en-us/graph/api/resources/signin): downloading sign-in logs requires P1 or P2.
- [Entra licensing](https://learn.microsoft.com/en-us/entra/fundamentals/licensing): verify governance and other feature-specific prerequisites.
- [Ordinary user license assignment](https://learn.microsoft.com/en-us/microsoft-365/enterprise/assign-licenses-to-user-accounts): retained base administration.
