import { describe, expect, it, vi } from 'vitest';
import { authenticateRemoteAccount } from './unifiedNativeSignIn';

describe('unified remote sign-in authority', () => {
  it('preserves actionable customer authentication errors without claiming sign-in succeeded', async () => {
    const result = await authenticateRemoteAccount('person@example.test', 'password',
      vi.fn().mockResolvedValue({ success: false, status: 401 }),
      vi.fn().mockResolvedValue({ error: 'Company context is required.' }));
    expect(result).toEqual({ success: false, error: 'Company context is required.' });
  });
  it.each([403, 429, 500, undefined])('never falls through staff policy or availability failure %s', async status => {
    const staff = vi.fn().mockResolvedValue({ success: false, status });
    const customer = vi.fn();
    expect(await authenticateRemoteAccount('person@example.test', 'password', staff, customer))
      .toEqual({ success: false, status });
    expect(customer).not.toHaveBeenCalled();
  });
  it('preserves staff MFA without attempting another authority', async () => {
    const challenge = { success: true, mfaRequired: true, tempToken: 'opaque' };
    const customer = vi.fn();
    expect(await authenticateRemoteAccount('person@example.test', 'password', vi.fn().mockResolvedValue(challenge), customer))
      .toBe(challenge);
    expect(customer).not.toHaveBeenCalled();
  });
  it('only accepts a customer after that endpoint authenticates the password', async () => {
    const staff = vi.fn().mockResolvedValue({ success: false, status: 401 });
    const customer = vi.fn().mockResolvedValue(true);
    expect(await authenticateRemoteAccount('person@example.test', 'password', staff, customer))
      .toEqual({ success: true });
    expect(customer).toHaveBeenCalledWith('person@example.test', 'password');
    customer.mockResolvedValue(false);
    expect((await authenticateRemoteAccount('person@example.test', 'wrong', staff, customer)).success).toBe(false);
  });
});
