import {beforeEach,describe,it,expect,vi} from 'vitest';
// Exercise the actual function injected by the MV3 worker, not a parallel implementation.
import {websiteField} from '../../../browser-companion/policy.js';
beforeEach(()=>{document.body.innerHTML='';vi.stubGlobal('location',{href:'https://login.example.test/signin',protocol:'https:',origin:'https://login.example.test'});});
function input(type:string,autocomplete:string){const e=document.createElement('input');e.type=type;e.setAttribute('autocomplete',autocomplete);e.style.visibility='visible';document.body.append(e);vi.spyOn(e,'getBoundingClientRect').mockReturnValue({width:100,height:20} as DOMRect);return e;}
describe('website fill isolation',()=>{
 it('fills a unique visible field and never submits',()=>{const e=input('password','current-password');const change=vi.fn();e.addEventListener('input',change);expect(websiteField('inspect',location.href,'password')).toMatchObject({ok:true,index:0});expect(websiteField('fill',location.href,'password','synthetic',0)).toEqual({ok:true});expect(e.value).toBe('synthetic');expect(change).toHaveBeenCalledOnce();});
 it('rejects page navigation, ambiguous fields, new-password, hidden and read-only fields',()=>{
  const e=input('password','current-password');expect(websiteField('inspect','https://else.test','password').ok).toBe(false);
  const other=input('password','current-password');expect(websiteField('inspect',location.href,'password').ok).toBe(false);other.remove();
  e.autocomplete='new-password';expect(websiteField('inspect',location.href,'password').ok).toBe(false);e.autocomplete='current-password';e.readOnly=true;expect(websiteField('inspect',location.href,'password').ok).toBe(false);
 });
 it('requires an explicit OTP field and stable input index',()=>{input('text','one-time-code');expect(websiteField('inspect',location.href,'otp')).toMatchObject({ok:true,index:0});expect(websiteField('fill',location.href,'otp','123456',1).ok).toBe(false);});
 it('refuses cross-origin form actions',()=>{const e=input('password','current-password');const f=document.createElement('form');f.action='https://other.test/submit';document.body.append(f);f.append(e);expect(websiteField('inspect',location.href,'password').ok).toBe(false);});
});
