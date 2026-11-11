import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealDocument, unsealDocument, DOCUMENT_MAX_BYTES } from './documentSecrets';
const key=randomBytes(32);
const crypto={
  encryptForColumn(table:string,column:string,text:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(`${table}.${column}`));const b=Buffer.concat([c.update(text,'utf8'),c.final()]);return `enc:v3:${Buffer.concat([iv,c.getAuthTag(),b]).toString('base64')}`;},
  decryptForColumn(table:string,column:string,text:string){const b=Buffer.from(text.slice(7),'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from(`${table}.${column}`));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');},
};
const payload={version:1 as const,originalBase64:Buffer.from('synthetic').toString('base64'),sheets:[],previewTruncated:false};
describe('documentation encrypted bindings',()=>{
  it('roundtrips only in original row and organization',()=>{const ct=sealDocument(crypto,'org','id',payload);expect(unsealDocument(crypto,'org','id',ct)).toEqual(payload);expect(()=>unsealDocument(crypto,'other','id',ct)).toThrow();expect(()=>unsealDocument(crypto,'org','other',ct)).toThrow();});
  it('requires authenticated v3 encryption',()=>{expect(()=>sealDocument({...crypto,encryptForColumn:()=> 'enc:v2:test'},'org','id',payload)).toThrow();expect(()=>unsealDocument(crypto,'org','id','enc:v2:test')).toThrow();});
  it('bounds original and preview data and rejects invalid base64',()=>{for(const originalBase64 of ['', 'not-base64',Buffer.alloc(DOCUMENT_MAX_BYTES+1).toString('base64')])expect(()=>sealDocument(crypto,'org','id',{...payload,originalBase64})).toThrow();expect(()=>sealDocument(crypto,'org','id',{...payload,sheets:[{name:'sheet',imageCount:0,rows:Array.from({length:30},(_,i)=>({row:i+1,cells:[{column:'A',text:'x'.repeat(100000)}]}))}]})).toThrow();});
});
