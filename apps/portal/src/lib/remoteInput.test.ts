import { describe, it, expect } from 'vitest';
import { remoteKey, remotePoint, remoteSessionIsLive, remoteWheel } from './remoteInput';
describe('remote viewer protocol boundaries', () => {
  it('converts browser pixels to agent wheel steps without multiplying scrolling by 120', () => {
    expect(remoteWheel(0, 100, 0)).toEqual({ steps: 1, remainder: 0 });
    expect(remoteWheel(40, 60, 0)).toEqual({ steps: 1, remainder: 0 });
    expect(remoteWheel(0, -3, 1).steps).toBe(-3);
    expect(remoteWheel(0, 1, 2).steps).toBe(10);
    expect(remoteWheel(0, Infinity, 0).steps).toBe(0);
  });
  it.each(['disconnected','denied','failed','unknown',''])('closes on %s', status => expect(remoteSessionIsLive(status, 'none')).toBe(false));
  it('closes on a terminal fence even if a stale status is active', () => {
    expect(remoteSessionIsLive('active', 'pending')).toBe(false);
    expect(remoteSessionIsLive('active', 'confirmed')).toBe(false);
    expect(remoteSessionIsLive('active', 'none')).toBe(true);
  });
  it('maps physical keys to the agent protocol', () => {
    expect(remoteKey('KeyA', 'A')).toBe('a'); expect(remoteKey('ControlLeft', 'Control')).toBe('ctrl');
    expect(remoteKey('F12', 'F12')).toBe('f12'); expect(remoteKey('Numpad3', '3')).toBe('num3');
    expect(remoteKey('Equal', '+')).toBe('='); expect(remoteKey('Unidentified', 'Unidentified')).toBeNull();
  });
  it('excludes letterbox bars and handles scaled coordinates', () => {
    const box = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(remotePoint(500, 10, box, 1920, 1080)).toBeNull();
    expect(remotePoint(500, 500, box, 1920, 1080)).toEqual({ x: 960, y: 540 });
    expect(remotePoint(1, 1, box, 0, 0)).toBeNull();
  });
});
