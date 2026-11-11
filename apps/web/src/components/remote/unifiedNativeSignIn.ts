import type { apiLogin } from '../../stores/auth';

type Login = typeof apiLogin;

/** Customer fallback must use the server's unifiedNative identity guard.
 * Staff 401s intentionally include policy denials, not just bad passwords.
 * An existing staff identity must never be reinterpreted as a customer. */
export async function authenticateRemoteAccount(
  email: string, password: string, staffLogin: Login,
  customerLogin: (email: string, password: string) => Promise<boolean | { error: string }>,
): ReturnType<Login> {
  const staff = await staffLogin(email, password);
  if (staff.success || staff.status !== 401) return staff;
  const customer = await customerLogin(email, password);
  if (customer === true) return { success: true };
  if (customer && typeof customer === 'object') return { success: false, error: customer.error };
  return { success: false, error: 'Unable to sign in. Check your credentials and account access.' };
}
