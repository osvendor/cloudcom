import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ select: vi.fn(), where: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({ db: { select: mocks.select } }));
import { readEnrolledRustDeskId } from './remoteAccessEnrollment';
const settings = { defaultProviderId: 'rustdesk', providers: [{ id: 'rustdesk', name: 'RustDesk', enabled: true,
  customFieldKey: 'rustdesk_id', urlTemplate: 'rustdesk://{id}' }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = [];
  mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) });
  mocks.where.mockImplementation(() => ({ limit: async () => mocks.rows }));
});
it('binds enabled enrollment to device and organization in request RLS', async () => {
  mocks.rows = [{ rustdeskId: '503234560' }];
  expect(await readEnrolledRustDeskId('device-a', 'org-a', settings)).toBe('503234560');
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
  expect(query.sql).toMatch(/device_id.*org_id.*enabled/);
  expect(query.params).toEqual(['device-a', 'org-a', true]);
});
it('rejects absent and malformed enrollment', async () => {
  expect(await readEnrolledRustDeskId('device-a', 'org-a', settings)).toBeNull();
  mocks.rows = [{ rustdeskId: 'bad://identity' }];
  expect(await readEnrolledRustDeskId('device-a', 'org-a', settings)).toBeNull();
});
it('does not query non-RustDesk providers', async () => {
  expect(await readEnrolledRustDeskId('device-a', 'org-a', { providers: [], defaultProviderId: null })).toBeNull();
  expect(mocks.select).not.toHaveBeenCalled();
});
