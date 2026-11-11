import { afterEach, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const userId = '66666666-6666-4666-8666-666666666666', groupId = '88888888-8888-4888-8888-888888888888';
afterEach(() => { document.body.replaceChildren(); window.location.hash = ''; });
it.each(['graph', 'exchange'] as const)('removes current %s groups even if the available-group catalog fails', async membershipProvider => {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
    if (path === '/microsoft/resources/users') return Response.json({ items: [{ id: userId, values: { displayName: 'QA User' } }], columns: [{ key: 'displayName', label: 'User' }], complete: true, checkedAt: 'now' });
    if (path === '/microsoft/resources/groups') return Response.json({ error: 'provider_unreachable' }, { status: 502 });
    if (path === '/microsoft/administration') {
      const type = JSON.parse(String(init?.body)).type;
      if (type === 'user.get') return Response.json({ id: userId, displayName: 'QA User' });
      if (type === 'user.groups.get') return Response.json({ items: [{ id: groupId, displayName: 'Current QA Group', removable: true, reason: '', membershipProvider }], partial: false });
      if (type === 'user.globalAdmin.get') return Response.json({ enabled: false });
      if (type === 'group.member.remove' || type === 'distribution.member.set') return Response.json({ accepted: true, verified: true, changed: true });
    }
    return new Response(null, { status: 404 });
  });
  const page = new CloudCommandMicrosoftPage();
  page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-a' };
  page.hostApi = { request }; document.body.append(page); await flush(); await flush();
  const root = page.shadowRoot!;
  root.querySelector<HTMLButtonElement>(`[data-expand="${userId}"]`)!.click(); await flush();
  root.querySelector<HTMLButtonElement>('#user-group-open')!.click(); await flush(); await flush();
  expect(root.textContent).toContain('Current QA Group');
  expect(root.textContent).not.toContain('Loading available groups');
  expect(root.querySelector('#user-group-select')).toBeNull();
  const remove = root.querySelector<HTMLButtonElement>('[data-user-group-remove]')!;
  expect(remove.disabled).toBe(false); remove.click();
  expect(root.querySelector('#user-group-confirm')).toBeNull();
  root.querySelector<HTMLButtonElement>('#user-group-submit')!.click(); await flush();
  const writes = request.mock.calls.filter(([, init]) => ['group.member.remove', 'distribution.member.set'].includes(JSON.parse(String(init?.body || '{}')).type));
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]![1]?.body))).toEqual(membershipProvider === 'exchange'
    ? { type: 'distribution.member.set', groupId, memberId: userId, enabled: false }
    : { type: 'group.member.remove', groupId, userId });
  expect(root.querySelector('[data-user-group-remove]')).toBeNull();
});
