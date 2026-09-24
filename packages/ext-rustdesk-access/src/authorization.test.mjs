import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAccess, integrationStatus, REQUIRED_ENFORCEMENT } from './authorization.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  return {
    now: 1000,
    actor: { id: id(1), partnerId: id(2), active: true, sessionActive: true, remoteAccessAllowed: true, mfaPolicySatisfied: true, allowedOrgIds: [id(3)] },
    device: { id: id(4), orgId: id(3), partnerId: id(2), siteId: id(5), active: true },
    grant: { id: id(6), userId: id(1), deviceId: id(4), orgId: id(3), partnerId: id(2), active: true, version: 1, notBefore: 900, expiresAt: 1100 },
    enforcement: Object.fromEntries(REQUIRED_ENFORCEMENT.map(key => [key, true])),
  };
}
test('explicit assignment plus live host authorization is eligible, never a credential', () => {
  const result = evaluateAccess(fixture());
  assert.deepEqual(result, { allowed: true, code: 'eligible', userId: id(1), deviceId: id(4), orgId: id(3), grantId: id(6), grantVersion: 1 });
  assert.equal(Object.isFrozen(result), true);
});
for (const [label, change] of [
  ['disabled account', f => f.actor.active = false],
  ['logged-out session', f => f.actor.sessionActive = false],
  ['removed role permission', f => f.actor.remoteAccessAllowed = false],
  ['unsatisfied MFA policy', f => f.actor.mfaPolicySatisfied = false],
  ['other partner', f => f.actor.partnerId = id(9)],
  ['other organization', f => f.actor.allowedOrgIds = [id(9)]],
  ['site-restricted role', f => f.actor.allowedSiteIds = []],
  ['malformed site scope', f => f.actor.allowedSiteIds = null],
  ['deleted device', f => f.device.active = false],
  ['device moved to another org', f => { f.device.orgId = id(9); f.actor.allowedOrgIds.push(id(9)); }],
  ['another user assignment', f => f.grant.userId = id(9)],
  ['another device assignment', f => f.grant.deviceId = id(9)],
  ['revoked assignment', f => f.grant.active = false],
  ['expired assignment at exact boundary', f => f.grant.expiresAt = f.now],
  ['future assignment', f => f.grant.notBefore = f.now + 1],
  ['unbounded assignment', f => f.grant.expiresAt = Infinity],
  ['malformed grant version', f => f.grant.version = 0],
  ['missing assignment even for administrator', f => { delete f.grant; f.actor.isAdmin = true; }],
  ['stock client without enforcement adapter', f => delete f.enforcement],
]) test(`denies ${label}`, () => { const f = fixture(); change(f); assert.equal(evaluateAccess(f).allowed, false); });
for (const key of REQUIRED_ENFORCEMENT) {
  test(`denies adapter missing ${key}`, () => { const f = fixture(); delete f.enforcement[key]; assert.equal(evaluateAccess(f).code, 'enforcement_unavailable'); });
  test(`does not accept truthy claims for ${key}`, () => { const f = fixture(); f.enforcement[key] = 'true'; assert.equal(evaluateAccess(f).allowed, false); });
}
test('rechecking rejects a grant revoked after initial eligibility', () => {
  const f = fixture(); assert.equal(evaluateAccess(f).allowed, true);
  f.grant.active = false; assert.equal(evaluateAccess(f).allowed, false);
});
test('never treats an invalid clock or absent input as authorized', () => {
  assert.equal(evaluateAccess().allowed, false);
  for (const now of [NaN, Infinity, -1, '1000', 1.5]) assert.equal(evaluateAccess({ ...fixture(), now }).allowed, false);
});
test('current integration reports unavailable; nothing enables it via user options', () => {
  assert.equal(integrationStatus({ enabled: true }).accountAccessEnabled, false);
  assert.equal(integrationStatus().credentialHandoffEnabled, false);
});
