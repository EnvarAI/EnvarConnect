/** One authenticated WebSocket. Uncertain requests are never automatically replayed. */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class TaskApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfter = 0,
  ) {
    super(`Envar operation failed (${status}, ${code}). Read the original task before retrying.`);
  }
}

export class SocketTransport {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private listeners = new Set<() => void>();
  private denied = false;
  private closed = false;
  private receiver = false;
  generation = 0;
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private changed() {
    this.generation++;
    for (const listener of this.listeners) listener();
  }
  private async connect(): Promise<void> {
    if (this.closed) throw new Error('Connect transport is closed');
    if (this.denied) throw new TaskApiError(403, 'connection_revoked');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const url = new URL('/api/v1/connect', this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, 'envar.connect.v2', {
        headers: { Authorization: `Bearer ${this.token}` },
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 6 * 1024 * 1024,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.once('open', () => {
        resolve();
        this.changed();
      });
      socket.on('message', (data) => {
        let value: any;
        try {
          value = JSON.parse(data.toString());
        } catch {
          socket.close(1002);
          return;
        }
        if (value.jsonrpc !== '2.0') {
          socket.close(1002);
          return;
        }
        if (value.method === 'notifications/changed') {
          this.changed();
          return;
        }
        if (value.method === 'notifications/heartbeat') return;
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        clearTimeout(request.timer);
        if (value.error) {
          const status = Number(value.error.data?.status ?? value.error.code) || 500;
          if (value.error.data?.terminal === true) this.denied = true;
          request.reject(new TaskApiError(status, 'rpc_rejected'));
        } else if (Object.hasOwn(value, 'result')) request.resolve(value.result);
        else request.reject(new Error('Invalid Connect response; preserve the original operation'));
      });
      socket.once('unexpected-response', (_request, response) => {
        if ([401, 403].includes(response.statusCode ?? 0)) this.denied = true;
        response.resume();
        socket.terminate();
        reject(new TaskApiError(response.statusCode ?? 503, 'websocket_rejected'));
      });
      socket.on('error', () => reject(new Error('Connect WebSocket unavailable')));
      socket.once('close', (code) => {
        if (code === 1008) this.denied = true;
        if (this.socket === socket) this.socket = undefined;
        const error = this.denied
          ? new TaskApiError(403, 'connection_revoked')
          : new Error('Connect disconnected; the original operation may have committed');
        reject(error);
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.pending.clear();
        this.changed();
      });
    }).finally(() => {
      this.opening = undefined;
    });
    await this.opening;
    if (this.receiver) await this.call('subscribe_receiver', {});
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.pending.size >= 64) throw new Error('Connect has too many in-flight requests');
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error('Connect disconnected before sending');
    const id = randomUUID(),
      text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(text) > 6 * 1024 * 1024 || socket.bufferedAmount > 6 * 1024 * 1024)
      throw new Error('Connect message or send buffer exceeds its limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Connect response timed out; recover the original operation'));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(text, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Connect send outcome is unknown'));
        }
      });
    });
  }

  async subscribeReceiver() {
    await this.call('subscribe_receiver', {});
    this.receiver = true;
  }

  async wait(after: number, signal?: AbortSignal, milliseconds?: number): Promise<void> {
    await this.connect();
    if (this.generation !== after || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.listeners.delete(done);
        signal?.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = milliseconds === undefined ? undefined : setTimeout(done, milliseconds);
      this.listeners.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (this.generation !== after || signal?.aborted) done();
    });
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.changed();
  }
}
