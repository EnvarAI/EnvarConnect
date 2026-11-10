/** Local CLI execution. No model credentials or user UI sessions move to Envar. */
import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { digest } from '../shared/json.js';
import { privateDirectory, privateJson, privateText, writePrivateJson } from '../connector/files.js';
import { RuntimeControlUnsupported } from './a2a-runtime.js';
import type { Work } from '../connector/contracts.generated.js';
import type { RelayRuntime, RuntimeAdapter, RuntimeObservation, RuntimeReadiness, RuntimeReference } from './types.js';
import type { RelayReference } from '../connector/relay-types.js';

export interface CliExecutionConfig {
  binary: string; workspace: string; profile?: string; timeoutSeconds: number;
  /** Existing CLI configuration may contain hooks and tools; selected explicitly by the owner. */
  configurationApproved: boolean;
  disabledMcpServers?: string[];
  codexHome?: string; codexConfigDigest?: string;
  environmentKeys?: string[];
}
export interface CliExecutionRecord {
  version: 1; key: string; adapter: string; binding: string; requestDigest: string;
  state: RuntimeObservation['state']; text?: string; startedAt: string;
  nativeSession?: string; workerPid?: number; observedAt?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function inspectCli(runtime: 'codex' | 'claude-code', workspace: string, profile?: string): CliExecutionConfig {
  if (!workspace || !isAbsolute(workspace)) throw new Error('Select an absolute, dedicated service workspace with --workspace.');
  const root = realpathSync(workspace);
  if (!lstatSync(root).isDirectory() || root === '/' || root === homedir()) throw new Error('Use a dedicated service workspace, not your home or filesystem root.');
  const name = runtime === 'codex' ? 'codex' : 'claude';
  const found = (process.env.PATH ?? '').split(':').map(path => join(path, name)).find(path => existsSync(path));
  if (!found) throw new Error(`Install and sign in to ${name} in this environment first.`);
  const binary = realpathSync(found);
  if (profile && !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new Error('Use an existing named Codex profile.');
  execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: 'pipe' });
  return { binary, workspace: root, ...(profile ? { profile } : {}), timeoutSeconds: 300, configurationApproved: true };
}

