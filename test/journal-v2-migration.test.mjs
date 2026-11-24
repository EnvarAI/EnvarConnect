import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, statSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorJournal } from '../dist/connector/state.js';

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
