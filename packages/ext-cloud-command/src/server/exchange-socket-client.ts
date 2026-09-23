import net, { type Socket } from 'node:net';
import path from 'node:path';
import type { ExchangeWorkerPort, ExchangeWorkerRequest } from './exchange-contract';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
type SocketLike = Pick<Socket, 'write' | 'end' | 'destroy' | 'once' | 'on'>;

/** Local Unix-socket transport for the Exchange sidecar. This intentionally cannot make HTTP
 * requests or select a target from a browser value. The compose/service owner supplies one
 * absolute, private socket path. */
export function createUnixSocketExchangeWorkerPort(options: {
  socketPath: string;
  timeoutMs?: number;
  connect?: (socketPath: string) => SocketLike;
}): ExchangeWorkerPort {
  if (!path.isAbsolute(options.socketPath) || options.socketPath.includes('\0') || options.socketPath.length > 100) throw new Error('invalid_exchange_socket');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new Error('invalid_exchange_timeout');
  const connect = options.connect ?? (socketPath => net.createConnection({ path: socketPath }));
  return {
    dispatch(request: ExchangeWorkerRequest): Promise<unknown> {
      const payload = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
      if (payload.byteLength > MAX_REQUEST_BYTES) return Promise.reject(new Error('exchange_request_too_large'));
      return new Promise((resolve, reject) => {
        let complete = false;
        let received = Buffer.alloc(0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let socket: SocketLike;
        const finish = (error?: Error, value?: unknown) => {
          if (complete) return;
          complete = true; clearTimeout(timer); socket.destroy();
          if (error) reject(error); else resolve(value);
        };
        try { socket = connect(options.socketPath); }
        catch { reject(new Error('exchange_socket_unavailable')); return; }
        timer = setTimeout(() => finish(new Error('exchange_socket_timeout')), timeoutMs);
        socket.once('error', () => finish(new Error('exchange_socket_unavailable')));
        socket.on('data', (chunk: Buffer) => {
          if (complete) return;
          received = Buffer.concat([received, Buffer.from(chunk)]);
          if (received.byteLength > MAX_RESPONSE_BYTES) { finish(new Error('exchange_response_too_large')); return; }
          const newline = received.indexOf(0x0a);
          if (newline === -1) return;
          const line = received.subarray(0, newline);
          const extra = received.subarray(newline + 1);
          if (extra.toString('utf8').trim()) { finish(new Error('exchange_invalid_response')); return; }
          try { finish(undefined, JSON.parse(line.toString('utf8')) as unknown); }
          catch { finish(new Error('exchange_invalid_response')); }
        });
        socket.once('connect', () => socket.write(payload));
        socket.once('end', () => finish(new Error('exchange_socket_unavailable')));
      });
    },
  };
}
