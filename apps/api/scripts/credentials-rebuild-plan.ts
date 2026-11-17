import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { normalizeCredential, type CredentialNormalizationInput } from '../../../packages/ext-credentials/src/import/normalize';
import type { DocumentPayload } from '../../../packages/ext-credentials/src/server/documentSecrets';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const identity = (orgId: string, value: CredentialNormalizationInput) => digest([orgId,value.name,value.category,value.username,value.password,value.otpSecret]);
export const secretIdentity = (orgId:string,value:CredentialNormalizationInput) => digest([orgId,value.username,value.password,value.otpSecret]);
export function inferredEmailProvider(values: readonly {name:string;category:string}[]):'google'|'microsoft'|undefined {
  const providers=new Set(values.flatMap(v=>v.category!=='Email'?[]:v.name==='Microsoft 365'?['microsoft' as const]:v.name==='Google Workspace'?['google' as const]:[]));
  return providers.size===1?[...providers][0]:undefined;
}
export function normalizePreservingSecrets(value: CredentialNormalizationInput) {
  const result=normalizeCredential(value);
  for(const key of ['password','otpSecret','notes','username','email','url'] as const)
    if(result[key]!==value[key])throw Error('Preservation proof failed');
  return result;
}
// Inline strings never become Excel formulas, even when a secret starts with '='.
function xml(value:string) {
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error('Unsupported workbook control character');
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;');
}
export async function preservedNote(value: CredentialNormalizationInput):Promise<DocumentPayload> {
  const values=Object.entries(value);
  const rows=values.map(([label,text],i)=>({row:i+1,cells:[{column:'A',text:label},{column:'B',text}]}));
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml','<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Preserved note" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml','<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows.map(r=>`<row r="${r.row}">`+r.cells.map(c=>`<c r="${c.column}${r.row}" t="inlineStr"><is><t xml:space="preserve">${xml(c.text)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>');
  return {version:1,originalBase64:await zip.generateAsync({type:'base64',compression:'DEFLATE'}),sheets:[{name:'Preserved note',rows,imageCount:0}],previewTruncated:false};
}
