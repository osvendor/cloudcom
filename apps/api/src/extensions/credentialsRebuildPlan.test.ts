import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { digest, identity, inferredEmailProvider, normalizePreservingSecrets, preservedNote } from '../../scripts/credentials-rebuild-plan';
import { documentPayloadSchema } from '../../../../packages/ext-credentials/src/server/documentSecrets';
const record={name:'Widget API key',category:'old',username:'User',email:'',url:'',password:'=SUM(1,2)\r\n &<" ',otpSecret:' SecretBytes ',notes:'Original\nnotes'};
describe('credential rebuild preservation plan',()=>{
  it('preserves all secret bytes during label normalization',()=>{
    const normalized=normalizePreservingSecrets(record);
    expect(normalized).toMatchObject({password:record.password,otpSecret:record.otpSecret,notes:record.notes,disposition:'note'});
  });
  it('does not deduplicate different secrets, tenants or service identities',()=>{
    expect(identity('a',record)).not.toBe(identity('b',record));
    expect(identity('a',record)).not.toBe(identity('a',{...record,password:'different'}));
    expect(identity('a',record)).not.toBe(identity('a',{...record,otpSecret:'different'}));
    expect(identity('a',record)).not.toBe(identity('a',{...record,name:'Another service'}));
    expect(digest(record)).toBe(digest({...record}));
    expect(identity('a',record)).toBe(identity('a',{...record,email:'redundant@example.test',url:'https://other-login.example.test'}));
  });
  it('infers only a unique explicit tenant email provider',()=>{
    expect(inferredEmailProvider([{name:'Gmail',category:'Email'},{name:'Microsoft 365 Apps',category:'Application / Cloud'}])).toBeUndefined();
    expect(inferredEmailProvider([{name:'Microsoft 365',category:'Email'}])).toBe('microsoft');
    expect(inferredEmailProvider([{name:'Google Workspace',category:'Email'}])).toBe('google');
    expect(inferredEmailProvider([{name:'Google Workspace',category:'Email'},{name:'Microsoft 365',category:'Email'}])).toBeUndefined();
  });
  it('produces a valid ZIP workbook with literal inline secrets and matching Notes payload',async()=>{
    const payload=documentPayloadSchema.parse(await preservedNote(record));
    const archive=await JSZip.loadAsync(payload.originalBase64,{base64:true,checkCRC32:true});
    expect(archive.file('[Content_Types].xml')).not.toBeNull();
    const sheet=await archive.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('=SUM(1,2)&#13;\n &amp;&lt;&quot; ');
    expect(sheet).not.toContain('<f>');
    expect(payload.sheets[0]!.rows.find(row=>row.cells[0]?.text==='password')!.cells[1]!.text).toBe(record.password);
  });
  it('fails closed on data XLSX XML cannot preserve',async()=>{
    await expect(preservedNote({...record,password:'bad\u0000value'})).rejects.toThrow('control character');
  });
});
