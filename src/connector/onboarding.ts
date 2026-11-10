/** Device-first enrollment; only approval instructions, never tokens, reach stdout. */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { privateDirectory, privateJson, privateText, writePrivate, writePrivateJson } from './files.js';
import { platformOrigin } from './pairing.js';
import { digest } from '../shared/json.js';
import { inspectNative, configureNative } from '../adapters/configure-native.js';
import { inspectCli, type CliExecutionConfig } from '../adapters/cli-runtime.js';
import { createCodexServiceProfile } from '../adapters/codex-profile.js';
import { connectorClient, connectorDirectory, type ConnectorConfig, type RuntimeKind } from './config.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface OnboardingOptions {
  origin: string; runtime: RuntimeKind; receive: boolean; home?: string; nativeAgent?: string;
  workspace?: string; profile?: string; allowLocalHttp?: boolean; configurationApproved?: boolean; fresh?: boolean;
  stateRoot?: string; fetch?: typeof fetch; signal?: AbortSignal; poll?: () => Promise<void>;
  output: (value: Record<string, unknown>) => void;
}
interface Pending {
  request_id: string; secret: string; binding: string; origin: string; runtime: RuntimeKind; receive: boolean;
  receipt?: { session_id: string; user_code: string; verification_uri: string; expires_at: string; interval: number };
  directory?: string; testApproved?: boolean; restartRequired?: boolean;
}
interface Receipt {
  version: 2; session_id: string; agent_id: string; connection_id: string; runtime: RuntimeKind;
  binding_digest: string; platform_origin: string; token: string; scopes: string[]; expires_at: string;
  test_consent_until: string | null;
}
async function request(options: OnboardingOptions, secret: string, path: string, body?: unknown): Promise<any> {
  const response = await (options.fetch ?? fetch)(new URL('/api/v1/onboarding/' + path, options.origin), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: options.signal ?? AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Onboarding returned HTTP ${response.status}. Resume the original request; check its owner approval.`);
  if (!response.body) throw new Error('Empty onboarding response.');
  let length = 0; const chunks: Uint8Array[] = [], reader = response.body.getReader();
  for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
    if (length > 32768) { await reader.cancel(); throw new Error('Onboarding response exceeds its limit.'); } chunks.push(part.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid onboarding response.'); }
}

export async function onboard(options: OnboardingOptions): Promise<{ directory: string; config: ConnectorConfig; testApproved: boolean; restartRequired: boolean }> {
  options.origin = platformOrigin(options.origin, options.allowLocalHttp);
  if (!['hermes','openclaw','codex','claude-code','generic-client'].includes(options.runtime)) throw new Error('Select an available runtime.');
  if (options.receive && options.runtime === 'generic-client') throw new Error('Select an execution adapter to offer services.');
  let native: ReturnType<typeof inspectNative> | undefined, execution: CliExecutionConfig | undefined;
  if (options.receive) {
    if (!options.configurationApproved) throw new Error('Review the selected local runtime and allow its configuration with --approve-local-configuration.');
    if (options.runtime === 'hermes' || options.runtime === 'openclaw')
      native = inspectNative(options.runtime, { home: options.home, nativeAgent: options.nativeAgent });
    else {
      execution = inspectCli(options.runtime as 'codex' | 'claude-code', options.workspace ?? '', options.profile);
      if (options.runtime === 'codex') {
        const profile=await createCodexServiceProfile(execution.binary,options.stateRoot ?? join(homedir(), '.envarpay'),options.profile);
        execution.codexHome=profile.home;execution.codexConfigDigest=profile.digest;execution.environmentKeys=profile.environmentKeys;
      }
      else execution.environmentKeys=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','AWS_PROFILE','AWS_REGION','GOOGLE_APPLICATION_CREDENTIALS','ANTHROPIC_VERTEX_PROJECT_ID'];
    }
  }
  const root = options.stateRoot ?? join(homedir(), '.envarpay');
  privateDirectory(root); privateDirectory(join(root, 'onboarding'));
  const binding = digest({ origin: options.origin, runtime: options.runtime, receive: options.receive, native: native ?? null, execution: execution ?? null });
  const file = join(root, 'onboarding', binding + '.json');
  if (options.fresh && existsSync(file)) renameSync(file, file + '.previous-' + randomUUID());
  let pending = existsSync(file) ? privateJson<Pending>(file) : undefined;
  if (pending && (pending.binding !== binding || pending.origin !== options.origin)) throw new Error('Preserve the original onboarding binding.');
  if (pending?.directory) {
    const config = privateJson<ConnectorConfig>(join(pending.directory, 'connector.json'));
    if (config.bindingDigest !== binding || config.disabled) throw new Error('The saved connection changed or was disconnected. Start a newly approved binding.');
    await connectorClient(pending.directory, config).status();
    return { directory: pending.directory, config, testApproved: Boolean(pending.testApproved), restartRequired: Boolean(pending.restartRequired) };
  }
  if (!pending) {
    pending = { request_id: randomUUID(), secret: 'envar_onboard_' + randomBytes(32).toString('base64url'),
      binding, origin: options.origin, runtime: options.runtime, receive: options.receive };
    writePrivateJson(file, pending);
  }
  if (!pending.receipt) {
    const value = await request(options, pending.secret, 'sessions', {
      request_id: pending.request_id, runtime: options.runtime, device_name: 'Local ' + options.runtime,
      binding_digest: binding, receive: options.receive,
    });
    const url = new URL(value.verification_uri);
    if (!uuid.test(value.session_id) || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.user_code) ||
        !Number.isFinite(Date.parse(value.expires_at)) || !Number.isInteger(value.interval) || value.interval < 2 || value.interval > 30 ||
        url.origin !== options.origin || url.pathname !== '/connect/onboard' || url.searchParams.get('code') !== value.user_code ||
        url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1)
      throw new Error('Approval must remain on the selected Envar origin.');
    pending.receipt = value; writePrivateJson(file, pending);
  }
  const approval = pending.receipt!;
  options.output({ status: 'awaiting_owner', verification_uri: approval.verification_uri, user_code: approval.user_code, expires_at: approval.expires_at });
  while (Date.now() < Date.parse(approval.expires_at)) {
    const status = await request(options, pending.secret, 'sessions/current');
    if (status.session_id !== approval.session_id) throw new Error('Onboarding response belongs to a different device.');
    if (status.status === 'approved') {
      const receipt = await request(options, pending.secret, 'sessions/exchange', {}) as Receipt;
      const allowed = ['connection:read','work:read','work:send', ...(options.receive ? ['work:receive','work:report'] : [])];
      if (receipt.version !== 2 || receipt.session_id !== approval.session_id || receipt.runtime !== options.runtime ||
          receipt.binding_digest !== binding || receipt.platform_origin !== options.origin || !uuid.test(receipt.agent_id) || !uuid.test(receipt.connection_id) ||
          !/^envar_agent_[A-Za-z0-9_-]{32,128}$/.test(receipt.token) || !Array.isArray(receipt.scopes) ||
          !receipt.scopes.every(scope => allowed.includes(scope)) || !['connection:read','work:read','work:send'].every(scope => receipt.scopes.includes(scope)) ||
          !Number.isFinite(Date.parse(receipt.expires_at))) throw new Error('Unexpected connection identity or authority.');
      const directory = options.stateRoot ? join(root, 'connectors', receipt.agent_id) : connectorDirectory(receipt.agent_id);
      privateDirectory(directory);
      let previous: ConnectorConfig | undefined;
      if (existsSync(join(directory, 'connector.json'))) {
        previous = privateJson<ConnectorConfig>(join(directory, 'connector.json'));
        const upgrade = previous.version === 2 && previous.origin === options.origin && previous.agentId === receipt.agent_id &&
          previous.connectionId === receipt.connection_id && previous.framework === receipt.runtime &&
          !previous.disabled && !previous.scopes.includes('work:receive') && receipt.scopes.includes('work:receive');
        if (!upgrade && (previous.connectionId !== receipt.connection_id || previous.bindingDigest !== binding))
          throw new Error('Preserve the existing Agent connection and journal.');
        if (upgrade) {
          writePrivateJson(join(directory,'client-before-receiving-' + receipt.session_id + '.json'),previous);
          const oldToken=privateText(join(directory,`credential-${previous.connectionId}.txt`));
          writePrivate(join(directory,`client-credential-before-${receipt.session_id}.txt`),oldToken);
        }
      }
      const receiving = receipt.scopes.includes('work:receive');
      const config: ConnectorConfig = { version: 2, origin: options.origin, agentId: receipt.agent_id, connectionId: receipt.connection_id,
        framework: options.runtime, scopes: receipt.scopes, expiresAt: receipt.expires_at, allowLocalHttp: options.allowLocalHttp,
        nativeConfigured: !receiving || !native,
        ...(previous ? { journalCardUrl: previous.journalCardUrl ?? previous.runtime.cardUrl } : {}), onboardingSession: receipt.session_id, bindingDigest: binding,
        ...(execution && receiving ? { execution } : {}), runtime: {
          home: native?.home ?? execution?.workspace ?? directory, agentId: native?.agentId ?? receipt.agent_id,
          cardUrl: native?.cardUrl ?? previous?.runtime.cardUrl ?? 'envar-local:' + binding, binary: native?.binary ?? (execution ? [execution.binary] : []),
          ...(native?.configFile ? { configFile: native.configFile } : {}), ...(native?.port ? { port: native.port } : {}),
          peerName: 'envar-' + receipt.agent_id, mcpName: 'envar-' + receipt.agent_id,
        } };
      writePrivate(join(directory, `credential-${receipt.connection_id}.txt`), receipt.token + '\n');
      if (execution && receiving) writePrivateJson(join(directory,'runtime-environment.json'),
        Object.fromEntries((execution.environmentKeys??[]).filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])));
      writePrivateJson(join(directory, 'connector.json'), config);
      let restartRequired = false;
      if (native && receiving) { restartRequired = configureNative(directory, config); config.nativeConfigured = true; writePrivateJson(join(directory, 'connector.json'), config); }
      pending.directory = directory; pending.testApproved = Boolean(receipt.test_consent_until); pending.restartRequired = restartRequired; writePrivateJson(file, pending);
      writePrivateJson(join(root, 'current-connection.json'), { directory });
      return { directory, config, testApproved: Boolean(receipt.test_consent_until), restartRequired };
    }
    if (status.status !== 'pending') throw new Error('The original onboarding expired or was declined.');
    if (options.poll) await options.poll(); else await sleep(approval.interval * 1000, undefined, { signal: options.signal });
  }
  throw new Error('Onboarding expired. Preserve its state and request a new owner-approved connection.');
}
