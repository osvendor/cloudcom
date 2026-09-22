import { describe, expect, it, vi } from 'vitest';
import { microsoftOnboardingStatus } from './onboarding';
import type { MicrosoftRequest, NativeMicrosoftServices } from './native-microsoft';

const request = { orgId: 'org', auth: {}, authorization: {} } as MicrosoftRequest;
function host(canManage = true, ok = true): NativeMicrosoftServices {
  return {
    version: 1,
    connection: vi.fn(async () => ({ available: true, connected: true, enabled: true, canManage, tenantName: 'Example' })),
    read: vi.fn(async () => ok
      ? { ok: true as const, items: [{ id: 'sku', secret: 'never-return' }], truncated: false }
      : { ok: false as const, code: 'connection_changed', message: 'Connection changed.' }),
  };
}
describe('unified Microsoft readiness', () => {
  it('does not mistake inventory configuration for full administration readiness', async () => {
    const services = host();
    const result = await microsoftOnboardingStatus(services, request);
    expect(result).toMatchObject({ state: 'needs_attention', canStart: false });
    expect(result.capabilities.every(c => c.status === 'pending')).toBe(true);
    expect(services.read).not.toHaveBeenCalled();
  });
  it('verifies inventory without disclosing provider records or claiming other capabilities', async () => {
    const services = host();
    const result = await microsoftOnboardingStatus(services, request, true);
    expect(services.read).toHaveBeenCalledWith(request, 'licenses');
    expect(result.capabilities.filter(c => c.status === 'ready').map(c => c.id)).toEqual(['inventory']);
    expect(result.state).toBe('needs_attention');
    expect(JSON.stringify(result)).not.toContain('never-return');
  });
  it('does not verify on behalf of a non-manager', async () => {
    const services = host(false);
    await microsoftOnboardingStatus(services, request, true);
    expect(services.read).not.toHaveBeenCalled();
  });
  it('keeps failed or changed connections pending', async () => {
    const result = await microsoftOnboardingStatus(host(true, false), request, true);
    expect(result.capabilities[0]).toMatchObject({ status: 'pending', message: 'Connection changed.' });
  });
  it('handles hosts without Microsoft support', async () => {
    expect(await microsoftOnboardingStatus(undefined, request)).toMatchObject({ state: 'not_connected', canManage: false, canStart: false });
  });
});
