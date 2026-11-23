import { join } from 'node:path';
import { privateJson, privateText } from './files.js';
import { platformOrigin } from './pairing.js';
import { EnvarWorkClient } from './client.js';
import { ConnectorJournal, type ConnectorBinding } from './state.js';
import { HermesRuntimeAdapter } from '../adapters/hermes.js';
import { OpenClawRuntimeAdapter } from '../adapters/openclaw.js';
import { CliRuntimeAdapter, type CliExecutionConfig } from '../adapters/cli-runtime.js';

export type RuntimeKind = 'hermes' | 'openclaw' | 'codex' | 'claude-code' | 'generic-client';

export interface ConnectorConfig {
  version: 1 | 2; origin: string; agentId: string; connectionId: string; framework: RuntimeKind;
  scopes: string[]; expiresAt: string; allowLocalHttp?: boolean; nativeConfigured: boolean; disabled?: boolean;
  runtime: { home: string; configFile?: string; port?: number; agentId: string; cardUrl: string; binary: string[]; peerName: string; mcpName: string };
  journalCardUrl?: string;
  onboardingSession?: string; bindingDigest?: string; execution?: CliExecutionConfig;
}
export interface NormalizedConnectorConfig {
  journal: ConnectorBinding;
  receiver: { kind: 'client' }
    | { kind: 'native-a2a'; adapter: 'hermes' | 'openclaw'; cardUrl: string }
    | { kind: 'cli'; adapter: 'codex' | 'claude-code'; execution?: CliExecutionConfig };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { connectorDirectory } from './paths.js';
export function readConnector(directory: string): ConnectorConfig {
  const config = privateJson<ConnectorConfig>(join(directory, 'connector.json'));
  normalizeConnector(config);
  return config;
}
/** Normalize historical files in memory; never rewrite their credential or journal identity. */
export function normalizeConnector(config: ConnectorConfig): NormalizedConnectorConfig {
  if (![1,2].includes(config.version) || !uuid.test(config.agentId) || !uuid.test(config.connectionId) ||
    !['hermes','openclaw','codex','claude-code','generic-client'].includes(config.framework) || !Array.isArray(config.scopes) || !config.runtime?.cardUrl ||
    config.runtime.peerName !== 'envar-' + config.agentId || config.runtime.mcpName !== 'envar-' + config.agentId)
    throw new Error('Invalid Connector configuration');
  platformOrigin(config.origin, config.allowLocalHttp);
  if (config.disabled) throw new Error('This Connector is disconnected; approve a fresh connection in Envar');
  const journal = { origin: config.origin, agentId: config.agentId, connectionId: config.connectionId,
    adapter: config.framework, cardUrl: config.journalCardUrl ?? config.runtime.cardUrl };
  if (!config.scopes.includes('work:receive') || config.framework === 'generic-client') return { journal, receiver: { kind:'client' } };
  if (config.framework === 'codex' || config.framework === 'claude-code')
    return { journal, receiver: { kind:'cli', adapter:config.framework, execution:config.execution } };
  return { journal, receiver: { kind:'native-a2a', adapter:config.framework, cardUrl:config.runtime.cardUrl } };
}
export function connectorClient(directory: string, config = readConnector(directory)) {
  return new EnvarWorkClient(config.origin, privateText(join(directory, `credential-${config.connectionId}.txt`)).trim(),
    { allowLocalHttp: config.allowLocalHttp });
}
export function connectorJournal(directory: string, config = readConnector(directory)) {
  return new ConnectorJournal(join(directory, `journal-${config.connectionId}.sqlite3`), normalizeConnector(config).journal);
}
export function runtimeAdapter(directory: string, config = readConnector(directory)) {
  const { receiver } = normalizeConnector(config);
  if (receiver.kind === 'client') throw new Error('This connection uses services only. Receiving requires an approved execution adapter.');
  if (receiver.kind === 'cli') {
    if (!receiver.execution) throw new Error('Choose an approved execution workspace before receiving.');
    return new CliRuntimeAdapter(directory, receiver.adapter, receiver.execution);
  }
  const settings = { cardUrl: receiver.cardUrl, token: privateText(join(directory, 'native.token')).trim() };
  return receiver.adapter === 'hermes' ? new HermesRuntimeAdapter(settings) : new OpenClawRuntimeAdapter(settings);
}
