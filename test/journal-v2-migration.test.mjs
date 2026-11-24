import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, statSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorJournal } from '../dist/connector/state.js';
import { ConnectorLoop } from '../dist/connector/loop.js';
import { digest } from '../dist/shared/json.js';

const binding = { origin: 'https://envar.ai', agentId: randomUUID(), connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'https://seller.example/card' };
const backups = (dir) => readdirSync(dir).filter(name => /^journal\.sqlite3\.v1-backup-[0-9a-f-]+\.sqlite3$/.test(name));
function oldJournal(path, { malformed = false } = {}) {
  const task = { id: randomUUID(), target_agent_id: binding.agentId, connection_id: binding.connectionId,
    context_id: randomUUID(), request: { message: 'Keep user content $t(secret.key)', arguments: { work_id: 'user-value' } } };
  const claim = { id: randomUUID(), fence: 7, lease_until: new Date().toISOString() };
  const event = { event_id: randomUUID(), sequence: 4, payload: { work_id: 'native-user-data' } };
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE connector_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE connector_work (id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL); CREATE INDEX connector_work_phase ON connector_work(phase,created); CREATE TABLE connector_delivery (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0); CREATE TABLE connector_outgoing (id TEXT PRIMARY KEY,request TEXT NOT NULL,work TEXT); CREATE TABLE connector_control (id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE connector_order_request (id TEXT PRIMARY KEY,request TEXT NOT NULL,order_id TEXT); CREATE TABLE connector_relay (id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL);');
  db.prepare("INSERT INTO connector_meta VALUES ('binding',?)").run(JSON.stringify(binding));
  const record = { work: task, deliveryId: 1, phase: 'report_pending', claimRequestId: randomUUID(), claim,
    reference: { adapter: 'hermes', version: 1, value: { taskId: 'native-id' } },
    pendingReport: { claim, event_id: randomUUID(), kind: 'outcome_unknown', text: 'uncertain' } };
  db.prepare('INSERT INTO connector_work VALUES (?,?,?,?)').run(task.id, record.phase, JSON.stringify(malformed ? { ...record, work: null } : record), 11);
  db.prepare('INSERT INTO connector_delivery VALUES (?,?,?,?)').run(1, 'work', JSON.stringify({ id: 1, kind: 'work', work: task, event }), 0);
  db.prepare('INSERT INTO connector_delivery VALUES (?,?,?,?)').run(2, 'result', JSON.stringify({ id: 2, kind: 'result', work: task, event }), 1);
  db.prepare('INSERT INTO connector_outgoing VALUES (?,?,?)').run(randomUUID(), JSON.stringify({ message: 'once' }), JSON.stringify(task));
  const command = { command_id: randomUUID(), connection_id: binding.connectionId, binding_id: randomUUID(),
    work_id: task.id, request_digest: 'digest', a2a: { method: 'SendMessage', params: { work_id: 'native-wire-value' } } };
  const relay = { command, phase: 'dispatch_started', claimRequestId: randomUUID(), executionKey: command.command_id,
    nextEvent: 5, nextObservation: 3, pending: [event], finalDigest: 'original', acknowledgedSequence: 3 };
  db.prepare('INSERT INTO connector_relay VALUES (?,?,?,?)').run(command.command_id, relay.phase, JSON.stringify(relay), 12);
  db.close();
  chmodSync(path, 0o600);
  return { task, record, relay, event };
}
test('v1 journal migrates in place once and preserves uncertain execution, receipts and opaque content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envar-journal-v2-')), path = join(dir, 'journal.sqlite3');
  try {
    const original = oldJournal(path);
    let journal = new ConnectorJournal(path, binding);
    assert.equal(journal.get(original.task.id).phase, 'report_pending');
    assert.deepEqual(journal.get(original.task.id).claim, original.record.claim);
    assert.deepEqual(journal.get(original.task.id).pendingReport, original.record.pendingReport);
    assert.deepEqual(journal.get(original.task.id).task.request, original.task.request);
    assert.equal(journal.deliveries()[0].kind, 'task');
    assert.equal(journal.deliveries()[0].event.payload.work_id, 'native-user-data');
    assert.equal(journal.results().length, 1);
    assert.equal(journal.getRelay(original.relay.command.command_id).command.task_id, original.task.id);
    assert.equal(journal.getRelay(original.relay.command.command_id).command.a2a.params.work_id, 'native-wire-value');
    assert.deepEqual(journal.getRelay(original.relay.command.command_id).pending, original.relay.pending);
    journal.close();
    const migrated = new DatabaseSync(path, { readOnly: true });
    assert.equal(migrated.prepare("SELECT value FROM connector_meta WHERE key='schema_version'").get().value, '2');
    assert.equal(JSON.parse(migrated.prepare('SELECT task FROM connector_outgoing').get().task).id, original.task.id);
    assert.equal(migrated.prepare('SELECT acked FROM connector_delivery WHERE id=2').get().acked, 1);
    migrated.close();
    assert.equal(backups(dir).length, 1);
    const backupPath = join(dir, backups(dir)[0]);
    assert.equal(statSync(backupPath).mode & 0o077, 0);
    const backup = new DatabaseSync(backupPath);
    assert.equal(backup.prepare("SELECT value FROM connector_meta WHERE key='schema_version'").get(), undefined);
    assert.deepEqual(JSON.parse(backup.prepare('SELECT value FROM connector_work').get().value), original.record);
    backup.close();
    journal = new ConnectorJournal(path, binding);
    assert.equal(journal.pending().length, 1);
    assert.equal(journal.pendingRelay().length, 1);
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('malformed v1 record rolls back without marking migration complete or losing its backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envar-journal-v2-')), path = join(dir, 'journal.sqlite3');
  try {
    const data = oldJournal(path, { malformed: true });
    assert.throws(() => new ConnectorJournal(path, binding), /journal shape changed/);
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT value FROM connector_meta WHERE key='schema_version'").get(), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='connector_work'").get().name, 'connector_work');
    const original = JSON.parse(db.prepare('SELECT value FROM connector_work').get().value);
    db.prepare('UPDATE connector_work SET value=?').run(JSON.stringify({ ...original, work: data.task }));
    db.close();
    assert.equal(backups(dir).length, 1);
    const retried = new ConnectorJournal(path, binding);
    assert.equal(retried.pending().length, 1);
    retried.close();
    assert.equal(backups(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('live receiver lock prevents v1 migration before changing the journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envar-journal-v2-')), path = join(dir, 'journal.sqlite3');
  try {
    oldJournal(path);
    writeFileSync(join(dir, 'receiver.lock'), JSON.stringify({ pid: process.pid, nonce: 'live' }), { mode: 0o600 });
    assert.throws(() => new ConnectorJournal(path, binding), /Another Connector/);
    assert.equal(backups(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrated v1 journal resumes committed Task and relay receipts without native redispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envar-journal-v2-')), path = join(dir, 'journal.sqlite3');
  let journal;
  try {
    oldJournal(path);
    const makeTask = () => ({ id: randomUUID(), context_id: randomUUID(), caller_agent_id: null,
      target_agent_id: binding.agentId, connection_id: binding.connectionId, endpoint_id: null,
      status: 'working', request: { message: 'Keep opaque $t(secret.key)', arguments: { work_id: 'user-supplied' } },
      result: {} });
    const tasks = [makeTask(), makeTask(), makeTask()];
    const originalClaims = tasks.map(() => ({ id: randomUUID(), fence: 7, lease_until: new Date(Date.now() + 120000).toISOString() }));
    const nativeReference = { adapter: 'hermes', version: 1, value: { taskId: 'native-original' } };
    const originalReportId = randomUUID();
    const records = [
      { work: tasks[0], deliveryId: 11, phase: 'admitted', claimRequestId: randomUUID(),
        claim: originalClaims[0], reference: nativeReference,
        observation: { reference: nativeReference, state: 'completed', text: 'Original result' } },
      { work: tasks[1], deliveryId: 12, phase: 'dispatching', claimRequestId: randomUUID(), claim: originalClaims[1] },
      { work: tasks[2], deliveryId: 13, phase: 'report_pending', claimRequestId: randomUUID(),
        claim: originalClaims[2], afterReport: 'terminal',
        pendingReport: { claim: { id: originalClaims[2].id, fence: originalClaims[2].fence },
          event_id: originalReportId, kind: 'completed', text: 'Retained completion' } },
    ];
    const command = { relay_version: '1', command_id: randomUUID(), connection_id: binding.connectionId,
      binding_id: randomUUID(), work_id: tasks[0].id, sequence: 1, control_generation: 0,
      kind: 'send', a2a: { method: 'SendMessage', params: { message: { messageId: 'opaque',
        parts: [{ text: 'Native work_id stays opaque' }] }, work_id: 'native-opaque-value' } },
      state: 'admitted', claim: { id: randomUUID(), fence: 9 }, admission_ref: null,
      last_event_sequence: 0, lease_until: new Date(Date.now() + 120000).toISOString(), result_digest: '' };
    command.request_digest = digest({ kind: command.kind, method: command.a2a.method,
      params: command.a2a.params, binding: command.binding_id });
    const finalSnapshot = { id: 'native-original', contextId: 'native-context',
      status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'original', parts: [{ text: 'Original relay result' }] }] };
    const pendingEvent = { claim: command.claim, event_id: randomUUID(), sequence: 1,
      control_generation: 0, observation_seq: 2, kind: 'task_snapshot', payload: finalSnapshot,
      payload_digest: digest(finalSnapshot) };
    const relayRecord = { command, phase: 'dispatch_started', claimRequestId: randomUUID(),
      executionKey: command.command_id, nextEvent: 2, nextObservation: 3, pending: [pendingEvent],
      finalDigest: pendingEvent.payload_digest };
    const old = new DatabaseSync(path);
    old.exec('DELETE FROM connector_work; DELETE FROM connector_delivery; DELETE FROM connector_relay;');
    for (let index = 0; index < records.length; index++) {
      const record = records[index], delivery = { id: record.deliveryId, kind: 'work', work: tasks[index],
        event: { status: 'queued', opaque: { work_id: 'user-event' } } };
      old.prepare('INSERT INTO connector_work VALUES (?,?,?,?)').run(tasks[index].id, record.phase, JSON.stringify(record), index);
      old.prepare('INSERT INTO connector_delivery VALUES (?,?,?,0)').run(delivery.id, delivery.kind, JSON.stringify(delivery));
    }
    old.prepare('INSERT INTO connector_relay VALUES (?,?,?,?)').run(command.command_id, relayRecord.phase, JSON.stringify(relayRecord), 10);
    old.close();

    journal = new ConnectorJournal(path, binding);
    const calls = { nativeStart: 0, nativeSend: 0, reports: [], taskAcks: [], relayEvents: [], relayAcks: [] };
    const serverCommand = { ...command, task_id: tasks[0].id };
    delete serverCommand.work_id;
    const client = {
      generation: 1,
      async status() { return { id: binding.connectionId, agent_id: binding.agentId, adapter: binding.adapter }; },
      async reportRuntime() { return 'accepted'; },
      async inbox() { return { items: [], next_cursor: null }; },
      async report(id, report) {
        calls.reports.push({ id, report: structuredClone(report) });
        return { status: report.kind === 'completed' ? 'completed' : 'unknown' };
      },
      async acknowledge(id) { calls.taskAcks.push(id); },
      async relayHello() { return true; },
      async relayCommands() { return []; },
      async relayCommand(id) { assert.equal(id, command.command_id); return structuredClone(serverCommand); },
      async relayOperation(id, kind, body) {
        assert.equal(id, command.command_id); assert.equal(kind, 'recover');
        assert.deepEqual(body.claim, command.claim);
        assert.equal(body.execution_key, command.command_id);
        return structuredClone(serverCommand);
      },
      async relayEvent(id, event) {
        assert.equal(id, command.command_id);
        calls.relayEvents.push(structuredClone(event));
        serverCommand.last_event_sequence = event.sequence;
        serverCommand.result_digest = event.payload_digest;
        serverCommand.state = 'completed';
        return { result_digest: event.payload_digest, state: 'completed' };
      },
      async relayAck(id, body) { assert.equal(id, command.command_id); calls.relayAcks.push(structuredClone(body)); },
    };
    const runtime = {
      key: 'hermes',
      async probe() { return { adapter: 'hermes', runtimeVersion: 'fixture', capabilities: { recover: true, input: false, cancel: false } }; },
      async start() { calls.nativeStart++; throw new Error('Already dispatched Task must not start again'); },
      async observe() { throw new Error('Native read is unnecessary for retained terminal evidence'); },
      relay: {
        version: '1',
        async cardDigest() { return 'a'.repeat(64); },
        async send() { calls.nativeSend++; throw new Error('Already dispatched relay must not send again'); },
        async read() { throw new Error('Original terminal relay receipt is already retained'); },
      },
    };
    await new ConnectorLoop(client, runtime, journal).tick();
    assert.equal(calls.nativeStart, 0);
    assert.equal(calls.nativeSend, 0);
    assert.deepEqual(calls.reports.map(item => item.id).sort(), tasks.map(task => task.id).sort());
    for (let index = 0; index < tasks.length; index++) {
      const report = calls.reports.find(item => item.id === tasks[index].id).report;
      assert.deepEqual(report.claim, { id: originalClaims[index].id, fence: originalClaims[index].fence });
    }
    assert.equal(calls.reports.find(item => item.id === tasks[2].id).report.event_id, originalReportId);
    assert.deepEqual(calls.taskAcks.sort(), [11, 13]);
    assert.equal(journal.get(tasks[1].id).phase, 'unknown');
    assert.equal(journal.get(tasks[0].id).phase, 'terminal');
    assert.equal(journal.get(tasks[2].id).phase, 'terminal');
    assert.deepEqual(journal.get(tasks[0].id).task.request, tasks[0].request);
    assert.equal(calls.relayEvents.length, 1);
    assert.deepEqual(calls.relayEvents[0], pendingEvent);
    assert.equal(calls.relayAcks.length, 0);
    assert.equal(journal.getRelay(command.command_id).phase, 'dispatch_started');
    await new ConnectorLoop(client, runtime, journal).tick();
    assert.deepEqual(calls.relayAcks, [{ claim: command.claim, last_event_sequence: 1, result_digest: pendingEvent.payload_digest }]);
    assert.equal(journal.getRelay(command.command_id).phase, 'events_acked');
    assert.equal(journal.getRelay(command.command_id).command.a2a.params.work_id, 'native-opaque-value');
    journal.close(); journal = undefined;

    // A restart reads the same migrated receipts and cannot create another native call or ACK.
    journal = new ConnectorJournal(path, binding);
    await new ConnectorLoop(client, runtime, journal).tick();
    assert.equal(calls.nativeStart, 0); assert.equal(calls.nativeSend, 0);
    assert.equal(calls.relayEvents.length, 1); assert.equal(calls.relayAcks.length, 1);
    assert.equal(calls.reports.length, 3);
  } finally { journal?.close(); rmSync(dir, { recursive: true, force: true }); }
});
