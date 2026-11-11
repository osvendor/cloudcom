import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists (#7024)
 * ----------------------------
 * `APP_VERSION` is the running image's own version: docker/Dockerfile.api bakes
 * it (`ARG/ENV APP_VERSION`) and the release workflow passes the tag. /health,
 * /system/version, Sentry's release, the upgrade preflight, the version history
 * (`recordRunningVersion`) and the System page all read it.
 *
 * The shipped Compose files used to override it with `APP_VERSION:
 * ${BREEZE_VERSION}`. On a digest-pinned install, bumping BREEZE_VERSION in .env
 * without new digests then made every one of those readers claim the new
 * release while the old image kept running — and the preflight evaluated, and
 * the history recorded, a version that was never deployed.
 *
 * The runtime Compose files must therefore never set APP_VERSION; a local build
 * passes it as a BUILD arg, which bakes it into the image it describes.
 */
const RUNTIME_COMPOSE_FILES = ['docker-compose.yml', 'deploy/docker-compose.prod.yml'];

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Non-comment lines that assign APP_VERSION as a map key (`APP_VERSION: …`). */
function appVersionAssignments(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => /^\s*-?\s*APP_VERSION\s*[:=]/.test(line));
}

describe('Compose never overrides the image-baked APP_VERSION (#7024)', () => {
  it.each(RUNTIME_COMPOSE_FILES)('%s does not set APP_VERSION', (rel) => {
    expect(appVersionAssignments(read(rel))).toEqual([]);
  });

  it('still passes BREEZE_VERSION to the API (agent release selection reads it)', () => {
    for (const rel of RUNTIME_COMPOSE_FILES) {
      expect(read(rel)).toMatch(/^\s+BREEZE_VERSION: \$\{BREEZE_VERSION/m);
    }
  });

  it('the local-build override bakes APP_VERSION into the API image as a build arg', () => {
    const text = read('docker-compose.override.yml.local-build');
    const api = text.slice(text.indexOf('\n  api:\n'), text.indexOf('\n  web:\n'));
    const build = api.slice(api.indexOf('    build:'), api.indexOf('    environment:'));
    expect(build).toMatch(/^\s+args:\s*$/m);
    expect(build).toMatch(/^\s+APP_VERSION: \$\{BREEZE_VERSION:-dev\}\s*$/m);
    expect(api.slice(api.indexOf('    environment:'))).not.toMatch(/^\s+APP_VERSION:/m);
  });

  it('the CloudCom candidate workflow bakes matching API and web versions', () => {
    const workflow = read('.github/workflows/cloudcom-candidate.yml');
    expect(workflow).toMatch(/^\s+- component: api\s*\n\s+dockerfile: apps\/api\/Dockerfile\s*$/m);
    expect(workflow).toMatch(/^\s+- component: web\s*\n\s+dockerfile: apps\/web\/Dockerfile\s*$/m);
    expect(workflow).toMatch(/^\s+BUILD_VERSION: \$\{\{ needs\.validate\.outputs\.build_version \}\}\s*$/m);
    expect(workflow).toContain('api) args+=(--build-arg "APP_VERSION=$BUILD_VERSION" --build-arg "BREEZE_BINARIES_VERSION=$BINARIES_VERSION") ;;');
    expect(workflow).toContain('web) args+=(--build-arg "PUBLIC_APP_VERSION=$BUILD_VERSION"');
    expect(workflow).toMatch(/docker build[^\n]+--file "\$DOCKERFILE"[^\n]+"\$\{args\[@\]\}"/);
    for (const dockerfile of ['apps/api/Dockerfile', 'docker/Dockerfile.api']) {
      expect(read(dockerfile)).toMatch(/^ENV APP_VERSION=\$\{APP_VERSION\}$/m);
    }
    expect(read('apps/web/Dockerfile')).toMatch(/^ENV PUBLIC_APP_VERSION=\$\{PUBLIC_APP_VERSION\}$/m);
  });
});
