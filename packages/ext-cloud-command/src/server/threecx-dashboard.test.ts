import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './transport';
import { projectSystemStatus, readThreeCxDashboard } from './threecx-dashboard';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const user = (id: number, group = 7, registered = true) => ({ Id: id, Number: String(100 + id), FirstName: 'Test', LastName: null, EmailAddress: null, Mobile: null, Enabled: true, IsRegistered: registered, CurrentProfileName: null, Groups: [{ GroupId: group }] });
function setup(department: number | null, pages: Record<string, unknown>[]) {
  const users = vi.fn(async () => pages.shift() ?? { value: [] });
  const systemStatus = vi.fn(async () => ({ Version: '20.0', CallsActive: 3, ExtensionsRegistered: 4, ignored: 'secret' }));
  const provider = { users, systemStatus } as never;
  const row = { id: CONNECTION, org_id: ORG, origin: 'https://pbx.example.test', client_id: 'client', secret_ciphertext: 'cipher', department_id: department, enabled: true, version: 1, last_verified_at: null };
  const scope = { organizationId: ORG, partnerId: PARTNER, actorId: '44444444-4444-4444-8444-444444444444' };
  return { input: { row, scope, credentials: { origin: row.origin, clientId: row.client_id, secret: 'test' }, provider }, users, systemStatus };
}
describe('3CX dashboard', () => {
  it('counts only department members and never calls PBX-wide status', async () => {
    const h = setup(7, [{ value: [user(1, 7), user(2, 8), user(3, 7, false)] }]);
    const result = await readThreeCxDashboard(h.input);
    expect(result).toMatchObject({ scope: 'department', extensions: { total: 2, registered: 1, complete: true }, status: null, statusAvailability: 'department_scoped' });
    expect(h.systemStatus).not.toHaveBeenCalled();
  });
  it('shows allowlisted PBX fields for an explicit full-PBX connection', async () => {
    const h = setup(null, [{ value: [user(1)] }]);
    const result = await readThreeCxDashboard(h.input);
    expect(result).toMatchObject({ scope: 'full_pbx', statusAvailability: 'available', status: { Version: '20.0', CallsActive: 3 } });
    expect(JSON.stringify(result)).not.toContain('ignored');
  });
  it('preserves extension counts when status permission is limited', async () => {
    const h = setup(null, [{ value: [user(1)] }]);
    h.systemStatus.mockRejectedValueOnce(new ProviderError('provider_access_denied'));
    expect(await readThreeCxDashboard(h.input)).toMatchObject({ extensions: { total: 1, complete: true }, status: null, statusAvailability: 'permission_limited' });
  });
  it('marks a bounded ten-page count as incomplete', async () => {
    const h = setup(7, Array.from({ length: 10 }, () => ({ value: Array.from({ length: 100 }, (_, index) => user(index)), '@odata.nextLink': 'https://untrusted.example/next' })));
    expect(await readThreeCxDashboard(h.input)).toMatchObject({ extensions: { total: 1000, complete: false } });
    expect(h.users).toHaveBeenCalledTimes(10);
  });
  it('rejects malformed provider status data', () => {
    expect(() => projectSystemStatus({ CallsActive: -1 })).toThrow(ProviderError);
    expect(() => projectSystemStatus({ BackupScheduled: 'yes' })).toThrow(ProviderError);
  });
});
