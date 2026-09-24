import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICIAL_RELEASE_REPOSITORY,
  getReleaseDownloadUrl,
  getReleaseSourceApiBase,
  getReleaseSourceReleaseBase,
  getReleaseSourceRepository,
  getWindowsReleaseSource,
  getWindowsReleaseAssetUrl,
  getWindowsReleaseCanaryVersion,
  isWindowsReleasePromotionEnabled,
  isOfficialReleaseSource,
} from './releaseSource';

describe('releaseSource', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_WINDOWS_GITHUB_REPOSITORY;
    delete process.env.BINARY_WINDOWS_VERSION;
    delete process.env.BINARY_WINDOWS_CANARY_DEVICE_ID;
    delete process.env.BINARY_WINDOWS_PROMOTE_ENABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to the official repository', () => {
    expect(getReleaseSourceRepository()).toBe(OFFICIAL_RELEASE_REPOSITORY);
    expect(isOfficialReleaseSource()).toBe(true);
  });

  it('resolves BINARY_GITHUB_REPOSITORY as the override', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceRepository()).toBe('acme/breeze-selfhost-signing');
    expect(isOfficialReleaseSource()).toBe(false);
  });

  it('treats a case-variant of the official repo as official', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'LanternOps/breeze';
    expect(isOfficialReleaseSource()).toBe(true);
  });

  it('falls back to the legacy GITHUB_REPO alias when BINARY_GITHUB_REPOSITORY is unset', () => {
    process.env.GITHUB_REPO = 'LanternOps/breeze';
    expect(getReleaseSourceRepository()).toBe('LanternOps/breeze');
  });

  it('prefers BINARY_GITHUB_REPOSITORY over the legacy alias', () => {
    process.env.GITHUB_REPO = 'legacy/repo';
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceRepository()).toBe('acme/breeze-selfhost-signing');
  });

  it.each([
    'no-slash',
    'a/b/c',
    'owner/repo?x=1',
    'owner/../repo',
    '../etc/passwd',
    'owner/repo#frag',
    'owner /repo',
    'https://github.com/owner/repo',
    // These satisfy the character class — the repo segment allows dots — so
    // the regex alone does NOT deliver the module's "no path traversal"
    // promise. `owner/..` builds https://api.github.com/repos/owner/.. which
    // normalizes to the API root. Not exploitable (the owner class excludes
    // `/`, `@`, `%` and dots, so one `..` can never reach a second repository,
    // and every builder uses a literal host) — but a typo'd override must fail
    // loudly rather than 404 mysteriously.
    'owner/..',
    'owner/.',
    './repo',
    '../repo',
    // Other shapes a hand-edited .env can produce.
    'owner@evil/repo',
    'owner\n/repo',   // interior newline (a trailing one is legitimately trimmed)
    'owner/repо', // Cyrillic 'о' homoglyph
    '/repo',
    'owner/',
  ])('rejects malformed repository %j', (bad) => {
    process.env.BINARY_GITHUB_REPOSITORY = bad;
    expect(() => getReleaseSourceRepository()).toThrow(/Invalid release source repository/);
  });

  it('trims surrounding whitespace rather than rejecting it (.env values often carry a trailing newline)', () => {
    process.env.BINARY_GITHUB_REPOSITORY = '  acme/breeze-selfhost-signing\n';
    expect(getReleaseSourceRepository()).toBe('acme/breeze-selfhost-signing');
  });

  it('treats a whitespace-only override as unset (compose always injects the key)', () => {
    process.env.BINARY_GITHUB_REPOSITORY = '   ';
    expect(getReleaseSourceRepository()).toBe('lanternops/breeze');
  });

  it('still accepts a legitimate repository name containing dots', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'my-org/breeze.signing.v2';
    expect(getReleaseSourceRepository()).toBe('my-org/breeze.signing.v2');
  });

  it('accepts dots, underscores, and hyphens in the repository name', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'my-org/breeze_signing.v2';
    expect(getReleaseSourceRepository()).toBe('my-org/breeze_signing.v2');
  });

  it('builds release, API, and download URLs from the resolved repository', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceReleaseBase()).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases',
    );
    expect(getReleaseSourceApiBase()).toBe(
      'https://api.github.com/repos/acme/breeze-selfhost-signing',
    );
    expect(getReleaseDownloadUrl(null, 'breeze-agent.msi')).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/latest/download/breeze-agent.msi',
    );
    expect(getReleaseDownloadUrl('v1.2.3', 'breeze-agent.msi')).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/download/v1.2.3/breeze-agent.msi',
    );
  });

  it('scopes an alternate release to the exact Windows asset and pilot device', () => {
    process.env.BINARY_WINDOWS_GITHUB_REPOSITORY = 'example/windows-signing';
    process.env.BINARY_WINDOWS_VERSION = '0.115.1';
    process.env.BINARY_WINDOWS_CANARY_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000';
    expect(getWindowsReleaseSource()).toEqual({ repository: 'example/windows-signing', version: '0.115.1' });
    expect(getWindowsReleaseAssetUrl('0.115.1', 'breeze-agent-windows-amd64.exe')).toBe(
      'https://github.com/example/windows-signing/releases/download/v0.115.1/breeze-agent-windows-amd64.exe',
    );
    expect(getWindowsReleaseAssetUrl('0.115.0', 'breeze-agent-windows-amd64.exe')).toBeNull();
    expect(getWindowsReleaseAssetUrl('0.115.1', 'breeze-agent-linux-amd64')).toBeNull();
    expect(getWindowsReleaseAssetUrl('0.115.1', 'breeze-helper-windows-amd64.exe')).toBeNull();
    expect(getWindowsReleaseCanaryVersion('123e4567-e89b-42d3-a456-426614174000', 'windows')).toBe('0.115.1');
    expect(getWindowsReleaseCanaryVersion('00000000-0000-0000-0000-000000000000', 'windows')).toBeNull();
    expect(getWindowsReleaseCanaryVersion('123e4567-e89b-42d3-a456-426614174000', 'linux')).toBeNull();
    expect(isWindowsReleasePromotionEnabled()).toBe(false);
    process.env.BINARY_WINDOWS_PROMOTE_ENABLED = 'true';
    expect(isWindowsReleasePromotionEnabled()).toBe(true);
  });

  it('rejects incomplete or malformed Windows release configuration', () => {
    process.env.BINARY_WINDOWS_GITHUB_REPOSITORY = 'example/windows-signing';
    expect(() => getWindowsReleaseSource()).toThrow(/must both be set/);
    process.env.BINARY_WINDOWS_VERSION = '../latest';
    expect(() => getWindowsReleaseSource()).toThrow(/numeric release version/);
    process.env.BINARY_WINDOWS_VERSION = '0.115.1';
    process.env.BINARY_WINDOWS_CANARY_DEVICE_ID = 'not-a-uuid';
    expect(() => getWindowsReleaseCanaryVersion('device', 'windows')).toThrow(/must be a UUID/);
  });
});
