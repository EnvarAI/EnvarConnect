import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorJournal } from '../dist/connector/state.js';
import { ConnectorLoop } from '../dist/connector/loop.js';
import { TaskApiError } from '../dist/connector/client.js';
import { RuntimeControlUnsupported } from '../dist/adapters/a2a-runtime.js';
import { NativeRequestNotStarted } from '../dist/adapters/native-a2a.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'envar-connector-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = { origin: 'https://envar.example', agentId: randomUUID(), connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'http://127.0.0.1:9900/card' };
  const task = { id: randomUUID(), context_id: randomUUID(), caller_agent_id: randomUUID(), target_agent_id: binding.agentId,
    connection_id: binding.connectionId, endpoint_id: null, target_name: 'Native Agent', target_handle: '', status: 'queued',
    request: { message: 'A real bounded task', tool: '', arguments: {} }, result: {}, error_code: '', remote_task_id: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), cancel_requested_at: null, deadline_at: new Date(Date.now() + 86400000).toISOString() };
  const delivery = { id: 1, kind: 'task', task, event: { status: 'queued' } };
  let claim, reference;
  const calls = { claim: [], start: 0, report: [], ack: [], nativeStart: 0, nativeRead: 0, cancel: 0 };
  const faults = { startResponseLost: false, reportResponseLost: false, nativeResponseLost: false, ackLost: false, cancelBeforeStart: false };
  const reports = new Map(); const state = { native: 'working', deliveries: [delivery] };
  const client = {
    reportRuntime: async () => 'accepted',
    status: async () => ({ id: binding.connectionId, agent_id: binding.agentId, mode: 'inbox', status: 'active', adapter: binding.adapter }),
    inbox: async () => ({ items: state.deliveries.filter(d => !calls.ack.includes(d.id)), next_cursor: null }),
    get: async () => structuredClone(task),
    claim: async (_id, key) => {
      calls.claim.push(key); claim ??= { id: key, fence: 1, lease_until: new Date(Date.now() + 120000).toISOString() };
      return { ...structuredClone(task), claim, execution_ref: {} };
    },
    start: async (_id, value, execution) => {
      assert.deepEqual(value, { id: claim.id, fence: claim.fence }); assert.equal(execution.key, task.id);
      if (faults.cancelBeforeStart) { task.status = 'canceled'; throw new TaskApiError(409, 'conflict'); }
      if (task.status === 'queued') { calls.start++; task.status = 'working'; }
      if (faults.startResponseLost) { faults.startResponseLost = false; throw new Error('response lost after durable admission'); }
      return { ...structuredClone(task), claim, execution_ref: execution };
    },
    renew: async () => ({ ...structuredClone(task), claim, execution_ref: { key: task.id } }),
    recover: async (_id, value, execution) => {
      assert.equal(value.id, claim.id); assert.equal(execution.key, task.id);
      claim.lease_until = new Date(Date.now() + 120000).toISOString();
      return { ...structuredClone(task), claim, execution_ref: execution };
    },
    report: async (_id, event) => {
      const old = reports.get(event.event_id);
      if (old) assert.deepEqual(old, event);
      else {
        reports.set(event.event_id, structuredClone(event)); calls.report.push(structuredClone(event));
        task.status = { progress: 'working', outcome_unknown: 'unknown', cancel_confirmed: 'canceled' }[event.kind] ?? event.kind;
        if (event.kind === 'completed') task.result = { text: event.text };
      }
      if (faults.reportResponseLost) { faults.reportResponseLost = false; throw new Error('report receipt lost'); }
      return structuredClone(task);
    },
    acknowledge: async id => { if (faults.ackLost) { faults.ackLost = false; throw new Error('ack lost'); } calls.ack.push(id); },
  };
  const runtime = {
    key: 'hermes', probe: async () => ({ adapter: 'hermes', runtimeVersion: 'test', capabilities: { recover: true, input: false, cancel: false } }),
    start: async (value, key) => {
      calls.nativeStart++; assert.equal(value.id, task.id); assert.equal(key, task.id);
      if (faults.nativeResponseLost) throw new Error('native POST response lost');
      reference = { adapter: 'hermes', version: 1, value: { task: 'native-original', context: task.context_id } };
      return { reference, state: state.native, text: 'Original native result' };
    },
    observe: async value => {
      calls.nativeRead++; assert.deepEqual(value, reference);
      return { reference, state: state.native, text: 'Original native result' };
    },
    cancel: async () => { calls.cancel++; throw new RuntimeControlUnsupported(); },
    provideInput: async () => { throw new RuntimeControlUnsupported(); }, close: async () => {},
  };
  const path = join(dir, 'connector.sqlite3');
  let journal = new ConnectorJournal(path, binding), loop = new ConnectorLoop(client, runtime, journal);
  t.after(() => journal.close());
  return { binding, task, delivery, calls, faults, state, client, runtime, path,
    get journal() { return journal; }, get loop() { return loop; },
    reopen() { journal.close(); journal = new ConnectorJournal(path, binding); loop = new ConnectorLoop(client, runtime, journal); },
  };
}

