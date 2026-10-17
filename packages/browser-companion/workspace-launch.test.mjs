import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchWorkspace } from './workspace-launch.mjs';

test('queues workspace request before awaiting side panel open and consumes rejection', async () => {
  const order = [];
  const result = await launchWorkspace({
    mode: 'sidepanel', windowId: 7,
    send: async () => { order.push('openWorkspace'); return { ok: true, data: {} }; },
    openSidePanel: async () => { order.push('sidepanel'); await Promise.resolve(); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['openWorkspace', 'sidepanel']);

  await assert.rejects(() => launchWorkspace({
    mode: 'sidepanel', windowId: 7,
    send: async () => { order.push('rejected-send'); throw new Error('worker failed'); },
    openSidePanel: async () => { throw new Error('panel failed'); },
  }), /panel failed/);
  assert.equal(order.at(-1), 'rejected-send');
});
