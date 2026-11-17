import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { expect, it, vi } from 'vitest';
const { capacity } = vi.hoisted(() => ({ capacity: vi.fn(() => false) }));
vi.mock('../services/capacityGuard', () => ({ canRunBackgroundWork: capacity }));
import { runMetricRollupWork } from './metricRollupWorkAdmission';

it.skipIf(!process.env.ROLLUP_TEST_REDIS_PORT)('retains jobs across shared cooldown, retries without failures, and bounds starts across workers', async () => {
  const port = Number(process.env.ROLLUP_TEST_REDIS_PORT);
  if (port !== 56389) throw new Error('Only isolated test Redis port permitted');
  const connection = { host: '127.0.0.1', port, maxRetriesPerRequest: null };
  const name = `rollup-test-${randomUUID()}`;
  const queue = new Queue(name, { connection });
  const starts: number[] = [], performed: string[] = [];
  let cooldowns = 0;
  const processor = async (job: any) => runMetricRollupWork(job, async ms => {
    expect(ms).toBe(60_000);
    cooldowns++;
    // Exercise the real shared Redis limiter with a bounded test-only TTL.
    await queue.rateLimit(1000);
  }, async () => { starts.push(Date.now()); performed.push(job.id); return job.data; });
  await queue.setGlobalConcurrency(1);
  const workers = [1, 2].map(() => new Worker(name, processor, { connection, limiter: { max: 1, duration: 1000 } }));
  try {
    await queue.addBulk([1,2,3].map(n => ({ name: 'range', data: { from: n, to: n+1 }, opts: { jobId: `job-${n}` } })));
    await vi.waitFor(() => expect(cooldowns).toBe(1), { timeout: 3000, interval: 20 });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(cooldowns).toBe(1);
    expect(performed).toEqual([]);
    expect(await queue.getFailedCount()).toBe(0);
    for (const id of ['job-1','job-2','job-3']) {
      const job = await queue.getJob(id);
      expect(job).not.toBeNull();
      expect(job!.attemptsMade).toBe(0);
      expect(job!.data).toEqual({ from: Number(id.split('-')[1]), to: Number(id.split('-')[1])+1 });
    }
    capacity.mockReturnValue(true);
    await vi.waitFor(async () => expect(await queue.getCompletedCount()).toBe(3), { timeout: 7000, interval: 50 });
    expect(new Set(performed).size).toBe(3);
    expect(await queue.getFailedCount()).toBe(0);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(900);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(900);
    for (const id of performed) expect((await queue.getJob(id))!.attemptsMade).toBe(1);
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    await queue.obliterate({ force: true });
    await queue.close();
  }
}, 15000);
