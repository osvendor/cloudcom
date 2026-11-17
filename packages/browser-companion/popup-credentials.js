export const ACCOUNT_TYPES = ['Email', 'Local / Domain', 'Application / Cloud', 'Network / Wi-Fi'];

/** All secret material is transient DOM/memory only. The server owns generation and drafts. */
export function createCredentialsPanel({root, send, context, message = () => {}}) {
  const document = root.ownerDocument;
  const list = root.querySelector('#loginList'), scope = root.querySelector('#loginScope'), search = root.querySelector('#loginSearch');
  let generation = 0, listSequence = 0, org = null, admin = false, editing = null, pending = {}, inFlight = false, timer;
  let blocked = false, createRequest = null, creating = false, records = [], generatedValue = '';
  let saveTask = Promise.resolve(), sectionSequence = 0, passwordRevision = 0, disclosureRevision = 0, clientEmailDefaults = null;
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };
  const button = (text, action) => { const n = node('button', 'small-button', text); n.type = 'button'; n.onclick = action; return n; };
  const toolbar = node('div', 'credential-toolbar');
  const sections = node('div', 'credential-sections'); sections.setAttribute('aria-label', 'Credential section');
  const userButton = button('User accounts', () => selectSection(false));
  const adminButton = button('Client administration', () => selectSection(true));
  sections.append(userButton, adminButton);
  const newButton = button('＋ Generate password', create); newButton.classList.add('credential-new');
  toolbar.append(sections, newButton);
  const editor = node('div', 'credential-editor'); editor.hidden = true;
  const status = node('div', 'credential-save'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  root.insertBefore(toolbar, scope); root.insertBefore(editor, list); root.insertBefore(status, list);

  const current = (token, client) => token === generation && client === context().orgId && client === org;
  function clearSecret() { disclosureRevision++; generatedValue = ''; const password = editor.querySelector('[data-field="password"]'); if (password) { password.value = ''; password.type = 'password'; } const otp = editor.querySelector('[data-field="otpSecret"]'); if (otp) otp.value = ''; }
  async function prepareClientChange() {
    const token = generation, client = org;
    if (creating) { status.textContent = 'Wait for the new draft to finish saving.'; return false; }
    await flush();
    return token === generation && client === org && (!client || current(token, client)) && !blocked && !inFlight && !Object.keys(pending).length;
  }
  function clear(text = 'Choose a client to view logins.') {
    generation++; listSequence++; sectionSequence++; clearTimeout(timer); clearSecret(); org = null; editing = null; pending = {}; inFlight = false; blocked = false; saveTask = Promise.resolve();
    createRequest = null; creating = false; records = []; clientEmailDefaults = null; editor.replaceChildren(); editor.hidden = true; status.textContent = '';
    newButton.disabled = true; newButton.textContent = '＋ Generate password'; list.replaceChildren(node('div', 'empty', text));
  }
  async function selectSection(value) {
    const token = generation, client = org, sequence = ++sectionSequence;
    if (creating) { status.textContent = 'Wait for the new draft to finish saving.'; return; }
    if (inFlight || Object.keys(pending).length) await flush();
    if (token !== generation || client !== org || sequence !== sectionSequence) return;
    if (blocked) return;
    if (inFlight || Object.keys(pending).length) { status.textContent = 'Changes are not saved. Finish saving before switching sections.'; return; }
    clearSecret(); editing = null; editor.replaceChildren(); editor.hidden = true;
    admin = value; userButton.setAttribute('aria-pressed', String(!admin)); adminButton.setAttribute('aria-pressed', String(admin)); renderList();
  }
  function renderList() {
    list.replaceChildren();
    const matching = records.filter(c => Boolean(c.isAdministration) === admin);
    for (const c of matching) {
      const row = node('article', 'credential-row');
      const head = node('div', 'credential-line'); const details = button(c.name || c.category || 'New credential', () => open(c)); details.className = 'credential-open';
      head.append(details, node('span', 'credential-kind', c.category || 'Unclassified')); row.append(head);
      row.append(node('div', 'meta', c.username || c.email || 'Add username'));
      const creationMessage = {pending:'Microsoft creation pending',unknown:'Microsoft result unknown · reconcile before retrying',rejected:'Microsoft creation rejected'}[c.creationState];
      if (creationMessage || c.isDraft || c.temporaryPassword) row.append(node('div', 'credential-draft', creationMessage || (c.isDraft ? 'Draft · complete missing details' : 'Temporary password')));
      const actions = node('div', 'actions');
      for (const [field, label, enabled] of [['username', 'Username', c.username || c.email], ['password', 'Password', c.hasPassword], ['otp', '2FA', c.hasOtp]]) {
        const action = button((scope.value === 'site' ? 'Fill ' : 'Copy ') + label, () => disclose(c, field)); action.disabled = !enabled; actions.append(action);
      }
      row.append(actions); list.append(row);
    }
    if (!matching.length) list.append(node('div', 'empty', 'No ' + (admin ? 'client administration' : 'user') + ' credentials found.'));
  }
  async function load() {
    const client = context().orgId; if (!client) { clear(); return; }
    if (org !== client) { clear('Loading logins…'); org = client; }
    newButton.disabled = creating; const token = generation, seq = ++listSequence;
    try {
      const data = await send({type: scope.value === 'site' ? 'credentials' : 'vaultList', query: search.value});
      if (!current(token, client) || seq !== listSequence) return;
      if (Object.hasOwn(data, 'emailDefaults')) clientEmailDefaults = data.emailDefaults;
      records = data.credentials || []; renderList();
      if (data.truncated) list.append(node('div', 'empty', 'Refine your search to see more results.'));
    } catch (error) { if (current(token, client) && seq === listSequence) list.replaceChildren(node('div', 'empty', error.message)); }
  }
  function field(label, name, value = '', type = 'text') {
    const wrap = node('label', 'credential-field'); wrap.append(node('span', '', label));
    const input = node('input'); input.type = type; input.value = value; input.autocomplete = 'off'; input.dataset.field = name;
    input.oninput = () => queue({[name]: input.value}); wrap.append(input); return wrap;
  }
  function open(c, value = '', emailDefaults = clientEmailDefaults) {
    if (inFlight || Object.keys(pending).length) { status.textContent = 'Finish saving this credential before opening another.'; return; }
    clearSecret(); editing = {...c}; blocked = false; editor.replaceChildren(); editor.hidden = false;
    const heading = node('div', 'credential-line'); heading.append(node('strong', '', c.isDraft ? 'Complete credential' : 'Edit credential'));
    heading.append(button('Close', () => { if (inFlight || Object.keys(pending).length) { status.textContent = 'Changes are not saved yet.'; return; } clearSecret(); editor.hidden = true; editing = null; })); editor.append(heading);
    const category = node('label', 'credential-field'); category.append(node('span', '', 'Account type'));
    const select = node('select', 'select'); select.dataset.field = 'category';
    for (const type of ACCOUNT_TYPES) { const option = node('option', '', type); option.value = type; select.append(option); }
    select.value = ACCOUNT_TYPES.includes(c.category) ? c.category : 'Application / Cloud';
    let previousCategory = select.value;
    select.onchange = () => {
      const fields = {category: select.value};
      const input = url.querySelector('input');
      if (editing?.isDraft && previousCategory === 'Email' && select.value !== 'Email' && ['https://admin.microsoft.com', 'https://login.microsoftonline.com', 'https://admin.google.com', 'https://accounts.google.com'].includes(input.value)) { input.value = ''; fields.url = ''; }
      previousCategory = select.value; updateType(); queue(fields);
    }; category.append(select); editor.append(category);
    const usernameField = field('Username or email', 'username', c.username || c.email || '');
    const username = usernameField.querySelector('input');
    const domain = typeof emailDefaults?.domain === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(emailDefaults.domain) ? emailDefaults.domain : null;
    const provider = {microsoft: 'Microsoft 365', google: 'Google Workspace'}[emailDefaults?.provider] || null;
    const emailHint = node('div', 'meta', [provider, domain ? '@' + domain : null].filter(Boolean).join(' · '));
    emailHint.hidden = select.value !== 'Email';
    username.onblur = () => {
      if (select.value !== 'Email' || !domain || blocked || editing?.id !== c.id || org !== context().orgId) return;
      if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(username.value)) { username.value += '@' + domain; queue({username: username.value}); }
    };
    editor.append(usernameField, emailHint);
    const administration = node('label', 'credential-admin'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(c.isAdministration); checkbox.dataset.field = 'isAdministration';
    const yesNo = node('span', 'credential-kind', checkbox.checked ? 'Yes' : 'No');
    checkbox.onchange = () => { yesNo.textContent = checkbox.checked ? 'Yes' : 'No'; updateType(); queue({isAdministration: checkbox.checked}); };
    administration.append(checkbox, node('span', '', 'Account / tenant administration'), yesNo); if (admin) editor.append(administration);
    const url = field('Login URL', 'url', c.url || '', 'url'); url.hidden = !checkbox.checked; editor.append(url);
    const secret = field('Password', 'password', '', 'password'); const password = secret.querySelector('input'); password.placeholder = c.hasPassword ? 'Saved password · type to replace' : 'Enter a password';
    editor.append(secret);
    const secretActions = node('div', 'actions');
    secretActions.append(button('Show', async event => {
      const trigger = event.currentTarget;
      const token = generation, client = org, id = editing?.id, revision = passwordRevision, disclosure = disclosureRevision;
      if (password.type === 'text') { password.type = 'password'; trigger.textContent = 'Show'; return; }
      try {
        if (!password.value) { const data = await send({type: 'copySecret', credentialId: id, field: 'password'}); if (!current(token, client) || editing?.id !== id || revision !== passwordRevision || disclosure !== disclosureRevision) return; generatedValue = data.value || ''; password.value = generatedValue; }
        password.type = 'text'; trigger.textContent = 'Hide';
      } catch (error) { if (current(token, client)) status.textContent = error.message; }
    }), button('Copy', async () => {
      const token = generation, client = org, id = editing?.id, revision = passwordRevision, disclosure = disclosureRevision;
      try {
        const value = password.value || (await send({type: 'copySecret', credentialId: id, field: 'password'})).value || '';
        if (!current(token, client) || editing?.id !== id || revision !== passwordRevision || disclosure !== disclosureRevision) return;
        await navigator.clipboard.writeText(value);
        if (current(token, client)) message('Password copied.');
      } catch { if (current(token, client)) status.textContent = 'Could not copy password.'; }
    }), button('Regenerate', () => {
      const prompt = editor.querySelector('.credential-regenerate'); prompt.hidden = !prompt.hidden;
    })); editor.append(secretActions);
    const regenerate = node('div', 'credential-regenerate'); regenerate.hidden = true; regenerate.append(node('span', 'meta', 'Replace the stored password? This does not change the account itself.'), button('Replace password', () => { regenerate.hidden = true; queue({generatePassword: true}, true); })); editor.append(regenerate);
    const otp = field('2FA setup secret · optional', 'otpSecret', '', 'password'); otp.hidden = !checkbox.checked; otp.querySelector('input').placeholder = c.hasOtp ? 'Saved · type to replace' : 'Add setup secret'; editor.append(otp);
    function updateType() {
      const webAccount = checkbox.checked && ['Email', 'Application / Cloud'].includes(select.value);
      url.hidden = !webAccount; otp.hidden = !webAccount;
      emailHint.hidden = select.value !== 'Email';
      usernameField.querySelector('span').textContent = select.value === 'Local / Domain' ? 'Username' : select.value === 'Network / Wi-Fi' ? 'Username (optional)' : 'Username or email';
    }
    updateType();
    if (c.isDraft) editor.append(button('Mark complete', () => { username.onblur(); return queue({isDraft: false}, true); }));
    if (value) { generatedValue = value; password.value = value; }
    status.textContent = c.isDraft ? 'Draft saved. Add the missing details.' : 'Changes save automatically.';
  }
  async function create() {
    const client = context().orgId; if (!client || creating) return;
    if (inFlight || Object.keys(pending).length) { status.textContent = 'Save the current changes first.'; return; }
    if (org !== client) { clear(); org = client; }
    const token = generation; creating = true; newButton.disabled = true;
    createRequest ||= {type: 'credentialCreate', expectedOrgId: client, requestId: crypto.randomUUID(), category: 'Email', isAdministration: admin};
    status.textContent = 'Generating and saving password…';
    try {
      const data = await send(createRequest); if (!current(token, client)) return;
      if (!data.credential?.id) throw Error('Draft could not be confirmed. Retry to retrieve it.');
      clientEmailDefaults = data.emailDefaults || null;
      createRequest = null; scope.value = 'all'; search.value = ''; admin = Boolean(data.credential.isAdministration);
      userButton.setAttribute('aria-pressed', String(!admin)); adminButton.setAttribute('aria-pressed', String(admin));
      records = [data.credential, ...records.filter(x => x.id !== data.credential.id)]; renderList(); open(data.credential, data.value || '', data.emailDefaults);
      newButton.textContent = '＋ Generate password';
    } catch (error) { if (current(token, client)) { status.textContent = error.message + ' No new password will be generated on retry.'; newButton.textContent = 'Retry draft'; } }
    finally { if (current(token, client)) { creating = false; newButton.disabled = false; } }
  }
  function queue(fields, immediate = false) {
    if (!editing || org !== context().orgId) return;
    if (blocked) return;
    if (fields.generatePassword) { delete pending.password; passwordRevision++; }
    if (Object.hasOwn(fields, 'password')) { delete pending.generatePassword; passwordRevision++; }
    pending = {...pending, ...fields}; clearTimeout(timer);
    status.textContent = 'Unsaved changes…';
    if (immediate) return flush();
    timer = setTimeout(flush, 600);
  }
  function flush() {
    if (inFlight) return saveTask;
    saveTask = performFlush();
    return saveTask;
  }
  async function performFlush() {
    clearTimeout(timer); if (blocked || inFlight || !editing || !Object.keys(pending).length || org !== context().orgId) return;
    const token = generation, client = org, id = editing.id, fields = pending, revision = passwordRevision, disclosure = disclosureRevision; pending = {}; inFlight = true; status.textContent = 'Saving…';
    try {
      const data = await send({type: 'credentialUpdate', expectedOrgId: client, credentialId: id, version: editing.version, fields});
      if (!current(token, client) || editing?.id !== id) return;
      if (data.credential?.id !== id || !Number.isSafeInteger(data.credential.version) || data.credential.version <= editing.version) throw Error('Saved version could not be confirmed.');
      editing = {...data.credential}; records = [editing, ...records.filter(x => x.id !== id)]; renderList();
      if (!Object.hasOwn(pending, 'url')) editor.querySelector('[data-field="url"]').value = editing.url || '';
      if (data.value && revision === passwordRevision && disclosure === disclosureRevision) { generatedValue = data.value; const input = editor.querySelector('[data-field="password"]'); input.value = generatedValue; input.type = 'password'; }
      if (fields.otpSecret !== undefined && pending.otpSecret === undefined) editor.querySelector('[data-field="otpSecret"]').value = '';
      status.textContent = Object.keys(pending).length ? 'Saving next change…' : '✓ Saved';
      if (fields.isDraft === false) { const complete = [...editor.querySelectorAll('button')].find(b => b.textContent === 'Mark complete'); complete?.remove(); }
    } catch (error) {
      if (current(token, client) && editing?.id === id) { blocked = true; pending = {...fields, ...pending}; status.textContent = 'Not saved: ' + error.message + ' Reload before retrying.';
        status.append(button('Reload saved version', async () => { clearSecret(); pending = {}; editing = null; blocked = false; editor.hidden = true; await load(); })); }
    } finally { if (current(token, client) && editing?.id === id) { inFlight = false; if (!blocked && Object.keys(pending).length) await flush(); } }
  }
  async function disclose(c, field) {
    const token = generation, client = org;
    try {
      if (scope.value === 'site') { await send({type: 'fill', credentialId: c.id, field}); if (current(token, client)) message('Field filled.'); return; }
      const data = field === 'username' ? {value: c.username || c.email || ''} : await send({type: 'copySecret', credentialId: c.id, field});
      if (!current(token, client)) return;
      await navigator.clipboard.writeText(data.value || ''); if (current(token, client)) message('Copied. Paste into the intended field.');
    } catch (error) { if (current(token, client)) message(error.message); }
  }
  selectSection(false);
  return {load, clear, flush, prepareClientChange, setVisible(visible) { if (!visible) clearSecret(); }};
}
