import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  workerCloseMock,
  workerConstructorMock,
  queueCloseMock,
  queueConstructorMock,
  getSyncCredentialsMock,
  markStatusMock,
  markSyncedMock,
  createUnifiClientMock,
  collectSyncDataMock,
  applySyncDataMock,
  lockUnifiSyncOrganizationsMock,
  systemContext,
} = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueCloseMock: vi.fn(),
  queueConstructorMock: vi.fn(),
  getSyncCredentialsMock: vi.fn(),
  markStatusMock: vi.fn(),
  markSyncedMock: vi.fn(),
  createUnifiClientMock: vi.fn(),
  collectSyncDataMock: vi.fn(),
  applySyncDataMock: vi.fn(),
  lockUnifiSyncOrganizationsMock: vi.fn(),
  systemContext: { active: 0, next: 0 },
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => {
    queueConstructorMock();
    return {
      close: queueCloseMock,
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
    };
  }),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(async () => [{ id: 'mapping-1', orgId: 'org-1' }]),
      };
      return chain;
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => {
    const previous = systemContext.active;
    systemContext.active = ++systemContext.next;
    try {
      return await fn();
    } finally {
      systemContext.active = previous;
    }
  },
}));
vi.mock('../db/schema', () => ({ unifiIntegrations: {}, unifiSiteMappings: { integrationId: 'integrationId' } }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unifi/unifiClient', () => ({ createUnifiClient: createUnifiClientMock }));
vi.mock('../services/unifi/unifiConnectionService', () => ({
  getSyncCredentials: getSyncCredentialsMock,
  markStatus: markStatusMock,
  markSynced: markSyncedMock,
}));
vi.mock('../services/unifi/unifiSyncService', () => ({
  collectSyncData: collectSyncDataMock,
  applySyncData: applySyncDataMock,
}));
vi.mock('../services/unifi/unifiSyncLocks', () => ({
  lockUnifiSyncOrganizations: lockUnifiSyncOrganizationsMock,
}));

import {
  getUnifiSyncQueue,
  initializeUnifiWorker,
  shutdownUnifiWorker,
} from './unifiWorker';

describe('shutdownUnifiWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the worker and the lazily-created sync queue exactly once after initialize', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('a second shutdown call is a no-op (handles already nulled)', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();
    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when called before initialize or queue creation', async () => {
    await expect(shutdownUnifiWorker()).resolves.toBeUndefined();
    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
  });

  it('closes the sync queue when it was created lazily via getUnifiSyncQueue() without ever initializing the worker', async () => {
    getUnifiSyncQueue();

    await shutdownUnifiWorker();

    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });
});

describe('UniFi sync worker lock ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemContext.active = 0;
    systemContext.next = 0;
    getSyncCredentialsMock.mockResolvedValue({ baseUrl: 'https://api.example.test', apiKey: 'key' });
    createUnifiClientMock.mockReturnValue({});
    collectSyncDataMock.mockResolvedValue({ hostsSeen: 1, byMapping: new Map() });
    applySyncDataMock.mockResolvedValue({ status: 'success' });
  });

  it('awaits the organization pre-lock before applySyncData in its persistence context', async () => {
    const events: string[] = [];
    let lockContext = 0;
    let applyContext = 0;
    lockUnifiSyncOrganizationsMock.mockImplementation(async () => {
      lockContext = systemContext.active;
      events.push('lock-start');
      await Promise.resolve();
      events.push('lock-end');
    });
    applySyncDataMock.mockImplementation(async () => {
      applyContext = systemContext.active;
      events.push('apply');
      return { status: 'success' };
    });

    await initializeUnifiWorker();
    const processor = workerConstructorMock.mock.calls[0]![1] as (job: { data: unknown }) => Promise<void>;
    await processor({
      data: {
        type: 'sync-integration',
        integrationId: '11111111-1111-4111-8111-111111111111',
        partnerId: '22222222-2222-4222-8222-222222222222',
        trigger: 'scheduled',
      },
    });

    expect(lockUnifiSyncOrganizationsMock).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
      [{ id: 'mapping-1', orgId: 'org-1' }],
    );
    expect(events).toEqual(['lock-start', 'lock-end', 'apply']);
    expect(lockContext).toBeGreaterThan(0);
    expect(applyContext).toBe(lockContext);
    expect(lockUnifiSyncOrganizationsMock.mock.invocationCallOrder[0])
      .toBeLessThan(applySyncDataMock.mock.invocationCallOrder[0]!);

    await shutdownUnifiWorker();
  });
});
