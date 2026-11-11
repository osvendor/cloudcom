import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  Worker: vi.fn(),
  Queue: vi.fn(),
  connection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  observe: vi.fn(),
  metric: vi.fn(),
  refreshDue: vi.fn(),
  canRunBackgroundWork: vi.fn(() => true),
}));

vi.mock('bullmq', () => ({
  Queue: mocks.Queue,
  Worker: mocks.Worker,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: mocks.connection }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.observe }));
vi.mock('../extensions/metrics', () => ({ recordExtensionJob: mocks.metric }));
vi.mock('../extensions/cloudCommandHarmony', () => ({ nativeHarmonyServices: { refreshDue: mocks.refreshDue } }));
vi.mock('../services/capacityGuard', () => ({ canRunBackgroundWork: mocks.canRunBackgroundWork }));

describe('harmony sync worker', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.canRunBackgroundWork.mockReset().mockReturnValue(true);
    mocks.refreshDue.mockResolvedValue(undefined);
    mocks.Queue.mockImplementation(class { getRepeatableJobs = vi.fn().mockResolvedValue([{ id: 'cloudcommand-harmony-sync-repeat', name: 'harmony-sync', key: 'old' }]); removeRepeatableByKey = vi.fn(); add = vi.fn(); close = vi.fn(); });
    mocks.Worker.mockImplementation(class { processor: unknown; close = vi.fn(); constructor(_name: string, processor: unknown) { this.processor = processor; } });
    vi.unstubAllEnvs();
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'false');
    const mod = await import('./harmonySyncWorker');
    await mod.shutdownHarmonySyncWorker();
  });

  it('constructs the worker but does not schedule or refresh while disabled', async () => {
    const mod = await import('./harmonySyncWorker');
    await mod.initializeHarmonySyncWorker();
    expect(mocks.Worker).toHaveBeenCalledOnce();
    await mocks.Worker.mock.results[0].value.processor({});
    expect(mocks.refreshDue).not.toHaveBeenCalled();
    expect(mocks.Queue.mock.results[0].value.add).not.toHaveBeenCalled();
    expect(mocks.Queue.mock.results[0].value.removeRepeatableByKey).toHaveBeenCalled();
  });

  it('schedules one bounded repeat and processes refreshDue with concurrency one', async () => {
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
    const mod = await import('./harmonySyncWorker');
    await mod.initializeHarmonySyncWorker();
    expect(mocks.Worker).toHaveBeenCalledWith('cloudcommand-harmony-sync', expect.any(Function), expect.objectContaining({ concurrency: 1 }));
    expect(mocks.observe).toHaveBeenCalledWith(expect.anything(), 'harmonySyncWorker');
    const queue = mocks.Queue.mock.results[0].value;
    expect(queue.add).toHaveBeenCalledWith('harmony-sync', {}, expect.objectContaining({ jobId: 'cloudcommand-harmony-sync-repeat', repeat: { every: 300000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 25 } }));
    await mocks.Worker.mock.results[0].value.processor({});
    expect(mocks.refreshDue).toHaveBeenCalledOnce();
    expect(mocks.metric).toHaveBeenCalledWith('cloudcommand', 'harmony-sync', 'success', expect.any(Number));
    await mod.shutdownHarmonySyncWorker();
  });

  it('defers refresh under pressure without recording false success and retries on the next repeat', async () => {
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
    mocks.canRunBackgroundWork.mockReturnValue(false);
    const mod = await import('./harmonySyncWorker');
    await mod.initializeHarmonySyncWorker();
    const processor = mocks.Worker.mock.results[0].value.processor;
    await expect(processor({})).resolves.toEqual({ deferredForCapacity: true });
    expect(mocks.refreshDue).not.toHaveBeenCalled();
    expect(mocks.metric).not.toHaveBeenCalled();
    expect(mocks.Queue.mock.results[0].value.add).toHaveBeenCalledTimes(1);
    mocks.canRunBackgroundWork.mockReturnValue(true);
    await processor({});
    expect(mocks.refreshDue).toHaveBeenCalledTimes(1);
    expect(mocks.metric).toHaveBeenCalledWith('cloudcommand', 'harmony-sync', 'success', expect.any(Number));
    await mod.shutdownHarmonySyncWorker();
  });

  it('does not create an orphan worker when initialized repeatedly', async () => {
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
    const mod = await import('./harmonySyncWorker');
    await mod.initializeHarmonySyncWorker();
    await mod.initializeHarmonySyncWorker();
    expect(mocks.Worker).toHaveBeenCalledOnce();
    await mod.shutdownHarmonySyncWorker();
    expect(mocks.Worker.mock.results[0].value.close).toHaveBeenCalledOnce();
    expect(mocks.Queue.mock.results[0].value.close).toHaveBeenCalledOnce();
  });

  it('records failure and rethrows it', async () => {
    vi.stubEnv('CLOUDCOM_THREECX_ENABLED', 'true');
    const failure = new Error('provider unavailable');
    mocks.refreshDue.mockRejectedValue(failure);
    const mod = await import('./harmonySyncWorker');
    await mod.initializeHarmonySyncWorker();
    await expect(mocks.Worker.mock.results[0].value.processor({})).rejects.toBe(failure);
    expect(mocks.metric).toHaveBeenCalledWith('cloudcommand', 'harmony-sync', 'failure', expect.any(Number));
    await mod.shutdownHarmonySyncWorker();
  });
});
