import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvarWorkClient, WorkApiError } from '../dist/connector/client.js';
for (const version of ['1', '2']) {
  test(`relay handshake keeps the original execution-reference version ${version}`, async () => {
    const calls = [];
    const client = new EnvarWorkClient('https://envar.test','envar_agent_'+'a'.repeat(48), {rpc: async (method, params) => {
      calls.push({method, params}); return {relay_version: version};
    }});
    assert.equal(await client.relayHello('b'.repeat(64), version), true);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'relay_hello');
    assert.equal(calls[0].params.relay_version, version);
  });
}
test('relay handshake failures never fall back to another delivery protocol', async () => {
  let calls = 0;
  const client = new EnvarWorkClient('https://envar.test','envar_agent_'+'a'.repeat(48), {rpc: async () => {
    calls++; throw new WorkApiError(403, 'rpc_rejected');
  }});
  await assert.rejects(client.relayHello('b'.repeat(64)), error => error.status === 403);
  assert.equal(calls, 1);
});
