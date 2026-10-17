import { describe, expect, it } from 'vitest';
import { defaultModifierRemap } from './keyboard';

describe('browser modifier mapping defaults', () => {
  it.each([
    ['Win32', 'windows', false],
    ['MacIntel', 'windows', true],
    ['Win32', 'macos', true],
    ['Win32', 'darwin', true],
    ['MacIntel', 'macos', false],
    ['MacIntel', 'darwin', false],
    ['Linux x86_64', 'windows', false],
    ['Win32', 'linux', false],
    ['MacIntel', 'linux', true],
    ['Win32', null, false],
  ])('%s to %s remap is %s', (local, remote, expected) => {
    expect(defaultModifierRemap(local, remote)).toBe(expected);
  });
});
