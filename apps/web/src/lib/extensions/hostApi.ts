import type { ExtensionHostApi } from '@breeze/extension-web-sdk';
import { fetchWithAuth } from '@/stores/auth';
import { getExtensionRegistry } from './registry';
import { dispatchCloudCommandConnectionsChanged } from './cloudCommandNavigationEvents';

const API_PREFIX = '/api/v1/';
const FORBIDDEN_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie']);
const ENCODED_PATH_SEPARATOR = /%2f|%5c/i;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CLOUD_COMMAND_CONNECTION_MUTATIONS = new Set([
  'PUT /threecx/connection',
  'POST /microsoft/onboarding/complete',
  'POST /microsoft/onboarding/recheck',
  'POST /microsoft/disconnect',
]);

export class ExtensionHostApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionHostApiError';
  }
}

function abortedError(): DOMException {
  return new DOMException('Extension host API capability has been revoked', 'AbortError');
}

function assertSafeSubpath(path: string): URL {
  if (
    typeof path !== 'string'
    || !path.startsWith('/')
    || path.startsWith('//')
    || /^\/api(?:\/|$)/.test(path)
    || path.includes('\\')
    || ENCODED_PATH_SEPARATOR.test(path)
  ) {
    throw new ExtensionHostApiError('extension request path must be a safe root-relative subpath');
  }

  let resolved: URL;
  try {
    resolved = new URL(path, 'https://extension.invalid');
  } catch {
    throw new ExtensionHostApiError('extension request path must be a valid root-relative URL');
  }

  // The WHATWG parser canonicalizes literal and percent-encoded dot segments.
  // Compare the canonical pathname with the supplied one so a caller cannot
  // use that normalization to escape the route namespace we prepend below.
  if (resolved.origin !== 'https://extension.invalid' || resolved.pathname !== path.split(/[?#]/, 1)[0]) {
    throw new ExtensionHostApiError('extension request path must not contain traversal or a URL scheme');
  }
  return resolved;
}

function assertSafeInit(init: RequestInit | undefined): Headers {
  if (init?.credentials !== undefined) {
    throw new ExtensionHostApiError('extension request credentials are host-managed');
  }
  if (init?.redirect !== undefined) {
    throw new ExtensionHostApiError('extension request redirects are host-managed');
  }
  const headers = new Headers(init?.headers);
  for (const name of headers.keys()) {
    if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
      throw new ExtensionHostApiError('extension request authentication headers are host-managed');
    }
  }
  return headers;
}

function mergeSignals(owner: AbortSignal, caller: AbortSignal | null | undefined): AbortSignal {
  return caller ? AbortSignal.any([owner, caller]) : owner;
}

export interface ExtensionHostApiOptions {
  extensionName: string;
  organizationId: string;
}

/** Creates one revocable capability for one mounted extension element. */
export function createExtensionHostApi(options: ExtensionHostApiOptions): {
  hostApi: ExtensionHostApi;
  revoke: () => void;
} {
  const controller = new AbortController();
  let revoked = false;

  const request: ExtensionHostApi['request'] = async (path, init) => {
    if (revoked) throw abortedError();
    const subpath = assertSafeSubpath(path);
    const headers = assertSafeInit(init);

    const registry = await getExtensionRegistry();
    if (revoked) throw abortedError();
    const extension = registry.extensions.find((candidate) => candidate.name === options.extensionName);
    if (!extension) throw new ExtensionHostApiError('extension is not available');

    const namespace = extension.routeNamespace;
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new ExtensionHostApiError('extension route namespace is invalid');
    }
    const target = new URL(`${API_PREFIX}${namespace}${subpath.pathname}`, window.location.origin);
    // Only this host-controlled value may select an organization. A matching
    // caller value is harmless; a different one is an attempted tenant switch.
    const requestedOrg = subpath.searchParams.get('orgId');
    if (requestedOrg !== null && requestedOrg !== options.organizationId) {
      throw new ExtensionHostApiError('extension request cannot select a different organization');
    }
    subpath.searchParams.delete('orgId');
    subpath.searchParams.set('orgId', options.organizationId);
    target.search = subpath.search;

    if (revoked) throw abortedError();
    const response = await fetchWithAuth(`${target.pathname}${target.search}`, {
      ...init,
      headers,
      credentials: undefined,
      redirect: 'error',
      orgIdOverride: options.organizationId,
      signal: mergeSignals(controller.signal, init?.signal),
    });
    if (
      !revoked
      && response.ok
      && options.extensionName === 'cloudcommand'
      && CLOUD_COMMAND_CONNECTION_MUTATIONS.has(`${(init?.method ?? 'GET').toUpperCase()} ${subpath.pathname}`)
    ) {
      dispatchCloudCommandConnectionsChanged(options.organizationId);
    }
    return response;
  };

  return {
    hostApi: Object.freeze({ request }),
    revoke: () => {
      if (!revoked) {
        revoked = true;
        controller.abort();
      }
    },
  };
}
