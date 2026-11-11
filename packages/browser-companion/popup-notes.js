const el = (tag, text, attrs = {}) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  Object.assign(node, attrs);
  return node;
};
const columnNumber = value => /^[A-Z]{1,4}$/.test(value || '') ? [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : 1;

export function createNotesPanel({ root, send, context, message }) {
  let generation = 0;
  const imageUrls = new Set();
  const notice = el('div', null, { className: 'notes-notice', role: 'status' });
  const list = el('div', null, { className: 'notes-list' });
  root.append(notice, list);

  function resetView() {
    for (const url of imageUrls) URL.revokeObjectURL(url);
    imageUrls.clear(); list.replaceChildren();
  }
  function clear(text = 'Choose a client to view notes.') {
    generation++; notice.textContent = text; resetView();
  }
  function renderImage(image, index) {
    const figure = el('figure', null, { className: 'notes-image' });
    try {
      if (!image || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType) || typeof image.dataBase64 !== 'string' || image.dataBase64.length > 16_000_000) throw new Error('invalid image');
      const raw = atob(image.dataBase64);
      if (!raw.length || raw.length > 12_000_000) throw new Error('too large');
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const valid = image.mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
        : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : image.mimeType === 'image/gif' ? /^GIF8[79]a/.test(raw) : raw.slice(0, 4) === 'RIFF' && raw.slice(8, 12) === 'WEBP';
      if (!valid) throw new Error('invalid image');
      const img = el('img', null, { alt: `Note image ${index + 1}`, loading: 'lazy' });
      const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType })); imageUrls.add(url); img.src = url;
      img.onerror = () => { figure.replaceChildren(el('p', 'Image unavailable in this preview.')); URL.revokeObjectURL(url); imageUrls.delete(url); };
      figure.append(img);
    } catch { figure.append(el('p', 'Image unavailable in this preview.')); }
    return figure;
  }
  function renderPreview(preview, target) {
    const notepad = el('div', null, { className: 'notes-notepad' }); target.append(notepad);
    for (const sheet of preview.sheets || []) {
      notepad.append(el('h4', sheet.name || 'Notes'));
      // Retain source ordering rather than guessing which cells are notes or credentials.
      const entries = (sheet.rows || []).flatMap(row => (row.cells || []).map(cell => ({ row: row.row, column: columnNumber(cell.column), text: cell.text })));
      (sheet.images || []).forEach((image, index) => entries.push({ row: Number.isInteger(image.row) && image.row > 0 ? image.row : Number.MAX_SAFE_INTEGER, column: columnNumber(image.column), image, index }));
      entries.sort((a, b) => a.row - b.row || a.column - b.column);
      let currentRow, line;
      for (const entry of entries) {
        if (entry.row !== currentRow) { currentRow = entry.row; line = el('div', null, { className: 'notes-source-row' }); notepad.append(line); }
        const cell = el('div', null, { className: 'notes-source-cell' });
        cell.append(entry.image ? renderImage(entry.image, entry.index) : el('span', entry.text || '', { className: 'notes-text' })); line.append(cell);
      }
    }
    if (preview.previewTruncated) notepad.append(el('p', 'This imported preview is incomplete.', { className: 'notes-notice' }));
  }
  async function load() {
    const c = context(), g = ++generation; if (!c?.clientId && !c?.orgId) { clear(); return; }
    resetView(); notice.textContent = 'Loading notes…';
    try {
      const result = await send({ type: 'notesList', query: '' });
      if (g !== generation) return;
      const documents = Array.isArray(result?.documents) ? result.documents : [];
      if (!documents.length) { notice.textContent = 'No notes found.'; return; }
      for (const item of documents) {
        if (g !== generation) return;
        const article = el('article', null, { className: 'notes-document' });
        if (documents.length > 1) article.append(el('h3', item.name || 'Notes'));
        const content = el('div'); article.append(content); list.append(article);
        await readDocument(item, content, g);
      }
      if (g === generation) notice.textContent = '';
    }
    catch (error) { if (g === generation) { notice.textContent = error?.message || 'Could not load notes.'; message?.(notice.textContent); } }
  }
  async function readDocument(item, content, g) {
    if (g !== generation) return;
    content.replaceChildren(el('p', 'Loading notes…', { className: 'notes-notice' }));
    try {
      const result = await send({ type: 'notesRead', documentId: item.id });
      if (g !== generation) return;
      content.replaceChildren(); renderPreview(result, content);
    } catch {
      if (g !== generation) return;
      const retry = el('button', 'Retry', { type: 'button' });
      retry.onclick = () => readDocument(item, content, g);
      content.replaceChildren(el('p', `Could not load ${item.name || 'notes'}.`, { className: 'notes-notice' }), retry);
    }
  }
  return { load, clear, setVisible(value) { if (value) void load(); else clear(''); }, dispose() { clear(); notice.remove(); list.remove(); } };
}
