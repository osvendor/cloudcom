import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ tenant: vi.fn(), policy: vi.fn(), prompt: vi.fn(), trust: vi.fn(),
  trustMode: vi.fn(), enabled: vi.fn() }));
vi.mock('./tenantStatus', () => ({ getActiveOrgTenant: m.tenant }));
vi.mock('./remoteAccessPolicy', () => ({ checkRemoteAccess: m.policy }));
vi.mock('../routes/remote/helpers', () => ({ resolveRemoteSessionPromptConfig: m.prompt }));
vi.mock('./partnerTrust', () => ({ evaluateCapability: m.trust }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: m.trustMode }));
vi.mock('./portalNativeAdmissionSchemas', () => ({ nativeAdmissionEnabled: m.enabled }));
import { staffNativeAvailability } from './staffNativeAvailability';
import type { StaffNativePrincipal } from './staffNativeAuthority';
const principal = { partnerId: 'partner', userId: 'staff' } as StaffNativePrincipal;
const device = { id: 'device', orgId: 'org', status: 'online', agentTokenSuspendedAt: null, quarantinedAt: null };
beforeEach(() => {
  vi.resetAllMocks(); m.enabled.mockReturnValue(true); m.tenant.mockResolvedValue({ partnerId: 'partner' });
  m.policy.mockResolvedValue({ allowed: true }); m.prompt.mockResolvedValue({ mode: 'off' });
  m.trustMode.mockReturnValue('enforce'); m.trust.mockResolvedValue({ allow: true });
});
describe('staff directory native availability', () => {
  it('checks each device policy while resolving its active tenant once per page', async () => {
    const available = staffNativeAvailability(principal);
    expect((await available(device)).available).toBe(true);
    expect((await available({ ...device, id: 'second' })).available).toBe(true);
    expect(m.tenant).toHaveBeenCalledOnce(); expect(m.policy).toHaveBeenCalledTimes(2);
    expect(m.trust).toHaveBeenCalledWith('remote_control', expect.objectContaining({
      partnerId: 'partner', orgId: 'org', deviceId: 'second', userId: 'staff' }));
  });
  it.each([{ status: 'offline' }, { agentTokenSuspendedAt: new Date() }, { quarantinedAt: new Date() }])(
    'does not offer unavailable endpoints %j', async change => {
      expect((await staffNativeAvailability(principal)({ ...device, ...change })).available).toBe(false);
      expect(m.tenant).not.toHaveBeenCalled();
    });
  it('honors the native admission feature gate', async () => {
    m.enabled.mockReturnValue(false);
    expect((await staffNativeAvailability(principal)(device)).available).toBe(false);
  });
  it.each([null, { partnerId: 'other' }])('denies inactive or foreign tenants %j', async tenant => {
    m.tenant.mockResolvedValue(tenant);
    expect((await staffNativeAvailability(principal)(device)).available).toBe(false);
    expect(m.policy).not.toHaveBeenCalled();
  });
  it.each(['notify', 'consent'])('does not offer unsupported %s prompts', async mode => {
    m.prompt.mockResolvedValue({ mode });
    expect((await staffNativeAvailability(principal)(device)).available).toBe(false);
  });
  it.each(['policy', 'trust'] as const)('honors %s denial without exposing policy details', async key => {
    m[key].mockResolvedValue({ allowed: false, allow: false, reason: 'private policy material' });
    const result = await staffNativeAvailability(principal)(device);
    expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not introduce a trust gate when configured off', async () => {
    m.trustMode.mockReturnValue('off');
    expect((await staffNativeAvailability(principal)(device)).available).toBe(true);
    expect(m.trust).not.toHaveBeenCalled();
  });
  it('fails the read when policy lookup fails instead of advertising availability', async () => {
    m.policy.mockRejectedValue(new Error('unavailable'));
    await expect(staffNativeAvailability(principal)(device)).rejects.toThrow('unavailable');
  });
});
