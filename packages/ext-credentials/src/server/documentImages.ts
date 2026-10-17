import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';

export type DocumentImage = { id: string; row: number | null; column: string | null; mimeType: string; dataBase64: string };
const MAX_IMAGE = 4 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_XML = 2 * 1024 * 1024;
type Entry = { offset: number; compressed: number; size: number; method: number };
// Read only bounded ZIP members. No extraction to disk, external fetches, or ZIP64.
function archive(bytes: Buffer) {
  const entries = new Map<string, Entry>();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Invalid workbook ZIP');
  const count = bytes.readUInt16LE(end + 10), directoryEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  if (count > 10000 || directoryEnd > end) throw new Error('Invalid workbook ZIP');
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid workbook ZIP');
    const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    if (cursor + 46 + length + extra + comment > directoryEnd || bytes.readUInt16LE(cursor + 8) & 1) throw new Error('Invalid workbook ZIP');
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    if (entries.has(name) || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new Error('Invalid workbook ZIP');
    entries.set(name, { offset: bytes.readUInt32LE(cursor + 42), compressed: bytes.readUInt32LE(cursor + 20), size: bytes.readUInt32LE(cursor + 24), method: bytes.readUInt16LE(cursor + 10) });
    cursor += 46 + length + extra + comment;
  }
  let expanded = 0;
  return (path: string, maximum: number) => {
    const entry = entries.get(path);
    if (!entry) return null;
    if (entry.size > maximum || expanded + entry.size > 32 * 1024 * 1024 || entry.offset + 30 > bytes.length || bytes.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error('Workbook member limit');
    const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
    if (start + entry.compressed > bytes.length) throw new Error('Invalid workbook member');
    const compressed = bytes.subarray(start, start + entry.compressed);
    const value = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: maximum }) : null;
    if (!value || value.length !== entry.size) throw new Error('Invalid workbook member');
    expanded += value.length;
    return value;
  };
}
function decode(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) { const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[entity] ?? '';
  });
}
function attributes(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], decode(m[2] ?? m[3])]));
}
function xml(bytes: Buffer | null) {
  const text = bytes?.toString('utf8') ?? '';
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported workbook XML');
  return text;
}
function relationships(read: ReturnType<typeof archive>, part: string) {
  const path = posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
  const result = new Map<string, string>();
  for (const match of xml(read(path, MAX_XML)).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const a = attributes(match[0]);
    if (!a.Id || !a.Target || a.TargetMode?.toLowerCase() === 'external' || /[:\\?#\x00-\x1f]/.test(a.Target)) continue;
    const target = a.Target.startsWith('/') ? posix.normalize(a.Target.slice(1)) : posix.normalize(posix.join(posix.dirname(part), a.Target));
    if (!target.startsWith('xl/') || target.split('/').includes('..')) continue;
    result.set(a.Id, target);
  }
  return result;
}
function mime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function column(index: number) { let value = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + (n - 1) % 26) + value; return value; }

/** Best-effort derived preview; originals remain available when an image is unsupported. */
export function extractDocumentImages(original: Buffer, sheets: { name: string; imageCount: number }[]) {
  const result = sheets.map(sheet => ({ images: [] as DocumentImage[], imagesOmitted: sheet.imageCount }));
  let total = 0, count = 0;
  try {
    const read = archive(original), workbook = 'xl/workbook.xml', sheetParts = relationships(read, workbook);
    const tags = [...xml(read(workbook, MAX_XML)).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)];
    for (let index = 0; index < sheets.length; index++) {
      const tag = tags[index];
      if (!tag) continue;
      const a = attributes(tag[0]), part = sheetParts.get(a['r:id']);
      if (!part || a.name !== sheets[index].name || !part.startsWith('xl/worksheets/')) continue;
      const drawings = relationships(read, part);
      for (const drawing of xml(read(part, MAX_XML)).matchAll(/<(?:\w+:)?drawing\b[^>]*>/g)) {
        const drawingPart = drawings.get(attributes(drawing[0])['r:id']);
        if (!drawingPart?.startsWith('xl/drawings/')) continue;
        const imageParts = relationships(read, drawingPart);
        for (const anchor of xml(read(drawingPart, MAX_XML)).matchAll(/<(?:\w+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1\s*>/g)) {
          const from = anchor[2].match(/<(?:\w+:)?from\b[^>]*>([\s\S]*?)<\/(?:\w+:)?from\s*>/)?.[1];
          const row = from?.match(/<(?:\w+:)?row\b[^>]*>(\d+)<\/(?:\w+:)?row\s*>/)?.[1];
          const col = from?.match(/<(?:\w+:)?col\b[^>]*>(\d+)<\/(?:\w+:)?col\s*>/)?.[1];
          for (const blip of anchor[2].matchAll(/<(?:\w+:)?blip\b[^>]*>/g)) {
            const target = imageParts.get(attributes(blip[0])['r:embed']);
            if (!target?.startsWith('xl/media/') || count >= 100) continue;
            try {
              const image = read(target, MAX_IMAGE), mimeType = image && mime(image);
              if (!image || !mimeType || total + image.length > MAX_TOTAL) continue;
              total += image.length; count++;
              result[index].images.push({ id: `sheet-${index + 1}-image-${result[index].images.length + 1}`, row: row !== undefined && Number(row) < 1048576 ? Number(row) + 1 : null, column: col !== undefined && Number(col) < 16384 ? column(Number(col)) : null, mimeType, dataBase64: image.toString('base64') });
            } catch { /* An unsupported image must not hide the rest of the workbook. */ }
          }
        }
      }
      result[index].imagesOmitted = Math.max(0, sheets[index].imageCount - result[index].images.length);
    }
  } catch { /* Preserve the text preview if original drawing metadata is malformed. */ }
  return result;
}

