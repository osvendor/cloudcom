import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(value, label) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new Error(`Invalid ${label}`);
  return value.split('.').map(BigInt);
}

export function releaseVersions(baseline) {
  if (baseline?.repository !== 'LanternOps/breeze' ||
      typeof baseline.commit !== 'string' || !/^[0-9a-f]{40}$/.test(baseline.commit) ||
      typeof baseline.tag !== 'string' || !baseline.tag.startsWith('v')) {
    throw new Error('Invalid CloudCom upstream baseline');
  }
  const upstream = parts(baseline.tag.slice(1), 'upstream tag');
  const fork = parts(baseline.forkVersion, 'forkVersion');
  const binaries = parts(baseline.binariesVersion, 'binariesVersion');
  if (fork[0] !== upstream[0] || fork[1] !== upstream[1] || fork[2] < upstream[2]) {
    throw new Error('forkVersion must follow the pinned upstream release line');
  }
  const firstDifference = binaries.findIndex((value, index) => value !== fork[index]);
  if (firstDifference !== -1 && binaries[firstDifference] > fork[firstDifference]) {
    throw new Error('binariesVersion cannot exceed forkVersion');
  }
  return {
    build_version: baseline.forkVersion,
    baseline_tag: baseline.tag,
    // Empty pairing denotes a full release; an older version denotes server-only.
    binaries_version: baseline.binariesVersion === baseline.forkVersion ? '' : baseline.binariesVersion,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const versions = releaseVersions(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(Object.entries(versions).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
