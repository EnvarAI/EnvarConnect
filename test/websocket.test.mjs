import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { SocketTransport, WorkApiError } from '../dist/connector/transport.js';

const token = 'envar_agent_' + 'w'.repeat(43);
async function fixture(t, handle) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const calls = [], sockets = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.url, '/api/v1/connect');
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    assert.equal(socket.protocol, 'envar.connect.v1');
    sockets.push(socket);
    socket.on('message', async raw => {
      const request = JSON.parse(raw);
      calls.push(request);
      const response = await handle(request, socket);
      if (response !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }));
    });
  });
  const transport = new SocketTransport(`http://127.0.0.1:${server.address().port}`, token);
  t.after(() => { transport.close(); for (const socket of server.clients) socket.terminate(); server.close(); });
  return { transport, calls, sockets };
}

test('one authenticated connection multiplexes RPCs and receives push without idle requests', async t => {
  const f = await fixture(t, async request => ({ result: request.params }));
  const results = await Promise.all([f.transport.call('get_work', { id: 'a' }), f.transport.call('get_work', { id: 'b' })]);
  assert.deepEqual(results, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(f.sockets.length, 1);
  const before = f.transport.generation;
  const wake = f.transport.wait(before);
  f.sockets[0].send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/changed', params: {} }));
  await wake;
  assert.ok(f.transport.generation > before);
  await sleep(100);
  assert.equal(f.calls.length, 2);
});

test('a lost mutation response is not replayed on reconnect', async t => {
  const f = await fixture(t, async (request, socket) => {
    if (request.method === 'start_work') { socket.terminate(); return; }
    return { result: { id: 'original', status: 'working' } };
  });
  await assert.rejects(f.transport.call('start_work', { work_id: 'original' }), /may have committed/);
  assert.equal((await f.transport.call('get_work', { work_id: 'original' })).id, 'original');
  assert.equal(f.calls.filter(r => r.method === 'start_work').length, 1);
  assert.equal(f.sockets.length, 2);
});

test('revoked authority is terminal and does not reconnect or downgrade', async t => {
  const f = await fixture(t, async () => ({ error: { code: 403, message: 'private body', data: { status: 403, terminal: true } } }));
  await assert.rejects(f.transport.call('get_work'), error => error instanceof WorkApiError && !error.message.includes('private'));
  await assert.rejects(f.transport.call('get_work'), error => error.status === 403);
  assert.equal(f.calls.length, 1);
});

test('receiver reconnect restores its subscription and wakes pending-work reconciliation', async t => {
  const f = await fixture(t, async () => ({ result: { subscribed: true } }));
  await f.transport.subscribeReceiver();
  const before = f.transport.generation;
  const disconnected = once(f.sockets[0], 'close');
  f.sockets[0].terminate(); await disconnected; await sleep(10);
  await f.transport.wait(before);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.calls.at(-1).method, 'subscribe_receiver');
});

test('an operation permission error does not revoke unrelated granted operations', async t => {
  const f = await fixture(t, async request => request.method === 'subscribe_receiver'
    ? { error: { code: 403, data: { status: 403, terminal: false } } }
    : { result: { status: 'active' } });
  await assert.rejects(f.transport.subscribeReceiver(), error => error.status === 403);
  assert.equal((await f.transport.call('get_connection')).status, 'active');
  assert.equal(f.sockets.length, 1);
});
