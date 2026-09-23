// Enabled-extension top-level navigation links for the Sidebar's "Extensions"
// section (Task 5). Reuses the registry client from Task 4 — this hook does
// NOT fetch or validate the registry document itself, only projects+re-checks
// the `navigation` array of each already-validated `RuntimeWebExtension`.
//
// SECURITY — `href` is a second trust boundary, independent of
// `runtimeWebRegistrySchema` (registry.ts). That schema only proves the wire
// shape is well-formed; it says nothing about whether a given `path` stays
// inside `/extensions/<extension-name>/...`. A compromised/misbehaving
// registry response could otherwise smuggle a nav item whose href points
// anywhere (`/settings/users`, `//evil.example.com`, `/../admin`) and have it
// rendered as a real Sidebar `<a href>`. `isSafeExtensionHref` below is the
// one place that re-derives and re-validates every href before it can reach
// the DOM.
import { useEffect, useMemo, useState } from 'react';
import {
  getExtensionRegistry,
  type RuntimeWebExtension,
  type RuntimeWebNavItem,
  type RuntimeWebRegistry,
} from '@/lib/extensions/registry';
import { createExtensionHostApi } from '@/lib/extensions/hostApi';
import { CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT, type CloudCommandConnectionsChangedDetail } from '@/lib/extensions/cloudCommandNavigationEvents';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useAuthStore } from '@/stores/auth';

export interface ExtensionNavLink {
  readonly name: string;
  readonly href: string;
  readonly children?: readonly { name: string; href: string }[];
  readonly loading?: boolean;
}

const CLOUD_COMMAND_NAME = 'cloudcommand';
const CLOUD_COMMAND_OVERVIEW_HREF = '/extensions/cloudcommand/overview';
const CLOUD_COMMAND_CHILDREN = [
  { name: '3CX', href: '/extensions/cloudcommand/threecx', pagePath: '/threecx' },
  { name: 'Microsoft 365', href: '/extensions/cloudcommand/microsoft', pagePath: '/microsoft' },
  { name: 'Google Workspace', href: '/extensions/cloudcommand/google', pagePath: '/google' },
] as const;

// Mirrors packages/extension-sdk/src/manifest.ts NAME_RE — kept as a literal
// copy (not imported) so this trust-boundary check never silently changes
// behavior via an unrelated package bump.
const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

// Mirrors manifest.ts's `absoluteWebPath` character allowlist.
const SAFE_HREF_CHARS_RE = /^\/[a-zA-Z0-9\-_./]*$/;

/**
 * True only for `/extensions/<extensionName>/...` (or exactly
 * `/extensions/<extensionName>`), built from a well-formed extension name,
 * using only the character set the server's own manifest schema allows, and
 * containing no `..` traversal segment.
 */
function isSafeExtensionHref(href: string, extensionName: string): boolean {
  if (!EXTENSION_NAME_RE.test(extensionName)) return false;
  if (!SAFE_HREF_CHARS_RE.test(href)) return false;
  if (href.split('/').includes('..')) return false;
  const prefix = `/extensions/${extensionName}`;
  return href === prefix || href.startsWith(`${prefix}/`);
}

interface RankedNavLink {
  readonly link: ExtensionNavLink;
  readonly order: number;
  readonly extensionName: string;
  readonly contributionId: string;
}

function toRankedNavLink(
  extension: RuntimeWebExtension,
  item: RuntimeWebNavItem,
): RankedNavLink | null {
  const href = `/extensions/${extension.name}${item.path}`;
  if (!isSafeExtensionHref(href, extension.name)) return null;
  return {
    link: { name: item.label, href },
    // Undefined `order` sorts after every explicitly ordered item, never
    // before — an extension that doesn't care about position shouldn't be
    // able to jump ahead of ones that do.
    order: item.order ?? Number.POSITIVE_INFINITY,
    extensionName: extension.name,
    contributionId: item.id ?? item.path,
  };
}

/** order -> extension name -> contribution id (id, falling back to the
 *  manifest-unique path), matching the server projection's own tie-break
 *  (webRegistry.ts `pageOrNavKey`). */
function compareRanked(a: RankedNavLink, b: RankedNavLink): number {
  if (a.order !== b.order) return a.order - b.order;
  const nameCompare = a.extensionName.localeCompare(b.extensionName);
  if (nameCompare !== 0) return nameCompare;
  return a.contributionId.localeCompare(b.contributionId);
}

/** Pure projection, exported for direct unit-testing of the sort/validation
 *  rules without mounting a component or mocking the registry client. */
export function extensionNavLinksFromRegistry(registry: RuntimeWebRegistry): ExtensionNavLink[] {
  return registry.extensions
    .flatMap((extension) => extension.navigation.map((item) => toRankedNavLink(extension, item)))
    .filter((ranked): ranked is RankedNavLink => ranked !== null)
    .sort(compareRanked)
    .map((ranked) => ranked.link);
}

type CloudCommandStatus = { connected?: unknown; enabled?: unknown; available?: unknown };

function isCloudCommandOverview(registry: RuntimeWebRegistry): boolean {
  const extension = registry.extensions.find((candidate) => candidate.name === CLOUD_COMMAND_NAME);
  return extension?.pages.some((page) => page.path === '/overview') === true
    && extension.navigation.some((item) => item.path === '/overview');
}

function cloudCommandPages(registry: RuntimeWebRegistry): Set<string> {
  const extension = registry.extensions.find((candidate) => candidate.name === CLOUD_COMMAND_NAME);
  return new Set(extension?.pages.map((page) => page.path) ?? []);
}

