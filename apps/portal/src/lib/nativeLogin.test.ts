import { describe, expect, it } from 'vitest';
import { nativeCallbackUrl, parseNativeLoginRequest } from './nativeLogin';
const input = { clientId: 'cloudcom-rustdesk-v1', redirectUri: 'http://127.0.0.1:49871/cloudcom/callback',
  codeChallengeMethod: 'S256', codeChallenge: 'A'.repeat(43), state: 'Q'.repeat(42) + 'A' };
describe('native browser handoff', () => {
  it('accepts only one complete registered PKCE request', () => {
    expect(parseNativeLoginRequest(new URLSearchParams(input))).toEqual(input);
    const duplicate = new URLSearchParams(input); duplicate.append('state', input.state);
    expect(parseNativeLoginRequest(duplicate)).toBeNull();
    expect(parseNativeLoginRequest(new URLSearchParams({ ...input, next: '/devices' }))).toBeNull();
  });
  it.each(['https://example.test', 'http://localhost:49871/cloudcom/callback',
    'http://127.0.0.1:80/cloudcom/callback', 'http://127.0.0.1:65536/cloudcom/callback',
    'http://127.0.0.1:49871/a/../cloudcom/callback', 'http://127.0.0.1:49871/cloudcom/callback?x=1'])('rejects substituted callback %s', redirectUri => {
    expect(parseNativeLoginRequest(new URLSearchParams({ ...input, redirectUri }))).toBeNull();
  });
  it('rejects noncanonical challenge bits', () => {
    expect(parseNativeLoginRequest(new URLSearchParams({ ...input, codeChallenge: 'A'.repeat(42) + 'B' }))).toBeNull();
  });
  it('checks destination, state and one code immediately before navigation', () => {
    const request = parseNativeLoginRequest(new URLSearchParams(input))!;
    const callback = `${input.redirectUri}?code=${'A'.repeat(43)}&state=${input.state}`;
    expect(nativeCallbackUrl(callback, request)).toBe(callback);
    for (const value of [callback + '&extra=1', callback + '#fragment', callback.replace('state=Q', 'state=A'),
      callback.replace('127.0.0.1', 'localhost'), callback.replace('/cloudcom/', '/a/../cloudcom/')]) {
      expect(nativeCallbackUrl(value, request)).toBeNull();
    }
  });
});
