import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createUnixSocketExchangeWorkerPort } from './exchange-socket-client';
import type { ExchangeWorkerRequest } from './exchange-contract';

const request: ExchangeWorkerRequest = { requestId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', tenantId: '33333333-3333-4333-8333-333333333333', clientId: '44444444-4444-4444-8444-444444444444', credentialVersion: 'cert-1', connectionGeneration: 1, operation: 'mailbox.inventory', parameters: { pageSize: 1 } };
class FakeSocket extends EventEmitter {
  payload?: Buffer; destroyed = false;
  write(value: Buffer) { this.payload = value; }
  end() {} destroy() { this.destroyed = true; }
}
describe('Exchange Unix socket client', () => {
  it('uses one configured local path and parses exactly one JSON response line', async () => {
    const socket = new FakeSocket();
    const port = createUnixSocketExchangeWorkerPort({ socketPath: '/run/cloudcom/exchange.sock', connect: () => socket as never });
    const pending = port.dispatch(request); socket.emit('connect'); socket.emit('data', Buffer.from('{"ok":true}\n'));
    await expect(pending).resolves.toEqual({ ok: true }); expect(socket.payload?.toString()).toContain('mailbox.inventory'); expect(socket.destroyed).toBe(true);
  });
  it('rejects public/relative targets and malformed multi-line responses', async () => {
    expect(() => createUnixSocketExchangeWorkerPort({ socketPath: 'https://example.com' })).toThrow('invalid_exchange_socket');
    const socket = new FakeSocket(); const port = createUnixSocketExchangeWorkerPort({ socketPath: '/run/cloudcom/exchange.sock', connect: () => socket as never });
    const pending = port.dispatch(request); socket.emit('connect'); socket.emit('data', Buffer.from('{"ok":true}\nsecret'));
    await expect(pending).rejects.toThrow('exchange_invalid_response');
  });
});
