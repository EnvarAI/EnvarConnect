/** The relay envelope carries standard A2A 1.0; it is not another agent protocol. */
import { digest } from '../shared/json.js';

export interface RelayClaim { id: string; fence: number; }
export interface RelayReference { origin: string; interface: string; task_id: string; context_id: string; }
export interface RelayCommand {
  relay_version: '1'; command_id: string; connection_id: string; binding_id: string; work_id: string;
  sequence: number; kind: 'send' | 'input' | 'cancel' | 'get'; request_digest: string; control_generation: number;
  a2a: { method: string; params: Record<string, unknown> }; state: string;
  last_event_sequence: number; lease_until: string | null; result_digest: string;
  claim: RelayClaim | null; admission_ref: string | null;
  native_reference?: RelayReference | null;
  last_observation_sequence?: number;
}
export interface RelayEvent {
  claim: RelayClaim; event_id: string; sequence: number; control_generation: number;
  observation_seq?: number; kind: 'native_reference' | 'task_snapshot' | 'delivery_receipt' | 'outcome_unknown';
  payload: Record<string, unknown>; payload_digest: string;
}
export interface RelayRecord {
  command: RelayCommand;
  phase: 'received' | 'intent_persisted' | 'admitted' | 'dispatch_started' | 'native_ref_saved' | 'observing' | 'outcome_unknown' | 'terminal_saved' | 'events_acked';
  claimRequestId: string; executionKey: string; reference?: RelayReference;
  nextEvent: number; nextObservation: number; pending: RelayEvent[];
  result?: { task?: Record<string, unknown>; message?: Record<string, unknown> };
  finalDigest?: string; acknowledgedSequence?: number;
  finalReadPending?: boolean;
  rejectedEvents?: RelayEvent[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function relayCommand(value: unknown): RelayCommand {
  const command = value as RelayCommand;
  if (!command || command.relay_version !== '1' ||
      ![command.command_id, command.connection_id, command.binding_id, command.work_id].every(id => typeof id === 'string' && uuid.test(id)) ||
      !Number.isSafeInteger(command.sequence) || command.sequence < 1 ||
      !Number.isSafeInteger(command.control_generation) || command.control_generation < 0 ||
      !Number.isSafeInteger(command.last_event_sequence) || command.last_event_sequence < 0 ||
      !['pending', 'claimed', 'admitted', 'observing', 'completed', 'unknown', 'canceled'].includes(command.state) ||
      !command.a2a || typeof command.a2a.params !== 'object' || command.a2a.params === null ||
      ({send: 'SendMessage', input: 'SendMessage', cancel: 'CancelTask', get: 'GetTask'})[command.kind] !== command.a2a.method ||
      digest({kind: command.kind, method: command.a2a.method, params: command.a2a.params, binding: command.binding_id}) !== command.request_digest)
    throw new Error('Invalid original A2A relay command');
  if (command.claim && (!uuid.test(command.claim.id) || !Number.isSafeInteger(command.claim.fence) || command.claim.fence < 1))
    throw new Error('Invalid original relay claim');
  return command;
}
