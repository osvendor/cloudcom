import { describe,it,expect,vi } from 'vitest';
vi.mock('../db',()=>({db:{execute:vi.fn()}}));
import { harmonySecurityEvidence } from './harmonySecurity';
it('preserves unknown RTP and does not interpret cumulative infections as active threats',()=>{
  const result=harmonySecurityEvidence({realTimeProtection:null,antiMalwareStatus:'Enabled',infectedCount:100} as never,'2026-10-15T12:00:00Z',Date.parse('2026-10-15T12:01:00Z'));
  expect(result.realTimeProtection).toBeNull();expect(result.stale).toBe(false);expect(result).not.toHaveProperty('threatsDetected');expect(result).not.toHaveProperty('status');
});
it('labels expired evidence stale',()=>{expect(harmonySecurityEvidence({realTimeProtection:null} as never,'2026-10-15T12:00:00Z',Date.parse('2026-10-15T12:31:00Z')).stale).toBe(true);});
