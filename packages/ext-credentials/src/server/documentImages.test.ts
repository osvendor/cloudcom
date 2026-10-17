import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractDocumentImages } from './documentImages';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
function zip(files: Record<string, string | Buffer>, deflate = false) {
  const bodies: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), compressed = deflate ? deflateRawSync(bytes) : bytes, filename = Buffer.from(name);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(deflate ? 8 : 0, 8); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    bodies.push(header, filename, compressed); directory.push(central, filename); offset += header.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, central, end]);
}
function fixture(options: { target?: string; external?: boolean; image?: Buffer; anchor?: string; drawing?: string; sheetName?: string } = {}) {
  return {
    'xl/workbook.xml': `<workbook><sheets><sheet name="${options.sheetName ?? 'Notes &amp; secrets'}" r:id="s1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><drawing r:id="d1"/></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="d1" Target="../drawings/drawing1.xml"/></Relationships>',
    'xl/drawings/drawing1.xml': options.drawing ?? `<xdr:wsDr><xdr:${options.anchor ?? 'twoCellAnchor'}><xdr:from><xdr:col>27</xdr:col><xdr:row>4</xdr:row></xdr:from><xdr:pic><a:blip r:embed="i1"/></xdr:pic></xdr:${options.anchor ?? 'twoCellAnchor'}></xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': `<Relationships><Relationship Id="i1" Target="${options.target ?? '../media/image1.png'}" ${options.external ? 'TargetMode="External"' : ''}/></Relationships>`,
    'xl/media/image1.png': options.image ?? png,
  };
}
const sheets = [{ name: 'Notes & secrets', imageCount: 1 }];
describe('embedded workbook images', () => {
  it.each([false, true])('extracts an anchored PNG from stored/deflated ZIP (%s)', deflate => {
    const result = extractDocumentImages(zip(fixture(), deflate), sheets);
    expect(result).toEqual([{ images: [{ id: 'sheet-1-image-1', row: 5, column: 'AB', mimeType: 'image/png', dataBase64: png.toString('base64') }], imagesOmitted: 0 }]);
  });
  it('handles one-cell and absolute anchors without assigning false cells', () => {
    expect(extractDocumentImages(zip(fixture({ anchor: 'oneCellAnchor' })), sheets)[0].images[0].row).toBe(5);
    const drawing = '<xdr:absoluteAnchor><xdr:pic><a:blip r:embed="i1"/></xdr:pic></xdr:absoluteAnchor>';
    expect(extractDocumentImages(zip(fixture({ drawing })), sheets)[0].images[0]).toMatchObject({ row: null, column: null });
  });
  it.each([{ external: true }, { target: 'https://example.test/image.png' }, { target: '../../../outside.png' }, { target: '../media/image.svg', image: Buffer.from('<svg/>') }])('does not load external/escaped/active images %j', options => {
    expect(extractDocumentImages(zip(fixture(options)), sheets)).toEqual([{ images: [], imagesOmitted: 1 }]);
  });
  it('does not trust extensions or sheet order without matching sheet name', () => {
    expect(extractDocumentImages(zip(fixture({ image: Buffer.from('<svg><script/></svg>') })), sheets)[0].images).toEqual([]);
    expect(extractDocumentImages(zip(fixture({ sheetName: 'Other client notes' })), sheets)[0].images).toEqual([]);
  });
  it('rejects DTD/entity metadata without fetching anything', () => {
    expect(extractDocumentImages(zip(fixture({ drawing: '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><x/>' })), sheets)[0].images).toEqual([]);
  });
  it('bounds decompression and falls back to the text preview', () => {
    expect(extractDocumentImages(zip(fixture({ image: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]) }), true), sheets)[0]).toEqual({ images: [], imagesOmitted: 1 });
    expect(extractDocumentImages(Buffer.from('corrupt zip'), sheets)).toEqual([{ images: [], imagesOmitted: 1 }]);
  });
  it('keeps supported images if a sibling is unsupported and reports omissions', () => {
    const files = fixture(); files['xl/drawings/drawing1.xml'] = '<xdr:oneCellAnchor><a:blip r:embed="i1"/><a:blip r:embed="bad"/></xdr:oneCellAnchor>';
    files['xl/drawings/_rels/drawing1.xml.rels'] = '<Relationships><Relationship Id="i1" Target="../media/image1.png"/><Relationship Id="bad" Target="../media/unsupported.emf"/></Relationships>';
    const result = extractDocumentImages(zip({ ...files, 'xl/media/unsupported.emf': 'unsupported image' }), [{ ...sheets[0], imageCount: 2 }]);
    expect(result[0].images).toHaveLength(1); expect(result[0].imagesOmitted).toBe(1);
  });
});