function decorateCloudCommandOverview(
  links: ExtensionNavLink[],
  registry: RuntimeWebRegistry,
  children: readonly { name: string; href: string }[],
  loading: boolean,
): ExtensionNavLink[] {
  if (!isCloudCommandOverview(registry)) return links;
  return links.map((link) => link.href === CLOUD_COMMAND_OVERVIEW_HREF
    ? { ...link, children, loading }
    : link,
  );
}

function enabledThreeCx(value: unknown): boolean {
  const status = value as CloudCommandStatus | null;
  return status?.connected === true && status.enabled === true;
}

function enabledMicrosoft(value: unknown): boolean {
  const status = value as CloudCommandStatus | null;
  return status?.available === true && status.connected === true && status.enabled === true;
}

const enabledGoogle = enabledMicrosoft;

type NavigationState = { links: ExtensionNavLink[]; connectionOrgId: string | null; sessionKey: string | null };

/**
 * Enabled runtime-extension navigation links, deterministically ordered.
 * Never throws: a registry fetch failure (401, network error, shape
 * mismatch) resolves to an empty list, same "hide the addition, never break
 * the host" posture as the rest of the extension surface.
 */
export function useExtensionNavigation(): ExtensionNavLink[] {
  const [state, setState] = useState<NavigationState>({ links: [], connectionOrgId: null, sessionKey: null });
  const [refresh, setRefresh] = useState(0);
  const scope = useOrgScope();
  const organizationId = scope.status === 'resolved' && scope.scope === 'org' ? scope.orgId : null;
  // Match the registry cache boundary: clear organization-specific children
  // across login/logout and account changes, not merely selector changes.
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const accessToken = useAuthStore((state) => state.tokens?.accessToken ?? null);
  const sessionKey = authenticated ? `${userId ?? 'authenticated'}:${accessToken ?? ''}` : null;

  useEffect(() => {
    const onConnectionsChanged = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail as CloudCommandConnectionsChangedDetail | null;
      if (detail?.organizationId === organizationId) setRefresh((value) => value + 1);
    };
    window.addEventListener(CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT, onConnectionsChanged);
    return () => window.removeEventListener(CLOUD_COMMAND_CONNECTIONS_CHANGED_EVENT, onConnectionsChanged);
  }, [organizationId]);

  useEffect(() => {
    const revalidate = () => setRefresh((value) => value + 1);
    document.addEventListener('astro:after-swap', revalidate);
    window.addEventListener('focus', revalidate);
    return () => {
      document.removeEventListener('astro:after-swap', revalidate);
      window.removeEventListener('focus', revalidate);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let revoke: (() => void) | null = null;

    getExtensionRegistry()
      .then((registry) => {
        if (cancelled) return;
        const links = extensionNavLinksFromRegistry(registry);
        if (!organizationId || !authenticated || !isCloudCommandOverview(registry)) {
          setState({ links: decorateCloudCommandOverview(links, registry, [], false), connectionOrgId: organizationId, sessionKey });
          return;
        }

        setState({ links: decorateCloudCommandOverview(links, registry, [], true), connectionOrgId: organizationId, sessionKey });
        const pages = cloudCommandPages(registry);
        if (!pages.has('/threecx') && !pages.has('/microsoft') && !pages.has('/google')) {
          setState({ links: decorateCloudCommandOverview(links, registry, [], false), connectionOrgId: organizationId, sessionKey });
          return;
        }
        const { hostApi, revoke: revokeHostApi } = createExtensionHostApi({ extensionName: CLOUD_COMMAND_NAME, organizationId });
        revoke = revokeHostApi;
        const status = async (path: string): Promise<unknown> => {
          const response = await hostApi.request(path);
          if (!response.ok) throw new Error('connection status unavailable');
          return response.json();
        };
        void Promise.all([
          pages.has('/threecx') ? status('/threecx/connection').then(enabledThreeCx).catch(() => false) : Promise.resolve(false),
          pages.has('/microsoft') ? status('/microsoft/connection').then(enabledMicrosoft).catch(() => false) : Promise.resolve(false),
          pages.has('/google') ? status('/google/connection').then(enabledGoogle).catch(() => false) : Promise.resolve(false),
        ]).then(([threeCx, microsoft, google]) => {
          if (cancelled) return;
          const children = [
            ...(threeCx ? [{ name: CLOUD_COMMAND_CHILDREN[0].name, href: CLOUD_COMMAND_CHILDREN[0].href }] : []),
            ...(microsoft ? [{ name: CLOUD_COMMAND_CHILDREN[1].name, href: CLOUD_COMMAND_CHILDREN[1].href }] : []),
            ...(google ? [{ name: CLOUD_COMMAND_CHILDREN[2].name, href: CLOUD_COMMAND_CHILDREN[2].href }] : []),
          ];
          setState({ links: decorateCloudCommandOverview(links, registry, children, false), connectionOrgId: organizationId, sessionKey });
        });
      })
      .catch(() => {
        if (!cancelled) setState({ links: [], connectionOrgId: organizationId, sessionKey });
      });

    return () => { cancelled = true; revoke?.(); };
  }, [organizationId, authenticated, userId, accessToken, sessionKey, refresh]);

  // Effects run after paint. Never expose the prior organization's children in
  // that gap: selector/account changes synchronously render an empty group.
  return useMemo(() => state.connectionOrgId === organizationId && state.sessionKey === sessionKey
    ? state.links
    : state.links.map((link) => link.href === CLOUD_COMMAND_OVERVIEW_HREF
      ? { ...link, children: [], loading: organizationId !== null }
      : link), [state, organizationId, sessionKey]);
}
