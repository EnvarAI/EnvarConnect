/** Owner-only durable journal. Transport receipts never imply a second execution. */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Claim, Delivery, Report, Task } from './contracts.generated.js';
import type { RuntimeObservation, RuntimeReference } from '../adapters/types.js';
import { relayCommand, type RelayCommand, type RelayRecord } from './relay-types.js';

export type Phase =
  | 'prepared'
  | 'claimed'
  | 'admitted'
  | 'dispatching'
  | 'running'
  | 'waiting_input'
  | 'report_pending'
  | 'unknown'
  | 'terminal';
export interface LocalTask {
  task: Task;
  deliveryId: number;
  phase: Phase;
  claimRequestId: string;
  claim?: Claim & { lease_until: string | null };
  reference?: RuntimeReference;
  pendingReport?: Report;
  afterReport?: Phase;
  observation?: RuntimeObservation;
  lastObservation?: string;
  error?: string;
}
export interface LocalControl {
  deliveryId: number;
  operationId: string;
  phase: 'prepared' | 'dispatching' | 'observed' | 'unknown' | 'unsupported' | 'reported';
  observation?: RuntimeObservation;
  text?: string;
}
export interface ConnectorBinding {
  origin: string;
  agentId: string;
  connectionId: string;
  adapter: string;
  cardUrl: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parseStored<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(
      'A Connector journal record is unreadable. Preserve the original state before recovery.',
    );
  }
}
function privateFile(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077)
    throw new Error('Use an owner-only regular Connector file');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The original Connector journal shape changed');
  return value as Record<string, unknown>;
}
/** Change only Connect envelope names. User requests and native A2A data remain opaque. */
function migrateTaskRecord(raw: string, id: string): string {
  const record = object(parseStored(raw)),
    task = object(record.work);
  if (task.id !== id || record.task !== undefined)
    throw new Error('The original task journal is incomplete');
  const { work: _old, ...rest } = record;
  return JSON.stringify({ ...rest, task });
}
function migrateDelivery(raw: string, id: number): { kind: string; value: string } {
  const delivery = object(parseStored(raw)),
    task = object(delivery.work);
  if (
    typeof task.id !== 'string' ||
    delivery.id !== id ||
    delivery.task !== undefined ||
    typeof delivery.kind !== 'string'
  )
    throw new Error('The original delivery is incomplete');
  const { work: _old, ...rest } = delivery;
  const kind = delivery.kind === 'work' ? 'task' : String(delivery.kind);
  return { kind, value: JSON.stringify({ ...rest, kind, task }) };
}
function migrateRelay(raw: string, id: string): string {
  const record = object(parseStored(raw)),
    command = object(record.command);
  if (
    command.command_id !== id ||
    typeof command.work_id !== 'string' ||
    command.task_id !== undefined
  )
    throw new Error('The original relay identity is incomplete');
  const { work_id: task_id, ...rest } = command;
  return JSON.stringify({ ...record, command: { ...rest, task_id } });
}
export class ConnectorJournal {
  private readonly db: DatabaseSync;
  private lock?: { path: string; nonce: string; fd?: number };
  constructor(
    path: string,
    readonly binding: ConnectorBinding,
  ) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const directory = lstatSync(dirname(path));
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077)
        throw new Error('Use a private Connector directory');
      if (existsSync(path)) privateFile(path);
    }
    const existed = path !== ':memory:' && existsSync(path);
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const meta = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connector_meta'")
        .get();
      if (meta) {
        const existing = this.db
          .prepare("SELECT value FROM connector_meta WHERE key='binding'")
          .get();
        if (!existing || existing.value !== JSON.stringify(binding))
          throw new Error('This journal belongs to another Agent or runtime binding');
        const version = this.db
          .prepare("SELECT value FROM connector_meta WHERE key='schema_version'")
          .get();
        if (!version) this.migrateV1(path);
        else if (version.value !== '2')
          throw new Error('Unsupported Connector journal version; preserve the original state');
        else {
          const taskTable = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connector_task'")
            .get();
          if (!taskTable) throw new Error('The versioned Connector task journal is incomplete');
        }
      } else if (existed)
        throw new Error('An existing Connector journal has no binding; preserve it for inspection');
      else this.createV2(binding);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private createV2(binding: ConnectorBinding): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        'CREATE TABLE connector_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE connector_task (id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL); CREATE TABLE connector_delivery (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0); CREATE TABLE connector_outgoing (id TEXT PRIMARY KEY,request TEXT NOT NULL,task TEXT); CREATE TABLE connector_control (id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE connector_order_request (id TEXT PRIMARY KEY,request TEXT NOT NULL,order_id TEXT); CREATE TABLE connector_relay (id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL); CREATE INDEX connector_task_phase ON connector_task(phase,created);',
      );
      this.db
        .prepare("INSERT INTO connector_meta VALUES ('binding',?)")
        .run(JSON.stringify(binding));
      this.db.prepare("INSERT INTO connector_meta VALUES ('schema_version','2')").run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private migrateV1(path: string): void {
    if (path === ':memory:')
      throw new Error('An in-memory legacy journal cannot be migrated safely');
    this.acquireProcessLock(join(dirname(path), 'receiver.lock'));
    try {
      const sourceVersion = this.db.prepare('PRAGMA data_version').get()?.data_version;
      const backup = path + '.v1-backup-' + randomUUID() + '.sqlite3';
      this.db.prepare('VACUUM INTO ?').run(backup);
      chmodSync(backup, 0o600);
      const copy = new DatabaseSync(backup, { readOnly: true });
      try {
        if (
          copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
          copy.prepare("SELECT value FROM connector_meta WHERE key='binding'").get()?.value !==
            JSON.stringify(this.binding)
        )
          throw new Error('The original journal backup failed verification');
      } finally {
        copy.close();
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // A client-only tool can use this journal without a receiver lock.
        // Its last write must be in the backup too; otherwise retry with a new copy.
        if (this.db.prepare('PRAGMA data_version').get()?.data_version !== sourceVersion)
          throw new Error('The original journal changed during backup; retry migration');
        const required = [
          'connector_work',
          'connector_delivery',
          'connector_outgoing',
          'connector_control',
          'connector_order_request',
          'connector_relay',
        ];
        const tables = new Set(
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((row) => String(row.name)),
        );
        if (required.some((name) => !tables.has(name)) || tables.has('connector_task'))
          throw new Error('The original journal schema is incomplete');
        for (const row of this.db.prepare('SELECT id,value FROM connector_work').all())
          this.db
            .prepare('UPDATE connector_work SET value=? WHERE id=?')
            .run(migrateTaskRecord(String(row.value), String(row.id)), row.id);
        for (const row of this.db.prepare('SELECT id,value FROM connector_delivery').all()) {
          const converted = migrateDelivery(String(row.value), Number(row.id));
          this.db
            .prepare('UPDATE connector_delivery SET kind=?,value=? WHERE id=?')
            .run(converted.kind, converted.value, row.id);
        }
        for (const row of this.db.prepare('SELECT id,value FROM connector_relay').all())
          this.db
            .prepare('UPDATE connector_relay SET value=? WHERE id=?')
            .run(migrateRelay(String(row.value), String(row.id)), row.id);
        this.db.exec(
          'ALTER TABLE connector_work RENAME TO connector_task; ALTER TABLE connector_outgoing RENAME COLUMN work TO task; DROP INDEX connector_work_phase; CREATE INDEX connector_task_phase ON connector_task(phase,created);',
        );
        this.db.prepare("INSERT INTO connector_meta VALUES ('schema_version','2')").run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.releaseProcessLock();
    }
  }
  /** One receiver per journal; Linux kernel locks survive PID reuse safely. */
  acquireProcessLock(path: string): void {
    if (this.lock) throw new Error('Connector already owns a process lock');
    if (process.platform === 'linux') {
      this.acquireKernelLock(path);
      return;
    }
    if (existsSync(path)) {
      privateFile(path);
      const value = parseStored<{ pid: number; nonce: string }>(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid < 1)
        throw new Error('Inspect the original Connector lock');
      try {
        process.kill(value.pid, 0);
        throw new Error('Another Connector process is using this journal');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      unlinkSync(path);
    }
    const nonce = randomUUID(),
      fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }), { flush: true });
    } finally {
      closeSync(fd);
    }
    this.lock = { path, nonce };
  }
  private acquireKernelLock(path: string): void {
    const guard = `${path}.flock`;
    if (existsSync(guard)) privateFile(guard);
    const fd = openSync(guard, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      // The child inherits this open file description. Its exit keeps the lock
      // held by our descriptor; process death releases it even after SIGKILL.
      const result = spawnSync('flock', ['--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
      });
      if (result.status === 1) throw new Error('Another Connector process is using this journal');
      if (result.error || result.status !== 0)
        throw new Error(
          'Linux Connector locking requires util-linux flock and filesystem lock support',
        );
      if (existsSync(path)) {
        privateFile(path);
        const stored = readFileSync(path, 'utf8');
        const value = parseStored<{ pid: number; nonce: string; locking?: string }>(stored);
        if (value.locking !== 'flock') {
          // Do not steal a legacy PID lock during an upgrade. An operator must
          // confirm an orphaned container lock before moving it aside once.
          if (!Number.isSafeInteger(value.pid) || value.pid < 1)
            throw new Error('Inspect the original Connector lock');
          try {
            process.kill(value.pid, 0);
            throw new Error('Another Connector process is using this journal (legacy PID lock)');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        unlinkSync(path);
      }
      const nonce = randomUUID();
      // Exclusive creation also excludes a legacy receiver racing this upgrade.
      const metadata = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(metadata, JSON.stringify({ pid: process.pid, nonce, locking: 'flock' }), {
          flush: true,
        });
      } finally {
        closeSync(metadata);
      }
      this.lock = { path, nonce, fd };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  ingest(delivery: Delivery): void {
    const task = delivery.task;
    const incoming = ['task', 'input', 'cancel'].includes(delivery.kind);
    if (
      incoming
        ? task.target_agent_id !== this.binding.agentId ||
          task.connection_id !== this.binding.connectionId
        : task.caller_agent_id !== this.binding.agentId
    )
      throw new Error('Inbox delivery belongs to another Agent');
    const old = this.db.prepare('SELECT value FROM connector_delivery WHERE id=?').get(delivery.id);
    if (old) {
      const saved = parseStored<Delivery>(String(old.value));
      if (
        saved.kind !== delivery.kind ||
        saved.task.id !== task.id ||
        digest(saved.event) !== digest(delivery.event)
      )
        throw new Error('Delivery identity changed');
    }
    this.db
      .prepare(
        'INSERT INTO connector_delivery(id,kind,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(delivery.id, delivery.kind, JSON.stringify(delivery));
    if (delivery.kind === 'task') {
      const prior = this.get(task.id);
      if (
        prior &&
        digest([
          prior.task.target_agent_id,
          prior.task.connection_id,
          prior.task.context_id,
          prior.task.request,
        ]) !== digest([task.target_agent_id, task.connection_id, task.context_id, task.request])
      )
        throw new Error('Task request changed');
      if (!prior)
        this.save({
          task,
          deliveryId: delivery.id,
          phase: 'prepared',
          claimRequestId: randomUUID(),
        });
    }
  }
  save(record: LocalTask): void {
    this.db
      .prepare(
        'INSERT INTO connector_task VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,value=excluded.value',
      )
      .run(record.task.id, record.phase, JSON.stringify(record), Date.now());
  }
  get(id: string): LocalTask | undefined {
    const row = this.db.prepare('SELECT value FROM connector_task WHERE id=?').get(id);
    return row ? parseStored<LocalTask>(String(row.value)) : undefined;
  }
  pending(): LocalTask[] {
    return this.db
      .prepare("SELECT value FROM connector_task WHERE phase!='terminal' ORDER BY created,id")
      .all()
      .map((row) => parseStored<LocalTask>(String(row.value)));
  }
  deliveries(): Delivery[] {
    return this.db
      .prepare('SELECT value FROM connector_delivery WHERE acked=0 ORDER BY id')
      .all()
      .map((row) => parseStored<Delivery>(String(row.value)));
  }
  results(): Delivery[] {
    return this.db
      .prepare(
        "SELECT value FROM connector_delivery WHERE kind IN ('result','input_required') ORDER BY id DESC LIMIT 50",
      )
      .all()
      .map((row) => parseStored<Delivery>(String(row.value)));
  }
  acknowledge(id: number): void {
    this.db.prepare('UPDATE connector_delivery SET acked=1 WHERE id=?').run(id);
  }
  outgoing(requestId: string, request: unknown): Task | undefined {
    const encoded = JSON.stringify(request);
    const row = this.db
      .prepare('SELECT request,task FROM connector_outgoing WHERE id=?')
      .get(requestId);
    if (row) {
      if (row.request !== encoded)
        throw new Error('Request ID already belongs to another outgoing task');
      return row.task ? parseStored<Task>(String(row.task)) : undefined;
    }
    this.db
      .prepare('INSERT INTO connector_outgoing(id,request) VALUES (?,?)')
      .run(requestId, encoded);
    return undefined;
  }
  saveOutgoing(requestId: string, task: Task): void {
    this.db
      .prepare('UPDATE connector_outgoing SET task=? WHERE id=?')
      .run(JSON.stringify(task), requestId);
  }
  orderRequest(requestId: string, request: unknown): string | undefined {
    const encoded = JSON.stringify(request);
    const row = this.db
      .prepare('SELECT request,order_id FROM connector_order_request WHERE id=?')
      .get(requestId);
    if (row) {
      if (row.request !== encoded)
        throw new Error('Request ID already belongs to another original service quote');
      return row.order_id ? String(row.order_id) : undefined;
    }
    this.db
      .prepare('INSERT INTO connector_order_request(id,request) VALUES (?,?)')
      .run(requestId, encoded);
    return undefined;
  }
  saveOrderRequest(requestId: string, orderId: string): void {
    const row = this.db
      .prepare('SELECT order_id FROM connector_order_request WHERE id=?')
      .get(requestId);
    if (!row || (row.order_id && row.order_id !== orderId))
      throw new Error('Preserve the original service quote request');
    this.db
      .prepare('UPDATE connector_order_request SET order_id=? WHERE id=?')
      .run(orderId, requestId);
  }
  control(deliveryId: number): LocalControl {
    const row = this.db.prepare('SELECT value FROM connector_control WHERE id=?').get(deliveryId);
    if (row) return parseStored<LocalControl>(String(row.value));
    const created: LocalControl = { deliveryId, operationId: randomUUID(), phase: 'prepared' };
    this.saveControl(created);
    return created;
  }
  saveControl(control: LocalControl): void {
    this.db
      .prepare(
        'INSERT INTO connector_control VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(control.deliveryId, JSON.stringify(control));
  }
  queueReport(
    record: LocalTask,
    kind: Report['kind'],
    text: string,
    afterReport: Phase,
    observation?: unknown,
    eventId: string = randomUUID(),
  ): void {
    if (!record.claim || record.pendingReport)
      throw new Error('Preserve the pending report before queuing another');
    record.pendingReport = {
      claim: { id: record.claim.id, fence: record.claim.fence },
      event_id: eventId,
      kind,
      text,
    };
    record.afterReport = afterReport;
    record.phase = 'report_pending';
    record.lastObservation = observation === undefined ? undefined : digest(observation);
    this.save(record);
  }
  sameObservation(record: LocalTask, observation: unknown): boolean {
    return record.lastObservation === digest(observation);
  }
  ingestRelay(value: RelayCommand): RelayRecord {
    const command = relayCommand(value);
    if (command.connection_id !== this.binding.connectionId)
      throw new Error('Relay belongs to another original connection');
    const prior = this.getRelay(command.command_id);
    if (prior) {
      if (
        prior.command.request_digest !== command.request_digest ||
        prior.command.binding_id !== command.binding_id
      )
        throw new Error('The original relay command changed');
      return prior;
    }
    if (command.claim || !['pending', 'canceled'].includes(command.state))
      throw new Error('Restore the original relay journal before recovering an admitted command');
    const created: RelayRecord = {
      command,
      phase: command.state === 'canceled' ? 'events_acked' : 'received',
      claimRequestId: randomUUID(),
      executionKey: command.command_id,
      nextEvent: 1,
      nextObservation: 1,
      pending: [],
    };
    this.saveRelay(created);
    return created;
  }
  getRelay(id: string): RelayRecord | undefined {
    const row = this.db.prepare('SELECT value FROM connector_relay WHERE id=?').get(id);
    return row ? parseStored<RelayRecord>(String(row.value)) : undefined;
  }
  saveRelay(record: RelayRecord): void {
    this.db
      .prepare(
        'INSERT INTO connector_relay VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,value=excluded.value',
      )
      .run(record.command.command_id, record.phase, JSON.stringify(record), Date.now());
  }
  pendingRelay(): RelayRecord[] {
    return this.db
      .prepare("SELECT value FROM connector_relay WHERE phase!='events_acked' ORDER BY created")
      .all()
      .map((row) => parseStored<RelayRecord>(String(row.value)));
  }
  private releaseProcessLock(): void {
    try {
      if (this.lock && existsSync(this.lock.path)) {
        privateFile(this.lock.path);
        const value = parseStored<{ pid: number; nonce: string }>(
          readFileSync(this.lock.path, 'utf8'),
        );
        if (value.nonce === this.lock.nonce) unlinkSync(this.lock.path);
      }
    } finally {
      // The guard inode stays in place while the kernel releases its lock.
      if (this.lock?.fd !== undefined) closeSync(this.lock.fd);
      this.lock = undefined;
    }
  }
  close(): void {
    try {
      this.db.close();
    } finally {
      this.releaseProcessLock();
    }
  }
}
