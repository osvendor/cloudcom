import { describe, expect, it } from 'vitest';
import { portalAccessModeAllows } from './accessMode';

describe('remote-only API entitlement', () => {
  it.each(['/devices', '/devices/export.csv', '/tickets', '/invoices', '/quotes', '/reports', '/dashboard', '/documents/a/content', '/assets', '/security', '/backups', '/service'])('denies %s even when an organization enables it', path => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(portalAccessModeAllows('remote_only', method, `/api/v1/portal${path}`)).toBe(false);
    }
  });
  it.each(['/remote/devices', '/remote/sessions', '/remote/sessions/a/offer'])('allows the separately authorized remote router %s', path => {
    expect(portalAccessModeAllows('remote_only', 'GET', `/api/v1/portal${path}`)).toBe(true);
  });
  it('allows account maintenance and logout, not neighboring paths', () => {
    expect(portalAccessModeAllows('remote_only', 'POST', '/api/v1/portal/auth/logout')).toBe(true);
    expect(portalAccessModeAllows('remote_only', 'GET', '/api/v1/portal/profile')).toBe(true);
    expect(portalAccessModeAllows('remote_only', 'DELETE', '/api/v1/portal/profile')).toBe(false);
    expect(portalAccessModeAllows('remote_only', 'GET', '/api/v1/portal/remote-admin')).toBe(false);
    expect(portalAccessModeAllows('remote_only', 'GET', '/api/v1/portal/branding/another-org')).toBe(false);
  });
  it('fails closed for missing or corrupt modes and preserves standard accounts', () => {
    for (const mode of [null, undefined, '', 'admin']) expect(portalAccessModeAllows(mode, 'GET', '/remote/devices')).toBe(false);
    expect(portalAccessModeAllows('standard', 'GET', '/api/v1/portal/devices')).toBe(true);
  });
});