test('restart observes the original native handle and completion report is idempotent', async t => {
  const f = fixture(t); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.journal.get(f.task.id).phase, 'running');
  f.reopen(); f.state.native = 'completed'; f.faults.reportResponseLost = true;
  await assert.rejects(f.loop.tick());
  const pending = f.journal.get(f.task.id).pendingReport;
  assert.equal(pending.kind, 'completed');
  f.reopen(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 1);
  assert.equal(f.calls.report.filter(e => e.kind === 'completed').length, 1);
  assert.equal(f.journal.get(f.task.id).phase, 'terminal');
  assert.equal(f.journal.get(f.task.id).observation.text, 'Original native result');
  assert.ok(f.calls.ack.includes(1));
  assert.equal(statSync(f.path).mode & 0o077, 0);
});
test('receiver rejects a changed server adapter before claiming or dispatching', async t => {
  const f = fixture(t);
  f.client.status = async () => ({ id: f.binding.connectionId, agent_id: f.binding.agentId, mode: 'inbox',
    status: 'active', adapter: 'codex' });
  await assert.rejects(f.loop.tick(), /original Agent\/runtime binding/);
  assert.equal(f.calls.claim.length, 0);
  assert.equal(f.calls.nativeStart, 0);
});
test('lost admission response is retried with the same claim before one native dispatch', async t => {
  const f = fixture(t); f.faults.startResponseLost = true;
  await assert.rejects(f.loop.tick()); assert.equal(f.calls.nativeStart, 0);
  const key = f.journal.get(f.task.id).claimRequestId;
  f.reopen(); await f.loop.tick();
  assert.equal(f.calls.start, 1); assert.equal(f.calls.nativeStart, 1);
  assert.equal(f.journal.get(f.task.id).claimRequestId, key);
});
for (const responseLost of [false, true]) {
  for (const knownNotStarted of [false, true]) {
    test(`restored admission reports a ${knownNotStarted ? 'rejected' : 'uncertain'} native start after ${responseLost ? 'a lost admission response' : 'an admitted checkpoint'}`, async t => {
      const f = fixture(t);
      // Stop after platform admission, before the receiver dispatches native task.
      f.faults.startResponseLost = true;
      await assert.rejects(f.loop.tick(), /response lost after durable admission/);
      const record = f.journal.get(f.task.id);
      if (!responseLost) { record.phase = 'admitted'; f.journal.save(record); }
      const claim = structuredClone(record.claim), key = record.claimRequestId;
      let attempts = 0;
      f.runtime.start = async () => {
        attempts++;
        assert.equal(f.journal.get(f.task.id).phase, 'dispatching');
        if (knownNotStarted) throw new NativeRequestNotStarted();
        throw new Error('Original native dispatch outcome unavailable');
      };
      f.reopen(); await f.loop.tick();
      assert.equal(f.journal.get(f.task.id).phase, knownNotStarted ? 'terminal' : 'unknown');
      assert.equal(f.calls.report.length, 1);
      assert.equal(f.calls.report[0].kind, knownNotStarted ? 'failed' : 'outcome_unknown');
      assert.deepEqual(f.calls.report[0].claim, { id: claim.id, fence: claim.fence });
      assert.equal(f.journal.get(f.task.id).claimRequestId, key);
      assert.equal(f.calls.start, 1); assert.equal(attempts, 1);
      f.reopen(); await f.loop.tick();
      assert.equal(f.calls.report.length, 1); assert.equal(attempts, 1);
    });
  }
}
test('lost native POST stays unknown across restarts with no repeated model task', async t => {
  const f = fixture(t); f.faults.nativeResponseLost = true;
  await f.loop.tick(); assert.equal(f.journal.get(f.task.id).phase, 'unknown');
  f.reopen(); await f.loop.tick(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 0);
  assert.equal(f.calls.report.filter(e => e.kind === 'outcome_unknown').length, 1);
});
test('interrupted native dispatch marker cannot be turned back into a fresh dispatch', async t => {
  const f = fixture(t); f.journal.ingest(f.delivery);
  const record = f.journal.get(f.task.id); const claimed = await f.client.claim(f.task.id, record.claimRequestId);
  record.claim = claimed.claim; await f.client.start(f.task.id, { id: claimed.claim.id, fence: 1 }, { key: f.task.id });
  record.phase = 'dispatching'; f.journal.save(record); f.reopen(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.get(f.task.id).phase, 'unknown');
});
test('cancellation between claim and start never reaches the native runtime', async t => {
  const f = fixture(t); f.faults.cancelBeforeStart = true;
  await f.loop.tick(); assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.get(f.task.id).phase, 'terminal');
});
test('unacknowledged control is not invoked twice after restart', async t => {
  const f = fixture(t); await f.loop.tick();
  f.state.deliveries.push({ id: 2, kind: 'cancel', task: structuredClone(f.task), event: {} });
  f.faults.ackLost = true;
  f.client.generation = 1;
  await assert.rejects(f.loop.tick()); assert.equal(f.calls.cancel, 1);
  f.reopen(); await f.loop.tick(); assert.equal(f.calls.cancel, 1); assert.ok(f.calls.ack.includes(2));
});
test('result delivery is durable before ack and is never executed as new task', async t => {
  const f = fixture(t);
  const result = { ...structuredClone(f.task), id: randomUUID(), caller_agent_id: f.binding.agentId,
    target_agent_id: randomUUID(), connection_id: randomUUID(), status: 'completed', result: { text: 'Peer result' } };
  f.state.deliveries = [{ id: 8, kind: 'result', task: result, event: { status: 'completed' } }];
  await f.loop.tick(); f.reopen();
  assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.results()[0].task.result.text, 'Peer result');
  assert.ok(f.calls.ack.includes(8));
});
test('a private journal cannot silently bind to another Agent', t => {
  const f = fixture(t);
  assert.throws(() => new ConnectorJournal(f.path, { ...f.binding, agentId: randomUUID() }), /another Agent/);
});

test('durably observed completion survives a crash before its report is queued', async t => {
  const f = fixture(t); await f.loop.tick();
  const record = f.journal.get(f.task.id);
  record.phase = 'dispatching'; record.observation = { reference: record.reference, state: 'completed', text: 'Saved actual result' };
  f.journal.save(record); f.reopen();
  f.runtime.observe = async () => { throw new Error('native task cache was lost'); };
  await f.loop.tick();
  assert.equal(f.task.result.text, 'Saved actual result');
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 0);
  assert.equal(f.journal.get(f.task.id).phase, 'terminal');
});
