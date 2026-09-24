import type { ForwardingProfile, ThreeCxDetailChanges } from '../threecx/detail-contract';

type ProfileChange = NonNullable<ThreeCxDetailChanges['ForwardingProfiles']>[number];
const scalarKeys = ['NoAnswerTimeout', 'RingMyMobile', 'AcceptMultipleCalls', 'BlockPushCalls', 'DisableRingGroupCalls', 'OfficeHoursAutoQueueLogOut'] as const;
const labels: Record<typeof scalarKeys[number], string> = { NoAnswerTimeout: 'No answer timeout (seconds)', RingMyMobile: 'Ring my mobile', AcceptMultipleCalls: 'Accept multiple calls', BlockPushCalls: 'Block push calls', DisableRingGroupCalls: 'Disable ring group calls', OfficeHoursAutoQueueLogOut: 'Automatic queue logout after office hours' };

const escape = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);

export function hasForwardingChanges(changes: ThreeCxDetailChanges): boolean { return Array.isArray(changes.ForwardingProfiles) && changes.ForwardingProfiles.length > 0; }

export function mountForwardingEditors(root: ShadowRoot, profiles: ForwardingProfile[], changes: ThreeCxDetailChanges, editable: boolean, scalarDirty: boolean, onChange: (profiles: ProfileChange[]) => void): void {
  const cards = root.querySelectorAll<HTMLElement>('.detail-card');
  profiles.forEach((profile, index) => {
    const card = cards[index];
    if (!card) return;
    const current = changes.ForwardingProfiles?.find((item) => item.key === profile.key) ?? { key: profile.key };
    const disabled = !editable || scalarDirty;
    const controls = document.createElement('div');
    controls.className = 'detail-fields forwarding-controls';
    controls.innerHTML = scalarKeys.map((key) => key === 'NoAnswerTimeout'
      ? `<label>${labels[key]}<input data-forwarding-field="${key}" type="number" min="5" max="180" value="${escape(current[key] ?? profile.fields[key] ?? '')}" ${disabled ? 'disabled' : ''}></label>`
      : `<label class="check"><input data-forwarding-field="${key}" type="checkbox" ${(current[key] ?? profile.fields[key]) === true ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${labels[key]}</label>`).join('');
    card.insertBefore(controls, card.children[1] ?? null);
    if (editable) card.querySelector('.detail-list')?.remove();
    if (editable) card.querySelector('.readonly-note:last-child')?.replaceChildren('Ring controls are editable; routing destinations remain read-only.');
    controls.querySelectorAll<HTMLInputElement>('[data-forwarding-field]').forEach((input) => input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      const key = input.dataset.forwardingField as typeof scalarKeys[number];
      const latest = changes.ForwardingProfiles?.find((item) => item.key === profile.key) ?? { key: profile.key };
      const next: ProfileChange = { ...latest, [key]: input.type === 'checkbox' ? input.checked : Number(input.value) };
      const normalized = Object.fromEntries(Object.entries(next).filter(([field, value]) => field === 'key' || value !== profile.fields[field])) as ProfileChange;
      const all = (changes.ForwardingProfiles ?? []).filter((item) => item.key !== profile.key);
      if (Object.keys(normalized).length === 1) onChange(all);
      else onChange([...all, normalized]);
    }));
  });
  if (editable) root.querySelectorAll<HTMLElement>('.readonly-note').forEach((node) => {
    if (node.textContent?.includes('Forwarding changes are awaiting')) node.textContent = 'Ring controls are editable; routing destinations remain read-only.';
  });
  if (scalarDirty) root.querySelector('.detail-panel')?.insertAdjacentHTML('afterbegin', '<p class="readonly-note">Save or discard other changes before editing forwarding.</p>');
}
