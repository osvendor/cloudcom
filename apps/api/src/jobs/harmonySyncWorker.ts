import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { recordExtensionJob } from '../extensions/metrics';
import { attachWorkerObservability } from './workerObservability';
import { canRunBackgroundWork } from '../services/capacityGuard';

const QUEUE_NAME = 'cloudcommand-harmony-sync';
const JOB_NAME = 'harmony-sync';
const REPEAT_ID = 'cloudcommand-harmony-sync-repeat';
const REPEAT_EVERY_MS = 5 * 60 * 1000;
const ENABLED = () => process.env.CLOUDCOM_THREECX_ENABLED === 'true';

type HarmonySyncJob = Record<string, never>;

let queue: Queue<HarmonySyncJob> | null = null;
let worker: Worker<HarmonySyncJob> | null = null;

export function getHarmonySyncQueue(): Queue<HarmonySyncJob> {
  if (!queue) queue = new Queue<HarmonySyncJob>(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export function createHarmonySyncWorker(): Worker<HarmonySyncJob> {
  return new Worker<HarmonySyncJob>(
    QUEUE_NAME,
    async (_job: Job<HarmonySyncJob>) => {
      if (!ENABLED()) return;
      // Leave cache freshness/due time unchanged; the next repeat tries again.
      if (!canRunBackgroundWork()) return { deferredForCapacity: true };
      const started = Date.now();
      try {
        const { nativeHarmonyServices } = await import('../extensions/cloudCommandHarmony');
        await nativeHarmonyServices.refreshDue();
        recordExtensionJob('cloudcommand', JOB_NAME, 'success', (Date.now() - started) / 1000);
      } catch (error) {
        recordExtensionJob('cloudcommand', JOB_NAME, 'failure', (Date.now() - started) / 1000);
        throw error;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeHarmonySyncWorker(): Promise<void> {
  if (worker) return;
  worker = createHarmonySyncWorker();
  attachWorkerObservability(worker, 'harmonySyncWorker');
  const harmonyQueue = getHarmonySyncQueue();
  if (!ENABLED()) {
    for (const repeatable of await harmonyQueue.getRepeatableJobs()) {
      if (repeatable.id === REPEAT_ID || repeatable.name === JOB_NAME) {
        await harmonyQueue.removeRepeatableByKey(repeatable.key);
      }
    }
    return;
  }
  await harmonyQueue.add(JOB_NAME, {}, {
    jobId: REPEAT_ID,
    repeat: { every: REPEAT_EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function shutdownHarmonySyncWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