export class CliRuntimeAdapter implements RuntimeAdapter {
  readonly binding: string;
  readonly relay: RelayRuntime;
  constructor(readonly directory: string, readonly key: 'codex' | 'claude-code', readonly config: CliExecutionConfig) {
    if (!config.configurationApproved || !isAbsolute(config.binary) || !isAbsolute(config.workspace) ||
        !Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 10 || config.timeoutSeconds > 900)
      throw new Error('Restore the original approved CLI execution configuration.');
    this.binding = digest({ key, config });
    const send: RelayRuntime['send'] = async (params, execution) => {
      if (!execution) throw new Error('An admitted execution binding is required.');
      const message = params.message as { parts?: { text?: string }[]; contextId?: string };
      if (!message || !Array.isArray(message.parts) || message.parts.some(part=>typeof part.text !== 'string'))
        throw new Error('This CLI adapter accepts only verified text messages.');
      const contextId = message.contextId ?? execution.contextId;
      if (!uuid.test(contextId)) throw new Error('Use the original local execution context.');
      const observation = await this.start({ id: execution.workId, request: { message: message.parts.map(p=>p.text).join('\n'), tool:'', arguments:{} } } as Work, execution.workId);
      const reference: RelayReference = { kind:'local_cli_execution', adapter:this.key, binding_digest:this.binding, task_id:execution.workId, context_id:contextId };
      return { task:this.task(observation,reference), reference };
    };
    this.relay = { version:'2', cardDigest:async()=>this.binding, send,
      prepareSend:async(params,execution)=>{await this.probe();return ()=>send(params,execution);},
      read:async(reference)=>{
        if (!('kind' in reference) || reference.kind !== 'local_cli_execution' || reference.adapter !== this.key || reference.binding_digest !== this.binding)
          throw new Error('Read only the original local execution reference.');
        return this.task(await this.observe(this.reference(reference.task_id)),reference);
      },
    };
  }
  private task(observation:RuntimeObservation, reference:RelayReference):Record<string,unknown> {
    if (observation.state === 'unknown') throw new Error('The original local outcome is unknown.');
    const state = { working:'TASK_STATE_WORKING', completed:'TASK_STATE_COMPLETED', failed:'TASK_STATE_FAILED',
      canceled:'TASK_STATE_CANCELED', input_required:'TASK_STATE_INPUT_REQUIRED' }[observation.state];
    return { id:reference.task_id, contextId:reference.context_id, status:{state},
      ...(observation.state === 'completed' && observation.text ? { artifacts:[{artifactId:reference.task_id,parts:[{text:observation.text}]}] } : {}) };
  }
  async probe(): Promise<RuntimeReadiness> {
    if(this.key==='codex' && this.config.codexHome && digest(privateText(join(this.config.codexHome,'config.toml')))!==this.config.codexConfigDigest)
      throw new Error('The approved Codex service configuration changed. Review it before receiving tasks.');
    const text = execFileSync(this.config.binary, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: 'pipe' });
    return { adapter: this.key, runtimeVersion: text.match(/\d+\.\d+(?:\.[\w.+-]+)?/)?.[0] ?? 'unknown', versionSource: 'cli_version',
      capabilities: { recover: true, input: false, cancel: false },
      recovery: { taskLookupAfterRestart: true, executionKeyLookup: false, resultPersistence: true }, maxConcurrency: 1,
      receiverSupervised: process.env.ENVAR_SUPERVISED_RECEIVER === '1' };
  }
  private execution(key: string) {
    if (!uuid.test(key)) throw new Error('Use the original execution UUID.');
    return join(this.directory, 'executions', key);
  }
  private reference(key: string): RuntimeReference { return { adapter: this.key, version: 1, value: { execution_key: key, binding: this.binding } }; }
  async start(work: Work, executionKey: string): Promise<RuntimeObservation> {
    if (work.id !== executionKey) throw new Error('Execute the original work only.');
    const folder = this.execution(executionKey), path = join(folder, 'result.json'), input = digest(work.request);
    privateDirectory(folder);
    if (existsSync(path)) {
      const original = privateJson<CliExecutionRecord>(path);
      if (original.requestDigest !== input) throw new Error('Execution key belongs to a different request.');
      return this.observe(this.reference(executionKey));
    }
    await this.probe();
    // Exclusive intent file prevents replay even after a crash before native process creation.
    writeFileSync(join(folder, 'intent.json'), JSON.stringify({ binding: this.binding, requestDigest: input }), { flag: 'wx', mode: 0o600, flush: true });
    writePrivateJson(path, { version: 1, key: executionKey, adapter: this.key, binding: this.binding,
      requestDigest: input, state: 'unknown', startedAt: new Date().toISOString() } satisfies CliExecutionRecord);
    writePrivateJson(join(folder, 'request.json'), { config: this.config, runtime: this.key, message: work.request.message });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli-worker.js', import.meta.url)), folder], {
      detached: true, stdio: 'ignore', env: { ...process.env, ENVAR_EXECUTION_CHILD: '1' },
    });
    child.on('error', () => { /* Preserve unknown. Never spawn the original operation again. */ });
    child.unref();
    return { reference: this.reference(executionKey), state: 'working', text: 'Original local execution was submitted.' };
  }
  async observe(reference: RuntimeReference): Promise<RuntimeObservation> {
    const key = String(reference.value.execution_key ?? '');
    if (reference.adapter !== this.key || reference.value.binding !== this.binding || reference.version !== 1)
      throw new Error('Read only the original runtime binding.');
    const row = privateJson<CliExecutionRecord>(join(this.execution(key), 'result.json'));
    if (row.key !== key || row.binding !== this.binding || row.adapter !== this.key) throw new Error('Execution record differs from its original binding.');
    if (row.state === 'working' && (!row.observedAt || Date.now() - Date.parse(row.observedAt) > 60000))
      return { reference, state: 'unknown', text: 'The original runner is not reporting. Its execution was not restarted.' };
    return { reference, state: row.state, ...(row.text ? { text: row.text } : {}) };
  }
  async provideInput(): Promise<RuntimeObservation> { throw new RuntimeControlUnsupported(); }
  async cancel(): Promise<RuntimeObservation> { throw new RuntimeControlUnsupported(); }
  async close() { /* Detached original execution remains observable. */ }
}

export function cliCommand(runtime: string, _config: CliExecutionConfig, workspace: string): string[] {
  if (resolve(workspace) !== workspace) throw new Error('Use an absolute execution workspace.');
  if (runtime === 'codex') return ['exec','--json','--skip-git-repo-check','--cd',workspace,'-'];
  if (runtime === 'claude-code') return ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--settings', '{"disableAllHooks":true}'];
  throw new Error('Unsupported CLI runtime.');
}
