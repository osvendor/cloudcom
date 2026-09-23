/**
 * Single source of truth for WHICH GitHub repository this deployment pulls
 * release artifacts from (spec: 2026-08-09-selfhost-byo-signing-design.md,
 * Deliverable 3a).
 *
 * Before this module the release-source identity was fragmented three ways:
 * binarySource.ts hardcoded lanternops/breeze for download URLs, binarySync.ts
 * read a separate GITHUB_REPO env for the Releases API, and
 * BINARY_GITHUB_REPOSITORY only affected manifest-repository validation. Every
 * consumer now resolves the repository here.
 *
 * BYO signing: a self-hoster sets BINARY_GITHUB_REPOSITORY=theirorg/their-repo
 * (plus RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=<their release key>) and the
 * whole instance — sync, download redirects, installer pre-flight, support
 * client, recovery media — follows their signed releases.
 */

export const OFFICIAL_RELEASE_REPOSITORY = 'lanternops/breeze';

// Strict owner/repository shape. GitHub owner names are alphanumeric+hyphen;
// repository names additionally allow dot and underscore. Nothing else may
// reach URL construction (path traversal, query strings, schemes).
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// `.` and `..` satisfy the repository character class, so the pattern alone
// does NOT deliver the "no path traversal" promise above: `owner/..` builds
// https://api.github.com/repos/owner/.. which normalizes to the API root. Not
// exploitable (the owner class excludes `/`, `@`, `%` and dots, so a single
// `..` can never reach a second repository, and every builder uses a literal
// host) — but the guard should mean what it says, and a typo'd override should
// fail loudly rather than 404 mysteriously.
const DOTS_ONLY_SEGMENT = /^\.+$/;

/**
 * Single source of truth for release-source repository validation. Imported by
 * config/validate.ts so boot-time validation and runtime resolution cannot
 * drift — a tightening applied to only one of them would let a value pass boot
 * and then throw mid-sync.
 */
export function isValidReleaseSourceRepository(value: string): boolean {
  if (!REPOSITORY_PATTERN.test(value)) return false;
  // The pattern guarantees exactly one slash with non-empty sides.
  return value.split('/').every((segment) => !DOTS_ONLY_SEGMENT.test(segment));
}

export const RELEASE_SOURCE_REPOSITORY_SHAPE =
  '"owner/repository" matching [A-Za-z0-9-]+/[A-Za-z0-9._-]+ (no "." or ".." segments)';

let legacyGithubRepoWarned = false;

export function getReleaseSourceRepository(): string {
  const override = process.env.BINARY_GITHUB_REPOSITORY?.trim();
  const legacy = process.env.GITHUB_REPO?.trim();

  let repository = OFFICIAL_RELEASE_REPOSITORY;
  if (override) {
    repository = override;
  } else if (legacy) {
    // Pre-unification binarySync.ts read GITHUB_REPO. Kept as a deprecated
    // alias so an existing deployment that set it does not silently flip back
    // to the official repo on upgrade.
    if (!legacyGithubRepoWarned) {
      console.warn(
        '[releaseSource] GITHUB_REPO is deprecated; set BINARY_GITHUB_REPOSITORY instead',
      );
      legacyGithubRepoWarned = true;
    }
    repository = legacy;
  }

  if (!isValidReleaseSourceRepository(repository)) {
    throw new Error(
      `Invalid release source repository "${repository}": expected ${RELEASE_SOURCE_REPOSITORY_SHAPE}`,
    );
  }
  return repository;
}

export function isOfficialReleaseSource(): boolean {
  return getReleaseSourceRepository().toLowerCase() === OFFICIAL_RELEASE_REPOSITORY;
}

export function getReleaseSourceReleaseBase(): string {
  return `https://github.com/${getReleaseSourceRepository()}/releases`;
}

export function getReleaseSourceApiBase(): string {
  return `https://api.github.com/repos/${getReleaseSourceRepository()}`;
}

/** Optional Windows-only self-host release. Unset means the normal source. */
export function getWindowsReleaseSource(): { repository: string; version: string } | null {
  const repository = process.env.BINARY_WINDOWS_GITHUB_REPOSITORY?.trim();
  const rawVersion = process.env.BINARY_WINDOWS_VERSION?.trim();
  if (!repository && !rawVersion) return null;
  if (!repository || !rawVersion || !isValidReleaseSourceRepository(repository)) {
    throw new Error('BINARY_WINDOWS_GITHUB_REPOSITORY and BINARY_WINDOWS_VERSION must both be set to valid values');
  }
  const version = rawVersion.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('BINARY_WINDOWS_VERSION must be a numeric release version');
  }
  if (repository.toLowerCase() === getReleaseSourceRepository().toLowerCase()) {
    throw new Error('BINARY_WINDOWS_GITHUB_REPOSITORY must differ from the primary release repository');
  }
  return { repository, version };
}

/** Only the configured, exact Windows release may override a download redirect. */
export function getWindowsReleaseAssetUrl(version: string | null, filename: string): string | null {
  const source = getWindowsReleaseSource();
  if (!source || version !== source.version) return null;
  if (!/^breeze-(agent|backup|watchdog|user-helper)-windows-amd64\.exe$/.test(filename)) {
    return null;
  }
  return `https://github.com/${source.repository}/releases/download/v${source.version}/${filename}`;
}

/** An opt-in device pilot does not alter the global promoted release. */
export function getWindowsReleaseCanaryVersion(deviceId: string, platform: string): string | null {
  const canaryId = process.env.BINARY_WINDOWS_CANARY_DEVICE_ID?.trim().toLowerCase();
  if (!canaryId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canaryId)) {
    throw new Error('BINARY_WINDOWS_CANARY_DEVICE_ID must be a UUID');
  }
  const source = getWindowsReleaseSource();
  if (!source) throw new Error('Windows canary requires a configured Windows release source');
  return platform === 'windows' && deviceId.toLowerCase() === canaryId
    ? source.version
    : null;
}

/** Explicit post-canary promotion of the Windows release to all Windows agents. */
export function isWindowsReleasePromotionEnabled(): boolean {
  const raw = process.env.BINARY_WINDOWS_PROMOTE_ENABLED?.trim().toLowerCase();
  if (raw !== 'true') return false;
  if (!getWindowsReleaseSource()) throw new Error('Windows promotion requires a configured Windows release source');
  return true;
}

/** tag === null means "latest". Tags are passed verbatim (e.g. "v1.2.3"). */
export function getReleaseDownloadUrl(tag: string | null, assetName: string): string {
  const base = getReleaseSourceReleaseBase();
  return tag === null
    ? `${base}/latest/download/${assetName}`
    : `${base}/download/${tag}/${assetName}`;
}
