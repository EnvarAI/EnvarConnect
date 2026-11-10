import { randomUUID } from 'node:crypto';
import type { RelayRuntime } from '../adapters/types.js';
import { digest } from '../shared/json.js';
import { EnvarWorkClient, WorkApiError } from './client.js';
import type { ConnectorJournal } from './state.js';
import type { RelayEvent, RelayRecord } from './relay-types.js';

const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const taskState = (task: Record<string, unknown>) => String((task.status as { state?: string })?.state);
export const relayBlocksDispatch = (record: RelayRecord): boolean =>
  !['received', 'events_acked'].includes(record.phase) &&
  !(record.phase === 'terminal_saved' && !record.pending.length && record.command.state === 'completed' && Boolean(record.finalDigest));

/** Uses the existing journal and process lock; unknown sends never get another POST. */
export class RelayLoop {
  private lastHello = 0;
  private enabled = false;
  constructor(readonly client: EnvarWorkClient, readonly runtime: RelayRuntime, readonly journal: ConnectorJournal) {}
  private queue(record: RelayRecord, kind: RelayEvent['kind'], payload: Record<string, unknown>, observation?: number): void {
    if (!record.command.claim) throw new Error('The original relay claim is required');
    record.pending.push({ claim: record.command.claim, event_id: randomUUID(), sequence: record.nextEvent++,
      control_generation: record.command.control_generation, kind, payload, payload_digest: digest(payload),
      ...(observation === undefined ? {} : { observation_seq: observation }) });
    this.journal.saveRelay(record);
  }
  private async lease(record: RelayRecord): Promise<void> {
    const current = await this.client.relayCommand(record.command.command_id);
    if (current.request_digest !== record.command.request_digest || current.claim?.id !== record.command.claim?.id || current.claim?.fence !== record.command.claim?.fence)
      throw new Error('The original relay execution fence changed');
    if (record.reference && current.native_reference && digest(record.reference) !== digest(current.native_reference))
      throw new Error('The platform returned another original native reference');
    const command = await this.client.relayOperation(record.command.command_id, 'recover', {
      claim: record.command.claim, execution_key: record.executionKey, journal_phase: record.phase,
      last_event_sequence: Math.max(record.nextEvent - 1, current.last_event_sequence),
    });
    if (command.request_digest !== record.command.request_digest || command.claim?.id !== record.command.claim?.id || command.claim?.fence !== record.command.claim?.fence)
      throw new Error('The original relay execution fence changed');
    record.command = command;
    record.nextEvent = Math.max(record.nextEvent, command.last_event_sequence + 1);
    record.nextObservation = Math.max(record.nextObservation, (command.last_observation_sequence ?? 0) + 1);
    this.journal.saveRelay(record);
  }
  private async heartbeat<T>(record: RelayRecord, operation: () => Promise<T>): Promise<T> {
    let active: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!active) active = this.lease(record).catch(() => {
        // The native result is still preserved; flush revalidates the original authority.
      }).finally(() => { active = undefined; });
    }, 40000);
    try { return await operation(); } finally { clearInterval(timer); await active; }
  }
  private async flush(record: RelayRecord): Promise<void> {
    if (!record.pending.length) return;
    await this.lease(record);
    while (record.pending.length) {
      const event = record.pending[0]!;
      let receipt;
      try { receipt = await this.client.relayEvent(record.command.command_id, event); }
      catch (error) {
        if (!(error instanceof WorkApiError) || ![400, 413].includes(error.status) || event.kind === 'outcome_unknown') throw error;
        // A confirmed schema/size rejection did not commit this event. Keep
        // the rejected payload locally and report a bounded uncertainty at
        // the same sequence so original Task reads can continue.
        record.rejectedEvents ??= [];
        if (!record.rejectedEvents.some(item => item.payload_digest === event.payload_digest))
          record.rejectedEvents = [...record.rejectedEvents.slice(-19), event];
        const payload = { reason: 'receipt_incomplete' };
        record.pending = [{ claim: event.claim, event_id: randomUUID(), sequence: event.sequence,
          control_generation: event.control_generation, kind: 'outcome_unknown', payload, payload_digest: digest(payload) }];
        record.nextEvent = event.sequence + 1;
        record.phase = 'outcome_unknown'; record.finalReadPending = false;
        this.journal.saveRelay(record); continue;
      }
      record.pending.shift();
      if (receipt.result_digest) record.finalDigest = receipt.result_digest;
      if (receipt.state) record.command.state = receipt.state;
      if (receipt.state === 'unknown' && record.phase === 'terminal_saved') record.phase = 'outcome_unknown';
      this.journal.saveRelay(record);
    }
  }
  private async acknowledge(record: RelayRecord): Promise<void> {
    if (!record.finalDigest || record.pending.length || !['terminal_saved', 'outcome_unknown'].includes(record.phase)) return;
    if (record.finalReadPending && record.reference) {
      await this.lease(record);
      const observation = record.nextObservation++; this.journal.saveRelay(record);
      let original: Record<string, unknown> | undefined;
      try { original = await this.heartbeat(record, () => this.runtime.read(record.reference!)); }
      catch { /* Retry this original verification read; do not repeat its send. */ }
      if (original) {
        // The obligation and its evidence share one durable journal write.
        record.finalReadPending = false;
        this.queue(record, 'task_snapshot', original, observation);
        await this.flush(record);
      }
    }
    const sequence = record.nextEvent - 1;
    if (record.acknowledgedSequence === sequence) return;
    await this.client.relayAck(record.command.command_id, { claim: record.command.claim, last_event_sequence: sequence, result_digest: record.finalDigest });
    record.acknowledgedSequence = sequence;
    if (record.phase === 'terminal_saved' && !record.finalReadPending) record.phase = 'events_acked';
    this.journal.saveRelay(record);
  }
  private async observed(record: RelayRecord, result: Awaited<ReturnType<RelayRuntime['send']>>, observation: number): Promise<void> {
    if (result.reference) {
      if (record.reference && digest(record.reference) !== digest(result.reference)) throw new Error('Native reference changed');
      if (!record.reference) {
        record.reference = result.reference;
        this.queue(record, 'native_reference', { ...result.reference });
      }
    }
    record.result = result.task ? { task: result.task } : { message: result.message! };
    record.phase = 'native_ref_saved'; this.journal.saveRelay(record);
    if (result.task) {
      if (!record.reference || result.task.id !== record.reference.task_id || result.task.contextId !== record.reference.context_id)
        throw new Error('Native response does not belong to the original Task and context');
      this.queue(record, 'task_snapshot', result.task, observation);
      record.phase = terminal.has(taskState(result.task)) ? 'terminal_saved' : 'observing';
    } else if (result.message) {
      this.queue(record, 'delivery_receipt', { message: result.message }, observation);
      record.phase = 'terminal_saved';
    } else throw new Error('Native response contains no original Task or Message');
    this.journal.saveRelay(record);
    await this.flush(record);
  }
  private async unknown(record: RelayRecord, reason: string): Promise<void> {
    if (record.phase !== 'outcome_unknown') {
      record.phase = 'outcome_unknown';
      this.queue(record, 'outcome_unknown', { reason });
    }
    await this.flush(record); await this.acknowledge(record);
  }
  private async claim(record: RelayRecord): Promise<boolean> {
    try { record.command = await this.client.relayOperation(record.command.command_id, 'claim', { request_id: record.claimRequestId }); }
    catch (error) {
      if (!(error instanceof WorkApiError) || error.status !== 409) throw error;
      const current = await this.client.relayCommand(record.command.command_id);
      if (current.request_digest !== record.command.request_digest) throw new Error('The original relay command changed');
      if (current.state !== 'canceled') throw error;
      record.phase = 'events_acked'; this.journal.saveRelay(record); return false;
    }
    return true;
  }
  private adoptOriginal(record: RelayRecord): void {
    if (record.command.native_reference) record.reference = record.command.native_reference;
    record.finalDigest = record.command.result_digest || record.finalDigest;
    record.phase = record.command.state === 'canceled' ? 'events_acked'
      : record.command.state === 'completed' ? 'terminal_saved'
      : record.reference ? 'observing' : 'outcome_unknown';
    // A stale local checkpoint cannot prove that the original lookup evidence
    // was durably reported. Another GET is safe; another SendMessage is not.
    if (record.reference && (record.phase === 'terminal_saved' || !record.command.last_observation_sequence))
      record.finalReadPending = true;
    this.journal.saveRelay(record);
  }
  private async advance(record: RelayRecord): Promise<void> {
    let preparedDispatch: (() => ReturnType<RelayRuntime['send']>) | undefined;
    if (record.command.kind !== 'send') throw new Error('This Connector cannot execute unverified native controls');
    if (record.pending.length) { await this.flush(record); await this.acknowledge(record); return; }
    if (record.phase === 'terminal_saved') { await this.acknowledge(record); return; }
    if (record.phase === 'outcome_unknown') await this.acknowledge(record);
    if (record.phase === 'received') {
      if (!await this.claim(record)) return;
      record.phase = 'intent_persisted'; this.journal.saveRelay(record);
    }
    if (record.phase === 'intent_persisted') {
      // Check the native Card before the first financial admission. This GET
      // is safely repeatable and has not started an Agent task.
      preparedDispatch = this.runtime.prepareSend ? await this.runtime.prepareSend(record.command.a2a.params) : undefined;
      try {
        record.command = await this.client.relayOperation(record.command.command_id, 'admit', { claim: record.command.claim, execution_key: record.executionKey });
      } catch (error) {
        if (!(error instanceof WorkApiError) || error.status !== 409) throw error;
        // Admission may have succeeded before its response was lost. Recover
        // that exact execution; a changed key/fence cannot be substituted.
        try { await this.lease(record); }
        catch (recoveryError) {
          if (!(recoveryError instanceof WorkApiError) || recoveryError.status !== 409) throw recoveryError;
          // A pre-admission lease may expire. The server permits a new fence
          // only while this same command has never crossed admission.
          record.claimRequestId = randomUUID(); this.journal.saveRelay(record);
          if (!await this.claim(record)) return;
          this.journal.saveRelay(record); return;
        }
      }
      record.phase = 'admitted'; this.journal.saveRelay(record);
    }
    if (record.phase === 'admitted') {
      await this.lease(record);
      // The platform may already know a result beyond this local checkpoint.
      // Adopt only its original reference/receipt; never replay a known dispatch.
      // Restored backups may predate the durable dispatch marker. An expired
      // admission with no native evidence cannot prove that no POST occurred.
      // Report and acknowledge uncertainty without making another send.
      if (record.command.state === 'unknown' && !record.command.native_reference && !record.command.result_digest) {
        await this.unknown(record, 'dispatch_uncertain'); return;
      }
      if (record.command.native_reference || record.command.state !== 'admitted') {
        this.adoptOriginal(record); await this.acknowledge(record); return;
      }
      const dispatch = preparedDispatch ?? (this.runtime.prepareSend ? await this.heartbeat(record, () => this.runtime.prepareSend!(record.command.a2a.params))
        : () => this.runtime.send(record.command.a2a.params));
      await this.lease(record);
      record.phase = 'dispatch_started'; const observation = record.nextObservation++;
      this.journal.saveRelay(record); // FULL synchronous SQLite commit precedes POST.
      let result: Awaited<ReturnType<RelayRuntime['send']>>;
      try { result = await this.heartbeat(record, dispatch); }
      catch { await this.unknown(record, 'dispatch_uncertain'); return; }
      // Even an immediately terminal Task gets one original GetTask readback.
      // This also supplies the explicit native lookup evidence for enrollment.
      record.finalReadPending = Boolean(result.task && terminal.has(taskState(result.task)));
      await this.observed(record, result, observation);
      await this.acknowledge(record);
      return;
    }
    if (record.phase === 'dispatch_started' && !record.reference && !record.result) {
      await this.lease(record);
      if (record.command.native_reference || record.command.result_digest || record.command.state === 'canceled') {
        this.adoptOriginal(record); await this.acknowledge(record); return;
      }
      await this.unknown(record, 'dispatch_uncertain'); return;
    }
    if (record.phase === 'native_ref_saved' && record.result) {
      await this.observed(record, { ...record.result, ...(record.reference ? { reference: record.reference } : {}) }, record.nextObservation - 1);
      return;
    }
    if (record.reference) {
      await this.lease(record);
      const observation = record.nextObservation++; this.journal.saveRelay(record);
      let task: Record<string, unknown>;
      try { task = await this.heartbeat(record, () => this.runtime.read(record.reference!)); }
      catch { await this.unknown(record, 'native_task_unavailable'); return; }
      await this.observed(record, { task, reference: record.reference }, observation);
      await this.acknowledge(record);
    }
  }
  async tick(allowNew: boolean): Promise<void> {
    let handshakeError: unknown;
    if (Date.now() - this.lastHello > 20000) {
      try { this.enabled = await this.client.relayHello(await this.runtime.cardDigest()); }
      catch (error) {
        if (error instanceof WorkApiError && [401, 403].includes(error.status)) throw error;
        this.enabled = false; handshakeError = error;
      }
      this.lastHello = Date.now();
    }
    if (this.enabled) for (const command of await this.client.relayCommands()) this.journal.ingestRelay(command);
    for (const record of this.journal.pendingRelay().filter(value => value.phase !== 'received')) await this.advance(record);
    if (allowNew && !this.journal.pendingRelay().some(relayBlocksDispatch)) {
      const next = this.journal.pendingRelay().find(value => value.phase === 'received');
      if (next && this.enabled) await this.advance(next);
    }
    if (handshakeError) throw handshakeError;
  }
}
