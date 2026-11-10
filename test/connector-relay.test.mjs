import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorJournal } from '../dist/connector/state.js';
import { RelayLoop } from '../dist/connector/relay-loop.js';
import { digest } from '../dist/shared/json.js';
import { WorkApiError } from '../dist/connector/client.js';

const binding = { origin: 'https://envar.test', agentId: randomUUID(), connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'http://127.0.0.1:8080/card' };
const reference = { origin: binding.cardUrl, interface: 'http://127.0.0.1:8080/rpc', task_id: 'native-original', context_id: 'native-context' };
const task = state => ({ id: reference.task_id, contextId: reference.context_id, status: { state }, artifacts: [{ artifactId: 'original', parts: [{ text: 'Original delivery' }] }] });
function fixture(path = ':memory:') {
  const command = { relay_version: '1', command_id: randomUUID(), connection_id: binding.connectionId, binding_id: randomUUID(), work_id: randomUUID(), sequence: 1,
    kind: 'send', control_generation: 0, a2a: { method: 'SendMessage', params: { message: { messageId: 'client:not-uuid', role: 'ROLE_USER', parts: [{ text: 'Original task' }] } } },
    state: 'pending', claim: null, admission_ref: null, last_event_sequence: 0, lease_until: null, result_digest: '' };
  command.request_digest = digest({ kind: command.kind, method: command.a2a.method, params: command.a2a.params, binding: command.binding_id });
  const stats = { sends: 0, reads: 0, admissions: 0, acknowledgements: 0, acked: false, events: new Map() };
  const client = {
    async relayHello() { return true; },
    async relayCommands() { return stats.acked ? [] : [structuredClone(command)]; },
    async relayCommand(id) { assert.equal(id, command.command_id); return structuredClone(command); },
    async relayOperation(id, operation, body) {
      assert.equal(id, command.command_id);
      if (operation === 'claim') { command.claim ??= { id: randomUUID(), fence: 1 }; command.state = 'claimed'; }
      else if (operation === 'admit') { stats.admissions++; command.state = 'admitted'; assert.equal(body.execution_key, command.command_id); }
      else { assert.equal(operation, 'recover'); assert.deepEqual(body.claim, command.claim); assert.ok(body.last_event_sequence >= command.last_event_sequence); }
      return structuredClone(command);
    },
    async relayEvent(id, event) {
      assert.equal(id, command.command_id);
      assert.equal(digest(event.payload), event.payload_digest);
      if (stats.events.has(event.event_id)) assert.deepEqual(stats.events.get(event.event_id), event);
      else { assert.equal(event.sequence, command.last_event_sequence + 1); stats.events.set(event.event_id, structuredClone(event)); command.last_event_sequence = event.sequence; }
      if (event.kind === 'native_reference') command.native_reference = event.payload;
      if (event.kind === 'outcome_unknown' && command.state !== 'completed') { command.result_digest = event.payload_digest; command.state = 'unknown'; }
      if (event.kind === 'delivery_receipt' || event.payload.status?.state === 'TASK_STATE_COMPLETED') { command.result_digest = event.payload_digest; command.state = 'completed'; }
      else if (event.kind === 'task_snapshot' && command.state !== 'completed') command.state = 'observing';
      stats.acked = false;
      return { result_digest: command.result_digest, state: command.state };
    },
    async relayAck(id, body) { assert.equal(id, command.command_id); assert.equal(body.result_digest, command.result_digest); stats.acknowledgements++; stats.acked = true; },
  };
  const runtime = {
    async cardDigest() { return 'a'.repeat(64); },
    async send(params) { stats.sends++; assert.deepEqual(params, command.a2a.params); return { reference, task: task('TASK_STATE_WORKING') }; },
    async read(remote) { stats.reads++; assert.deepEqual(remote, reference); return task('TASK_STATE_COMPLETED'); },
  };
  const journal = new ConnectorJournal(path, binding);
  return { command, stats, client, runtime, journal, loop: new RelayLoop(client, runtime, journal) };
}

test('standard relay preserves original Task, exact event receipts and one admission', async () => {
  const f = fixture();
  try {
    await f.loop.tick(true); await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 1); assert.equal(f.stats.admissions, 1);
    assert.equal(f.stats.events.size, 3); assert.equal(f.journal.pendingRelay().length, 0);
    assert.equal(f.journal.getRelay(f.command.command_id).reference.task_id, 'native-original');
  } finally { f.journal.close(); }
});

