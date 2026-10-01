import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudCommandMicrosoftPage } from './microsoft';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const inventory = (items: unknown[] = [], complete = true) => Response.json({ items, columns: [], complete, checkedAt: 'now' });
function mount(admin: (type: string) => Promise<Response>, users = () => Promise.resolve(inventory())) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/microsoft/connection') return Response.json({ available: true, connected: true, enabled: true, canManage: true });
    if (path === '/microsoft/administration') return admin(JSON.parse(String(init?.body)).type);
    if (path === '/microsoft/resources/users') return users();
    if (path === '/microsoft/resources/groups') return inventory();
    if (path === '/microsoft/directory/snapshot') return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  });
  const page = new CloudCommandMicrosoftPage();
  page.context = { contractVersion: 1, extensionName: 'cloudcommand', path: '/extensions/cloudcommand/microsoft', organizationId: 'org-a' };
  page.hostApi = { request }; document.body.append(page);
  return { page, root: page.shadowRoot!, request };
}
function click(root: ShadowRoot, selector: string) { root.querySelector<HTMLButtonElement>(selector)!.click(); }
function input(root: ShadowRoot, selector: string, value: string) {
  const node = root.querySelector<HTMLInputElement>(selector)!; node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
}
const catalog = async (type: string) => type === 'user.domains.list' ? Response.json({ domains: ['example.test'] }) : Response.json({ items: [], partial: false });
afterEach(() => { document.body.replaceChildren(); window.location.hash = ''; });
describe('creation panels and trace lifecycle', () => {
  it('keeps all creation sections outside focused account filtering', async () => {
    const { page, root } = mount(catalog); await flush(); await flush();
    // A previously opened focused panel must not filter the creation form.
    (page as unknown as { accountPanel: string }).accountPanel = 'delegation';
    click(root, '#create-user'); await flush();
    const body = root.querySelector('#create-user-name')!.closest('.drawer-body')!;
    expect(body.classList.contains('account-panel')).toBe(false);
    expect(body.hasAttribute('data-panel')).toBe(false);
    expect([...body.querySelectorAll('h3')].map(node => node.textContent)).toEqual(['Account', 'Sign-in', 'Assignments']);
  });
  it('retries failed license loading without losing the creation draft', async () => {
    let attempts = 0;
    const { root } = mount(async type => type === 'licenses.list' && ++attempts === 1 ? Response.json({ error: 'provider_unreachable' }, { status: 502 }) : catalog(type));
    await flush(); await flush(); click(root, '#create-user'); await flush();
    input(root, '#create-user-name', 'QA Draft');
    click(root, '#create-user-licenses-retry'); await flush();
    expect(root.querySelector<HTMLInputElement>('#create-user-name')!.value).toBe('QA Draft');
    expect(root.querySelector('#create-user-licenses-retry')).toBeNull();
  });
  it('discards old domain reads after closing and reopening creation', async () => {
    let resolveOld!: (value: Response) => void; let count = 0;
    const { root } = mount(async type => type === 'user.domains.list' && ++count === 1 ? new Promise<Response>(resolve => resolveOld = resolve) : catalog(type));
    await flush(); await flush(); click(root, '#create-user'); await flush();
    click(root, '#create-user-close'); click(root, '#create-user'); await flush();
    resolveOld(Response.json({ domains: ['old.test'] })); await flush();
    expect(root.querySelector<HTMLSelectElement>('#create-user-domain')!.value).toBe('example.test');
  });
  it('shows retry for incomplete group owners and blocks creation until complete', async () => {
    window.location.hash = '#groups'; let complete = false;
    const { root } = mount(catalog, async () => inventory([{ id: 'u1', values: { displayName: 'QA Owner' } }], complete));
    await flush(); await flush(); click(root, '#create-group'); await flush();
    expect(root.querySelector<HTMLButtonElement>('#create-group-submit')!.disabled).toBe(true);
    expect(root.textContent).toContain('owner list is incomplete');
    complete = true; click(root, '#create-group-owners-retry'); await flush();
    expect(root.querySelector<HTMLSelectElement>('#create-group-owner')!.options.length).toBe(2);
    expect(root.querySelector('#create-group-owners-retry')).toBeNull();
  });
  it('locks uncertain user creation instead of submitting the same write twice', async () => {
    let writes = 0;
    const { root } = mount(async type => { if (type === 'user.create') { writes++; throw new Error('Network interrupted'); } return catalog(type); });
    await flush(); await flush(); click(root, '#create-user'); await flush();
    input(root, '#create-user-name', 'QA Person'); input(root, '#create-user-local', 'qa');
    click(root, '#create-user-submit'); await flush();
    expect(root.querySelector<HTMLButtonElement>('#create-user-submit')!.disabled).toBe(true);
    expect(root.textContent).toContain('check the directory before starting another creation');
    click(root, '#create-user-submit'); await flush(); expect(writes).toBe(1);
  });
  it('ignores an owner read from a previously closed creation panel', async () => {
    window.location.hash = '#groups'; let finish!: (value: Response) => void; let attempts = 0;
    const { root } = mount(catalog, async () => ++attempts === 1 ? new Promise<Response>(resolve => finish = resolve) : inventory([{ id: 'new-owner', values: { displayName: 'New owner' } }]));
    await flush(); await flush(); click(root, '#create-group'); await flush();
    click(root, '#create-group-close'); click(root, '#create-group'); await flush();
    finish(inventory([{ id: 'old-owner', values: { displayName: 'Old owner' } }])); await flush();
    const choices = [...root.querySelector<HTMLSelectElement>('#create-group-owner')!.options].map(option => option.value);
    expect(choices).toContain('new-owner'); expect(choices).not.toContain('old-owner');
  });
  it('locks uncertain group creation instead of duplicating a write', async () => {
    window.location.hash = '#groups'; let writes = 0;
    const { root } = mount(async type => { if (type === 'group.create') { writes++; throw new Error('Network interrupted'); } return catalog(type); }, async () => inventory([{ id: 'u1', values: { displayName: 'QA Owner' } }]));
    await flush(); await flush(); click(root, '#create-group'); await flush();
    input(root, '#create-group-name', 'QA Group'); input(root, '#create-group-alias', 'qa'); input(root, '#create-group-owner', 'u1');
    click(root, '#create-group-submit'); await flush();
    expect(root.querySelector<HTMLButtonElement>('#create-group-submit')!.disabled).toBe(true);
    expect(root.textContent).toContain('check the directory before starting another creation');
    click(root, '#create-group-submit'); await flush(); expect(writes).toBe(1);
  });
  it('allows a fresh trace search after toggling closed during an in-flight search', async () => {
    let finish!: (value: Response) => void; let searches = 0;
    const { root } = mount(async type => type === 'trace.search' && ++searches === 1 ? new Promise<Response>(resolve => finish = resolve) : Response.json({ rows: [], next: null, partial: false, checkedAt: new Date().toISOString() }));
    await flush(); await flush(); click(root, '#trace-open');
    const submit = () => root.querySelector<HTMLFormElement>('#trace-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit(); await flush(); click(root, '#directory-open'); click(root, '#trace-open');
    expect(root.querySelector<HTMLButtonElement>('#trace-form button')!.disabled).toBe(false);
    finish(Response.json({ rows: [], next: null, partial: false, checkedAt: new Date().toISOString() })); await flush();
    submit(); await flush(); expect(searches).toBe(2);
  });
  it('replaces directory content with the selected top-level area', async () => {
    const { root } = mount(catalog); await flush(); await flush();
    expect(root.querySelector('#create-user')).not.toBeNull();
    click(root, '#trace-open');
    expect(root.querySelector('.trace-panel')).not.toBeNull();
    expect(root.querySelector('#create-user')).toBeNull();
    expect(root.querySelector('[data-resource="users"]')).toBeNull();
    click(root, '#health-open'); await flush();
    expect(root.querySelector('.health-panel')).not.toBeNull();
    expect(root.querySelector('.trace-panel')).toBeNull();
    click(root, '#directory-open');
    expect(root.querySelector('.health-panel')).toBeNull();
    expect(root.querySelector('#create-user')).not.toBeNull();
  });
  it('selects and removes groups, then preserves the account when a membership fails', async () => {
    const { root, request } = mount(catalog); await flush(); await flush();
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (path, init) => {
      if (path === '/microsoft/resources/groups') return inventory([
        {id:'g1',values:{displayName:'Team',groupKind:'Microsoft 365 group'}},
        {id:'g2',values:{displayName:'Announcements',groupKind:'Distribution list'}},
        {id:'g3',values:{displayName:'Dynamic',groupKind:'Microsoft 365 group',membershipRule:'rule'}},
      ]);
      if (path === '/microsoft/administration') {
        const op = JSON.parse(String(init?.body));
        if (op.type === 'user.create') return Response.json({accepted:true,id:'new-user',userPrincipalName:'qa@example.test',temporaryPassword:'one-time'});
        if (op.type === 'group.member.add') return Response.json({accepted:true,verified:true});
        if (op.type === 'distribution.member.set') return Response.json({error:'provider_unreachable'},{status:502});
      }
      return fallback(path, init);
    });
    click(root, '#create-user'); await flush(); await flush();
    expect(root.querySelector('#create-user-location')).toBeNull();
    expect(root.querySelector('#create-user-group')?.textContent).not.toContain('Dynamic');
    const select = (id:string) => { const node=root.querySelector<HTMLSelectElement>('#create-user-group')!; node.value=id; node.dispatchEvent(new Event('change')); };
    input(root, '#create-user-name', 'QA'); input(root, '#create-user-local', 'qa');
    select('g1'); select('g2'); click(root, '[data-create-group-remove="g1"]');
    expect(root.querySelector('[data-create-group-remove="g1"]')).toBeNull(); select('g1');
    expect(root.querySelector<HTMLInputElement>('#create-user-name')!.value).toBe('QA');
    click(root, '#create-user-submit'); await flush(); await flush();
    const writes=request.mock.calls.map(([,init])=>JSON.parse(String(init?.body||'{}'))).filter(op=>['user.create','group.member.add','distribution.member.set'].includes(op.type));
    expect(writes.map(op=>op.type)).toEqual(['user.create','distribution.member.set','group.member.add']);
    expect(writes[1]).toEqual({type:'distribution.member.set',groupId:'g2',memberId:'new-user',enabled:true});
    expect(writes[2]).toEqual({type:'group.member.add',groupId:'g1',userId:'new-user'});
    expect(root.textContent).toContain('Announcements: membership not confirmed');
    expect(root.textContent).toContain('Team: membership verified');
    expect(root.querySelector<HTMLInputElement>('[aria-label="Temporary password"]')!.value).toBe('one-time');
    expect(root.querySelector('#create-user-submit')).toBeNull();
  });

  it.each(['generated', 'custom'])('supports %s password with optional forced change', async mode => {
    const {root,request}=mount(catalog); await flush(); await flush();
    const fallback=request.getMockImplementation()!;
    request.mockImplementation(async (path,init)=>{
      const op=JSON.parse(String(init?.body||'{}'));
      if(op.type==='user.create') return Response.json({accepted:true,id:'created',userPrincipalName:'qa@example.test',temporaryPassword:op.user.password || 'generated-test-password'});
      return fallback(path,init);
    });
    click(root,'#create-user'); await flush(); await flush();
    expect(root.querySelector<HTMLInputElement>('#create-user-force-change')!.checked).toBe(true);
    const picker=root.querySelector<HTMLSelectElement>('#create-user-password-mode')!;
    picker.value=mode; picker.dispatchEvent(new Event('change'));
    input(root,'#create-user-name','QA'); input(root,'#create-user-local','qa');
    if(mode==='custom') input(root,'#create-user-password','Custom-Test-123!');
    click(root,'#create-user-force-change');
    click(root,'#create-user-submit'); await flush(); await flush();
    const op=request.mock.calls.map(([,init])=>JSON.parse(String(init?.body||'{}'))).find(op=>op.type==='user.create');
    expect(op.user.forceChangePasswordNextSignIn).toBe(false);
    expect(op.user.password).toBe(mode==='custom' ? 'Custom-Test-123!' : undefined);
    expect(root.textContent).toContain('A password change is not required at next sign-in.');
    click(root,'#create-user-close'); click(root,'#create-user'); await flush();
    expect(root.querySelector('#create-user-password')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('#create-user-force-change')!.checked).toBe(true);
  });

});
