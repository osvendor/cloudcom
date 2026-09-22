import { describe, expect, it } from 'vitest';
import type { ForwardingProfile, ThreeCxDetailChanges } from '../threecx/detail-contract';
import { mountForwardingEditors } from './threecx-detail-forwarding';

const profiles: ForwardingProfile[] = [
  { Id: 1, Name: 'Available', fields: { NoAnswerTimeout: 20, RingMyMobile: false }, destinations: [] },
  { Id: 2, Name: 'Away', fields: { NoAnswerTimeout: 30, RingMyMobile: true }, destinations: [] },
];
function setup(changes: ThreeCxDetailChanges = {}): ShadowRoot {
  const host = document.createElement('div'); const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="detail-panel"><article class="detail-card"><h4>Available</h4><dl class="detail-list"></dl></article><article class="detail-card"><h4>Away</h4><dl class="detail-list"></dl></article><p class="readonly-note">Forwarding changes are awaiting verified destination semantics.</p></div>`;
  mountForwardingEditors(root, profiles, changes, true, false, (next) => { changes.ForwardingProfiles = next; });
  return root;
}
describe('forwarding detail draft', () => {
  it('preserves two edited fields in one profile', () => {
    const changes: ThreeCxDetailChanges = {}; const root = setup(changes); const fields = root.querySelectorAll<HTMLInputElement>('[data-forwarding-field]');
    fields[0]!.value = '25'; fields[0]!.dispatchEvent(new Event('input')); fields[1]!.checked = true; fields[1]!.dispatchEvent(new Event('change'));
    expect(changes.ForwardingProfiles).toEqual([{ Id: 1, NoAnswerTimeout: 25, RingMyMobile: true }]);
  });
  it('preserves edits across profiles and removes a restored value from the draft', () => {
    const changes: ThreeCxDetailChanges = {}; const root = setup(changes); const fields = root.querySelectorAll<HTMLInputElement>('[data-forwarding-field]');
    fields[0]!.value = '25'; fields[0]!.dispatchEvent(new Event('input')); fields[6]!.value = '35'; fields[6]!.dispatchEvent(new Event('input'));
    expect(changes.ForwardingProfiles).toEqual(expect.arrayContaining([{ Id: 1, NoAnswerTimeout: 25 }, { Id: 2, NoAnswerTimeout: 35 }]));
    fields[0]!.value = '20'; fields[0]!.dispatchEvent(new Event('input'));
    expect(changes.ForwardingProfiles).toEqual([{ Id: 2, NoAnswerTimeout: 35 }]);
  });
  it('disables forwarding controls when scalar changes are pending', () => {
    const host = document.createElement('div'); const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<div class="detail-panel"><article class="detail-card"><h4>Available</h4></article><article class="detail-card"><h4>Away</h4></article></div>`;
    mountForwardingEditors(root, profiles, {}, true, true, () => {});
    expect(root.querySelector<HTMLInputElement>('[data-forwarding-field]')!.disabled).toBe(true);
    expect(root.textContent).toContain('Save or discard other changes');
  });
});