test('unknown native POST is acknowledged but never dispatched again', async () => {
  const f = fixture();
  f.runtime.send = async () => { f.stats.sends++; throw new Error('response lost'); };
  try {
    await f.loop.tick(true); await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 0);
    assert.equal(f.journal.pendingRelay()[0].phase, 'outcome_unknown');
    assert.equal(f.stats.events.size, 1);
  } finally { f.journal.close(); }
});

test('native read failure keeps original reference and later recovery completes it', async () => {
  const f = fixture(); let fail = true;
  f.runtime.read = async remote => { f.stats.reads++; assert.deepEqual(remote, reference); if (fail) { fail = false; throw new Error('native restarting'); } return task('TASK_STATE_COMPLETED'); };
  try {
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.journal.pendingRelay()[0].phase, 'outcome_unknown');
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 2); assert.equal(f.stats.admissions, 1);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('a process restart after dispatch marker never creates a replacement send', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-relay-'));
  const path = join(directory, 'journal.sqlite3');
  const f = fixture(path);
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 }; f.command.state = 'admitted';
    record.command = structuredClone(f.command); record.phase = 'dispatch_started';
    f.journal.saveRelay(record); f.journal.close();
    const recovered = new ConnectorJournal(path, binding);
    try { await new RelayLoop(f.client, f.runtime, recovered).tick(true); assert.equal(f.stats.sends, 0); assert.equal(recovered.pendingRelay()[0].phase, 'outcome_unknown'); }
    finally { recovered.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('lost terminal acknowledgement reuses its receipt without native execution', async () => {
  const f = fixture(); const ack = f.client.relayAck; let fail = true;
  f.client.relayAck = async (...args) => { await ack(...args); if (fail) { fail = false; throw new Error('ack response lost'); } };
  try {
    await f.loop.tick(true); await assert.rejects(() => f.loop.tick(true));
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 1); assert.equal(f.stats.acknowledgements, 2);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('immediate native Message is saved before its receipt is acknowledged', async () => {
  const f = fixture();
  const message = { messageId: 'response:one', role: 'ROLE_AGENT', parts: [{ text: 'Original immediate reply' }] };
  f.runtime.send = async () => { f.stats.sends++; return { message }; };
  try {
    await f.loop.tick(true);
    assert.deepEqual(f.journal.getRelay(f.command.command_id).result.message, message);
    assert.equal(f.journal.pendingRelay().length, 0); assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 0);
  } finally { f.journal.close(); }
});

test('an immediately terminal Task is read back once by original ID before final acknowledgement', async () => {
  const f = fixture();
  f.runtime.send = async () => { f.stats.sends++; return { reference, task: task('TASK_STATE_COMPLETED') }; };
  try {
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 1);
    assert.equal([...f.stats.events.values()].filter(event => event.kind === 'task_snapshot').length, 2);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('a stale local admission checkpoint adopts the platform original reference without sending again', async () => {
  const f = fixture();
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 };
    f.command.state = 'observing'; f.command.native_reference = reference;
    f.command.last_event_sequence = 2; f.command.last_observation_sequence = 40;
    record.command = structuredClone(f.command); record.phase = 'admitted';
    f.journal.saveRelay(record);
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.reads, 1);
    assert.equal([...f.stats.events.values()][0].observation_seq, 41);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('proven native preparation failure is retried before admission without a SendMessage', async () => {
  const f = fixture(); let fail = true;
  f.runtime.prepareSend = async params => { if (fail) { fail = false; throw new Error('Card unavailable'); } return () => f.runtime.send(params); };
  try {
    await assert.rejects(() => f.loop.tick(true));
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.admissions, 0);
    assert.equal(f.journal.pendingRelay()[0].phase, 'intent_persisted');
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.admissions, 1);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('permanently rejected payload is retained locally while bounded uncertainty allows original reads', async () => {
  const f = fixture(); const report = f.client.relayEvent; let reject = true;
  f.client.relayEvent = async (id, value) => {
    if (reject && value.kind === 'task_snapshot') { reject = false; throw new WorkApiError(400, 'invalid_payload'); }
    return report(id, value);
  };
  try {
    await f.loop.tick(true);
    assert.equal(f.journal.pendingRelay()[0].phase, 'outcome_unknown');
    assert.equal(f.journal.pendingRelay()[0].rejectedEvents.length, 1);
    assert.equal(f.journal.pendingRelay()[0].pending.length, 0);
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 1);
    assert.equal(f.journal.pendingRelay().length, 0);
    assert.equal([...f.stats.events.values()][1].payload.reason, 'receipt_incomplete');
  } finally { f.journal.close(); }
});

test('unknown outcome ACK failure is retried even without a native reference', async () => {
  const f = fixture(); const ack = f.client.relayAck; let fail = true;
  f.runtime.send = async () => { f.stats.sends++; throw new Error('Unknown POST'); };
  f.client.relayAck = async (...args) => { if (fail) { fail = false; throw new WorkApiError(503, 'unavailable'); } return ack(...args); };
  try {
    await assert.rejects(() => f.loop.tick(true));
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.acked, true); assert.equal(f.stats.acknowledgements, 1);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.events.size, 1);
  } finally { f.journal.close(); }
});

test('a failed original final read is retried after acknowledging the terminal receipt', async () => {
  const f = fixture(); let fail = true;
  f.runtime.send = async () => { f.stats.sends++; return { reference, task: task('TASK_STATE_COMPLETED') }; };
  f.runtime.read = async remote => { f.stats.reads++; assert.deepEqual(remote, reference); if (fail) { fail = false; throw new Error('Temporary GET failure'); } return task('TASK_STATE_COMPLETED'); };
  try {
    await f.loop.tick(true);
    assert.equal(f.journal.pendingRelay()[0].finalReadPending, true); assert.equal(f.stats.acked, true);
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 1); assert.equal(f.stats.reads, 2);
    assert.equal(f.journal.pendingRelay().length, 0);
    assert.equal([...f.stats.events.values()].filter(item => item.kind === 'task_snapshot').length, 2);
  } finally { f.journal.close(); }
});

test('expired restored admission without native evidence reports uncertainty and never repeats a POST', async () => {
  const f = fixture();
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 }; f.command.state = 'unknown';
    record.command = structuredClone(f.command); record.phase = 'admitted';
    f.journal.saveRelay(record);
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.admissions, 0);
    assert.equal(f.journal.pendingRelay()[0].phase, 'outcome_unknown');
    assert.equal(f.stats.acked, true); assert.equal(f.stats.events.size, 1);
  } finally { f.journal.close(); }
});

