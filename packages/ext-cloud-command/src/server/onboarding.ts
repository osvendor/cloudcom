import type { NativeMicrosoftServices, MicrosoftRequest } from './native-microsoft';

/** One customer-facing status; internal read readiness is not full administration readiness. */
export async function microsoftOnboardingStatus(
  services: NativeMicrosoftServices | undefined,
  request: MicrosoftRequest,
  recheck = false,
) {
  if (services?.administration) return services.administration.status(request, recheck);
  const connection = services?.version === 1 ? await services.connection(request) : null;
  const canManage = connection?.canManage === true;
  const configured = connection?.available === true && connection.connected && connection.enabled === true;
  let inventoryVerified = false;
  let inventoryMessage = configured ? 'Connection configured; verification required.' : 'Microsoft connection is not ready.';
  if (recheck && configured && canManage && services) {
    const result = await services.read(request, 'licenses');
    inventoryVerified = result.ok;
    inventoryMessage = result.ok ? 'Microsoft inventory access verified.' : result.message;
  }
  return {
    state: connection?.connected ? 'needs_attention' as const : 'not_connected' as const,
    canManage,
    canStart: false,
    ...(connection?.tenantName ? { tenantName: connection.tenantName } : {}),
    reason: 'Unified Microsoft administration onboarding is being configured. No additional customer connection is required here.',
    capabilities: [
      { id: 'inventory', label: 'Directory inventory', status: inventoryVerified ? 'ready' : 'pending', message: inventoryMessage },
      { id: 'administration', label: 'User and group administration', status: 'pending', message: 'Administration provisioning is not available in this host yet.' },
      { id: 'exchange', label: 'Exchange administration', status: 'pending', message: 'Exchange provisioning is not available in this host yet.' },
      { id: 'collaboration', label: 'Teams, SharePoint and OneDrive', status: 'pending', message: 'Service administration checks are pending.' },
      { id: 'content-search', label: 'Basic content search and export', status: 'pending', message: 'The supported search and export connection is still being validated.' },
    ],
  };
}
