import { describe, expect, it } from 'vitest';
import { readStaffNativeAuthorizationRequest, validateStaffNativeAuthorizationResponse,
  type StaffNativeAuthorizationRequest } from './staffNativeAuthorization';

const state = 'A'.repeat(43);
const code = 'B'.repeat(43);
const request: StaffNativeAuthorizationRequest = {
  clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:1024/cloudcom/callback',
  codeChallenge: 'C'.repeat(43), codeChallengeMethod: 'S256', state,
};

describe('staff native authorization request validation', () => {
  it('accepts the exact S256 request and rejects malformed, duplicate, or unsafe query values', () => {
    const query = new URLSearchParams(request).toString();
    expect(readStaffNativeAuthorizationRequest(`?${query}`)).toEqual(request);
    expect(readStaffNativeAuthorizationRequest(`?${query}&state=${state}`)).toBeNull();
    expect(readStaffNativeAuthorizationRequest(`?${query}&extra=1`)).toBeNull();
    expect(readStaffNativeAuthorizationRequest(`?${query.replace('127.0.0.1%3A1024', 'localhost%3A1024')}`)).toBeNull();
    expect(readStaffNativeAuthorizationRequest(`?${query.replace('codeChallengeMethod=S256', 'codeChallengeMethod=plain')}`)).toBeNull();
    expect(readStaffNativeAuthorizationRequest(`?${query.replace('127.0.0.1%3A1024', '127.0.0.1%3A65536')}`)).toBeNull();
  });
});

describe('staff native authorization callback validation', () => {
  it('accepts only the matching loopback callback with one code and the original state', () => {
    const safe = `${request.redirectUri}?code=${code}&state=${state}`;
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: safe }, request)).toBe(safe);
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: `${request.redirectUri}?code=${code}&state=${'D'.repeat(43)}` }, request)).toBeNull();
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: `${request.redirectUri}?code=${code}&state=${state}&token=secret` }, request)).toBeNull();
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: `${request.redirectUri}?code=${code}&code=${code}&state=${state}` }, request)).toBeNull();
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: `http://127.0.0.1:1025/cloudcom/callback?code=${code}&state=${state}` }, request)).toBeNull();
    expect(validateStaffNativeAuthorizationResponse({ redirectUri: `${request.redirectUri}?code=bad&state=${state}` }, request)).toBeNull();
  });
});
