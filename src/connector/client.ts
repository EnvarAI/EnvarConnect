/** Scoped application operations over the sole Connect WebSocket transport. */
import { SocketTransport } from './transport.js';
export { TaskApiError } from './transport.js';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { Claim, ConfirmOrderResult, ExecutionRef, Inbox, Order, Report, ServiceConfirmation, ServiceQuoteRequest, Submit, Task } from './contracts.generated.js';
import { digest } from '../shared/json.js';
import type { RuntimeReadiness } from '../adapters/types.js';
import { runtimeReport } from './runtime-report.js';
import { relayCommand, type RelayCommand, type RelayEvent } from './relay-types.js';

const ajv = new Ajv2020({ allErrors: false, strict: true });
(addFormatsImport as unknown as (value: Ajv2020) => void)(ajv);
const schema = JSON.parse(readFileSync(new URL('../../contracts/agent-task/v2/schema.json', import.meta.url), 'utf8'));
ajv.addSchema(schema);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string): string {
  if (!uuid.test(value)) throw new Error('Use an Envar UUID');
  return value;
}
export function validate<T>(kind: string, value: unknown): T {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${kind}`);
  if (!validator || !validator(value)) throw new Error(`Invalid Agent Task ${kind} document`);
  return value as T;
}
export interface ClaimedTask extends Task {
  claim?: Claim & { lease_until: string | null };
  execution_ref: Partial<ExecutionRef>;
  replayed?: boolean;
}
export interface ConnectionStatus {
  id: string;
  agent_id: string;
  mode: 'inbox' | 'direct';
  status: 'active' | 'revoked';
  adapter: string;
  revision: number;
  readiness: Record<string, unknown>;
  protocol_support?: { a2a_relay_v1?: boolean; a2a_relay_v2?: boolean };
}
export class EnvarTaskClient {
  readonly origin: string;
  readonly transport: SocketTransport;
  private readonly invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  constructor(origin: string, token: string, options: { rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>; allowLocalHttp?: boolean } = {}) {
    const url = new URL(origin);
    const local = options.allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Choose the Envar HTTPS origin');
    if (!/^envar_agent_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Use a scoped Envar connection credential');
    this.origin = url.origin;
    this.transport = new SocketTransport(this.origin, token);
    this.invoke = options.rpc ?? ((method, params) => this.transport.call(method, params));
  }
  private rpc(method: string, params: Record<string, unknown> = {}) { return this.invoke(method, params); }
  close() { this.transport.close(); }
  get generation() { return this.transport.generation; }
  subscribeReceiver() { return this.transport.subscribeReceiver(); }
  waitForChange(after: number, signal?: AbortSignal, milliseconds?: number) { return this.transport.wait(after, signal, milliseconds); }
  async waitResult<T>(read: () => Promise<T>, terminal: (value: T) => boolean, seconds: number, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      if (signal?.aborted) throw new Error('Wait canceled; the original task is unchanged');
      const after = this.generation, value = await read();
      if (terminal(value) || Date.now() >= deadline) return value;
      await this.waitForChange(after, signal, deadline - Date.now());
    }
  }
  async disconnect(): Promise<{ credential_revoked: boolean; connection_revoked: boolean }> {
    return await this.rpc('disconnect') as { credential_revoked: boolean; connection_revoked: boolean };
  }
  async checkOnboarding(sessionId: string, start = false): Promise<Record<string, unknown>> {
    return await this.rpc(start ? 'start_check' : 'get_check', start ? {} : { session_id: id(sessionId) }) as Record<string, unknown>;
  }

  async relayHello(cardDigest: string, version: '1'|'2' = '1'): Promise<boolean> {
    const value = await this.rpc('relay_hello', {
      relay_version: version, a2a_wire_version: '1.0', runtime_card_digest: cardDigest,
      capabilities: { get: true, input: false, cancel: false, artifacts: false, streaming: false,
        task_lookup_after_restart: false, execution_key_lookup: false }, max_concurrency: 1,
    }) as { relay_version?: string };
    if (value.relay_version !== version) throw new Error('Unsupported relay handshake');
    return true;
  }
  async relayCommands(): Promise<RelayCommand[]> {
    const result = await this.rpc('list_relay_commands') as { items: unknown[] };
    if (!Array.isArray(result?.items) || result.items.length > 20) throw new Error('Invalid relay command page');
    return result.items.map(relayCommand);
  }
  async relayCommand(commandId: string): Promise<RelayCommand> {
    const result = relayCommand(await this.rpc('get_relay_command', { command_id: id(commandId) }));
    if (result.command_id !== commandId) throw new Error('Envar returned another original relay command');
    return result;
  }
  async relayOperation(commandId: string, operation: 'claim' | 'admit' | 'lease' | 'recover', body: unknown): Promise<RelayCommand> {
    const result = relayCommand(await this.rpc('relay_' + operation, { command_id: id(commandId), body }));
    if (result.command_id !== commandId) throw new Error('Envar returned another original relay command');
    return result;
  }
  async relayEvent(commandId: string, event: RelayEvent): Promise<{ result_digest: string; state: string }> {
    const result = await this.rpc('relay_events', { command_id: id(commandId), body: event }) as { event_id: string; last_committed_sequence: number; result_digest: string; state: string };
    if (result.event_id !== event.event_id || result.last_committed_sequence < event.sequence) throw new Error('Relay did not persist the original event');
    return result;
  }
  async relayAck(commandId: string, body: unknown): Promise<void> {
    const result = await this.rpc('relay_ack', { command_id: id(commandId), body }) as { command_id: string; acknowledged: boolean };
    if (result.command_id !== commandId || result.acknowledged !== true) throw new Error('Relay did not acknowledge the original result');
  }
  async status(): Promise<ConnectionStatus> {
    const value = await this.rpc('get_connection') as ConnectionStatus;
    if (!value || !uuid.test(value.id) || !uuid.test(value.agent_id) || value.mode !== 'inbox' || value.status !== 'active' || typeof value.adapter !== 'string')
      throw new Error('Reconnect this Agent to an active inbox');
    return value;
  }
  async reportRuntime(runtime: RuntimeReadiness): Promise<'accepted'> {
    await this.rpc('report_runtime', runtimeReport(runtime));
    return 'accepted';
  }
  async peers(): Promise<{ items: { agent_id: string; connection_id: string; display_name: string; adapter: string }[] }> {
    const value = await this.rpc('list_peers') as { items: { agent_id: string; connection_id: string; display_name: string; adapter: string }[] };
    if (!value || !Array.isArray(value.items) || value.items.length > 100 || value.items.some(item =>
      !uuid.test(item.agent_id) || !uuid.test(item.connection_id) || typeof item.display_name !== 'string' || typeof item.adapter !== 'string'))
      throw new Error('Invalid allowed-peer directory');
    return value;
  }
  async provideInput(taskId: string, text: string, requestId: string): Promise<Task> {
    return validate('task', await this.rpc('provide_input', { task_id: id(taskId), text, request_id: id(requestId) }));
  }
  async cancel(taskId: string, requestId: string): Promise<Task> {
    return validate('task', await this.rpc('cancel_task', { task_id: id(taskId), request_id: id(requestId) }));
  }
  async inbox(after = 0): Promise<Inbox> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid inbox cursor');
    return validate('inbox', await this.rpc('list_inbox', { after }));
  }
  async get(taskId: string): Promise<Task> { return validate('task', await this.rpc('get_task', { task_id: id(taskId) })); }
  async send(request: Submit, requestId: string): Promise<Task> {
    validate('submit', request);
    const { replayed: _, ...task } = await this.rpc('send_message', { ...request, request_id: id(requestId) }) as Record<string, unknown>;
    return validate('task', task);
  }
  private async claimed(method: string, params: Record<string, unknown>): Promise<ClaimedTask> {
    const result = await this.rpc(method, params) as ClaimedTask;
    const { claim, execution_ref, replayed, ...task } = result;
    validate('task', task);
    if (method === 'claim_task' && ['completed', 'failed', 'canceled'].includes(task.status) && !uuid.test(claim?.id ?? ''))
      return { ...task, execution_ref, ...(replayed === undefined ? {} : { replayed }) };
    if (!claim) throw new Error('The active original task has no claim');
    validate('claim', { id: claim.id, fence: claim.fence });
    return { ...task, claim, execution_ref, ...(replayed === undefined ? {} : { replayed }) };
  }
  claim(taskId: string, requestId: string): Promise<ClaimedTask> {
    return this.claimed('claim_task', { task_id: id(taskId), request_id: id(requestId) });
  }
  start(taskId: string, claim: Claim, execution_ref: ExecutionRef): Promise<ClaimedTask> {
    return this.claimed('start_task', { task_id: id(taskId), claim, execution_ref });
  }
  renew(taskId: string, claim: Claim): Promise<ClaimedTask> {
    return this.claimed('renew_task', { task_id: id(taskId), claim });
  }
  recover(taskId: string, claim: Claim, execution_ref: ExecutionRef): Promise<ClaimedTask> {
    return this.claimed('recover_task', { task_id: id(taskId), claim, execution_ref });
  }
  async report(taskId: string, report: Report): Promise<Task> {
    validate('report', report);
    const methods = { progress: 'report_progress', input_required: 'request_input', completed: 'complete_task', failed: 'fail_task', outcome_unknown: 'mark_outcome_unknown', cancel_confirmed: 'confirm_cancellation' };
    const { kind, ...params } = report;
    return validate('task', await this.rpc(methods[kind], { task_id: id(taskId), ...params }));
  }
  async acknowledge(deliveryId: number): Promise<void> {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new Error('Invalid delivery ID');
    await this.rpc('acknowledge_result', { delivery_id: deliveryId });
  }
  async services(query = '', serviceId?: string): Promise<{ results: Record<string, unknown>[] }> {
    if (query.length > 120) throw new Error('Use a bounded service query');
    const value = await this.rpc('list_services', { query, ...(serviceId ? { service_id: id(serviceId) } : {}) }) as { results: Record<string, unknown>[] };
    if (!Array.isArray(value?.results) || value.results.length > 100) throw new Error('Invalid service directory');
    return value;
  }
  async spendingGrants(): Promise<{ items: Record<string, unknown>[] }> {
    const value = await this.rpc('list_spending_grants') as { items: Record<string, unknown>[] };
    if (!Array.isArray(value?.items) || value.items.length > 100) throw new Error('Invalid Agent budget response');
    return value;
  }
  async quoteService(request: ServiceQuoteRequest): Promise<Order> {
    validate('service_quote_request', request);
    const { message_id, ...terms } = request;
    const order = validate<Order>('order', await this.rpc('quote_service', { ...terms, request_id: id(message_id) }));
    if (order.service_id !== request.service_id || order.message_id !== request.message_id || order.offer_id !== request.offer_id ||
      order.payment_method !== request.payment_method || order.quote.input_digest !== digest(request.input))
      throw new Error('The service quote differs from the original request');
    return order;
  }
  async order(orderId: string): Promise<Order> {
    const order = validate<Order>('order', await this.rpc('get_order', { order_id: id(orderId) }));
    if (order.id !== orderId) throw new Error('Envar returned a different original order');
    return order;
  }
  async orders(): Promise<{ items: Order[] }> {
    const value = await this.rpc('list_orders') as { items: unknown[] };
    if (!Array.isArray(value?.items) || value.items.length > 100) throw new Error('Invalid original-order list');
    return { items: value.items.map(item => validate<Order>('order', item)) };
  }
  async confirmOrder(orderId: string, confirmation: ServiceConfirmation): Promise<ConfirmOrderResult> {
    validate('service_confirmation', confirmation);
    const receipt = validate<ConfirmOrderResult>('confirm_order_result', await this.rpc('confirm_order', { order_id: id(orderId), ...confirmation }));
    if (receipt.order.id !== orderId || receipt.order.message_id !== confirmation.message_id)
      throw new Error('Confirmation returned another order');
    if (receipt.approval_required) {
      const approval = new URL(receipt.approval_url ?? '');
      if (approval.origin !== this.origin || approval.pathname !== `/console/orders/${orderId}` ||
          approval.username || approval.password || approval.search || approval.hash)
        throw new Error('Owner approval must remain on the original Envar order');
    }
    return receipt;
  }
  async recoverOrder(orderId: string): Promise<Order> {
    const order = validate<Order>('order', await this.rpc('recover_order', { order_id: id(orderId) }));
    if (order.id !== orderId) throw new Error('Recovery returned another order');
    return order;
  }
}
