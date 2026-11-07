/** Opt-in localhost E2E: real Envar API + SQLite journal + native A2A protocol fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnvarWorkClient } from '../dist/connector/client.js';
import { ConnectorJournal } from '../dist/connector/state.js';
import { ConnectorLoop } from '../dist/connector/loop.js';
import { HermesRuntimeAdapter } from '../dist/adapters/hermes.js';
import { CONNECTOR_VERSION } from '../dist/connector/runtime-report.js';

const path = process.argv[2];
if (!path || (statSync(path).mode & 0o077)) throw new Error('Provide an owner-only isolated localhost fixture file');
const fixture = JSON.parse(readFileSync(path, 'utf8'));
const origin = new URL(fixture.origin);
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
assert.equal(fixture.purpose, 'isolated-runtime-e2e');
const token = randomBytes(32).toString('base64url');
const tasks = new Map();
let sends = 0, dropNextSend = false, nativeOrigin;
const native = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'Isolated protocol fixture', description: 'No model or external tool', version: 'test-fixture',
        capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
        supportedInterfaces: [{ url: nativeOrigin + '/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
      return;
    }
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 65536) throw new Error('Oversized fixture request'); }
    const body = JSON.parse(data);
    let task;
    if (body.method === 'SendMessage') {
      sends++;
      task = { id: randomUUID(), contextId: body.params.message.contextId,
        status: { state: 'TASK_STATE_WORKING' }, artifacts: [] };
      tasks.set(task.id, task);
      if (dropNextSend) { dropNextSend = false; res.destroy(); return; }
    } else {
      assert.equal(body.method, 'GetTask');
      task = tasks.get(body.params.id);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(task
      ? { result: body.method === 'SendMessage' ? { task } : task }
      : { error: { code: -32001, message: 'Task not found' } }) }));
  } catch {
    res.writeHead(500); res.end('Fixture request failed');
  }
});
await new Promise(resolve => native.listen(0, '127.0.0.1', resolve));
nativeOrigin = `http://127.0.0.1:${native.address().port}`;
const directory = mkdtempSync(join(tmpdir(), 'envar-platform-e2e-'));
const binding = { origin: origin.origin, agentId: fixture.receiver.agent_id,
  connectionId: fixture.receiver.connection_id, adapter: 'hermes', cardUrl: nativeOrigin + '/card' };
const caller = new EnvarWorkClient(origin.origin, fixture.caller.token, { allowLocalHttp: true });
const receiver = new EnvarWorkClient(origin.origin, fixture.receiver.token, { allowLocalHttp: true });
const runtime = new HermesRuntimeAdapter({ cardUrl: binding.cardUrl, token });
let journal, loop;
const reopen = () => {
  journal?.close();
  journal = new ConnectorJournal(join(directory, 'journal.sqlite3'), binding);
  loop = new ConnectorLoop(receiver, runtime, journal);
};
try {
  reopen();
  const request = { target_agent_id: binding.agentId, message: 'Return the original bounded fixture result.' };
  const key = randomUUID();
  const first = await caller.send(request, key);
  assert.equal((await caller.send(request, key)).id, first.id);
  await loop.tick();
  assert.equal(sends, 1);
  assert.equal((await receiver.status()).runtime.connector_version, CONNECTOR_VERSION);
  const original = journal.get(first.id).reference.value.taskId;
  tasks.get(original).status.state = 'TASK_STATE_COMPLETED';
  tasks.get(original).artifacts = [{ artifactId: 'original', parts: [{ text: 'Original fixture result' }] }];
  reopen();
  await loop.tick();
  assert.equal((await caller.get(first.id)).result.text, 'Original fixture result');
  assert.equal(sends, 1);
  tasks.clear();
  reopen();
  await loop.tick();
  assert.equal(journal.get(first.id).observation.text, 'Original fixture result');
  assert.equal(sends, 1);

  const second = await caller.send(request, randomUUID());
  dropNextSend = true;
  await loop.tick();
  assert.equal((await caller.get(second.id)).status, 'unknown');
  assert.equal(sends, 2);
  reopen();
  await loop.tick();
  assert.equal((await caller.get(second.id)).status, 'unknown');
  assert.equal(sends, 2);
  assert.equal((await receiver.status()).runtime.capabilities.task_lookup_after_restart, false);
  console.log(JSON.stringify({ connector_version: CONNECTOR_VERSION, platform: origin.origin,
    normal_work: first.id, unknown_work: second.id, native_dispatches: sends,
    duplicate_submission: 'same original task', connector_restart: 'original result recovered',
    lost_native_response: 'unknown without resubmission', diagnostic_report: 'read back from real API',
    runtime: 'native A2A protocol fixture; no model, funds or external tools' }, null, 2));
} finally {
  journal?.close(); await runtime.close(); native.closeAllConnections();
  await new Promise(resolve => native.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
