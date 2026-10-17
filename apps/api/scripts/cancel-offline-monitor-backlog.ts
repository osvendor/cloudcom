#!/usr/bin/env tsx
/** Trusted one-shot operator tool. Run only AFTER the periodic-monitor
 * scheduler fix; default is read-only. Existing history is retained.
 *
 * node cancel-offline-monitor-backlog.cjs [--org UUID] [--device UUID]
 * node cancel-offline-monitor-backlog.cjs --apply [--batch-size 25] [--max 500]
 *
 * A capped result is NOT a full inventory. Repeat the dry run after applying.
 * On failure, earlier per-command transactions remain committed; rerun is safe.
 */
import { closeDb } from '../src/db';
import { parseBacklogArgs, runBacklogRecovery } from './cancel-offline-monitor-backlog.lib';

async function main() {
  const options = parseBacklogArgs(process.argv.slice(2));
  console.log(JSON.stringify(await runBacklogRecovery(options)));
}

main().catch(error => {
  // Driver errors can contain SQL parameters. Never print the error message,
  // stack, command content, credential-bearing payload, or database URL.
  const causes: { name: string; code?: string }[] = [];
  let cause: unknown = error;
  for (let i = 0; i < 4 && cause && typeof cause === 'object'; i++) {
    const item = cause as { name?: unknown; code?: unknown; cause?: unknown };
    causes.push({ name: typeof item.name === 'string' ? item.name : 'UnknownError',
      code: typeof item.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(item.code) ? item.code : undefined });
    cause = item.cause;
  }
  console.error(JSON.stringify({ error: 'offline_monitor_backlog_recovery_failed', causes,
    reason: error instanceof Error ? error.name : 'UnknownError',
    hint: 'Earlier cancellations may have committed. Check the audit trail; correct the failure and rerun the dry run.' }));
  process.exitCode = 1;
}).finally(async () => { await closeDb(); });