test('stale dispatch checkpoint adopts the committed cursor and original reference before reporting', async () => {
  const f = fixture();
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 }; f.command.state = 'observing';
    f.command.native_reference = reference; f.command.last_event_sequence = 2;
    f.command.last_observation_sequence = 1;
    record.command = structuredClone(f.command); record.phase = 'dispatch_started';
    f.journal.saveRelay(record);
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.reads, 1);
    assert.equal([...f.stats.events.values()][0].sequence, 3);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('terminal readback evidence is saved in the same checkpoint that clears its obligation', async () => {
  const f = fixture(); const save = f.journal.saveRelay.bind(f.journal);
  f.runtime.send = async () => { f.stats.sends++; return { reference, task: task('TASK_STATE_COMPLETED') }; };
  f.journal.saveRelay = record => {
    if (f.stats.reads && !record.finalReadPending && !f.stats.acked && f.command.last_event_sequence === 2)
      assert.ok(record.pending.some(e => e.kind === 'task_snapshot'), 'Readback obligation cleared without durable evidence');
    save(record);
  };
  try { await f.loop.tick(true); assert.equal(f.stats.reads, 1); assert.equal(f.journal.pendingRelay().length, 0); }
  finally { f.journal.close(); }
});

test('adopting an immediate completion still verifies the original Task before retiring its checkpoint', async () => {
  const f = fixture();
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 }; f.command.state = 'completed';
    f.command.native_reference = reference; f.command.last_event_sequence = 2;
    f.command.last_observation_sequence = 1; f.command.result_digest = digest(task('TASK_STATE_COMPLETED'));
    record.command = structuredClone(f.command); record.phase = 'admitted';
    f.journal.saveRelay(record);
    await f.loop.tick(true);
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.reads, 1);
    assert.equal([...f.stats.events.values()][0].observation_seq, 2);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});

test('reference-only stale checkpoint obtains both observations needed for original enrollment', async () => {
  const f = fixture();
  try {
    const record = f.journal.ingestRelay(f.command);
    f.command.claim = { id: randomUUID(), fence: 1 }; f.command.state = 'observing';
    f.command.native_reference = reference; f.command.last_event_sequence = 1;
    record.command = structuredClone(f.command); record.phase = 'dispatch_started';
    f.journal.saveRelay(record);
    await f.loop.tick(true); await f.loop.tick(true);
    assert.equal(f.stats.sends, 0); assert.equal(f.stats.reads, 2);
    assert.equal([...f.stats.events.values()].filter(e => e.kind === 'task_snapshot').length, 2);
    assert.equal(f.journal.pendingRelay().length, 0);
  } finally { f.journal.close(); }
});
