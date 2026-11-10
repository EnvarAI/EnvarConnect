/** Runs once per exclusive intent and saves the real final result before reporting. */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { cliCommand, type CliExecutionConfig, type CliExecutionRecord } from './cli-runtime.js';
import { privateJson, writePrivateJson } from '../connector/files.js';

export async function executeCli(folder: string): Promise<void> {
  const file = join(folder, 'result.json'), row = privateJson<CliExecutionRecord>(file);
  const request = privateJson<{ config: CliExecutionConfig; runtime: string; message: string }>(join(folder, 'request.json'));
  if (row.state !== 'unknown') throw new Error('The original runner has already started.');
  // Each order has its own empty working directory; no personal conversational context is copied.
  const workspace = join(request.config.workspace, 'envar-' + row.key);
  mkdirSync(workspace, { mode: 0o700 });
  let finalText = '', failure = false, terminal = false, output = '', bytes = 0, stopped = false;
  const save = () => { row.observedAt = new Date().toISOString(); writePrivateJson(file, row); };
  row.state = 'working'; row.workerPid = process.pid; save();
  const envFile=join(dirname(dirname(folder)),'runtime-environment.json');
  const storedEnvironment=existsSync(envFile)?privateJson<Record<string,string>>(envFile):{};
  const runtimeEnvironment=Object.fromEntries((request.config.environmentKeys??[])
    .filter(key=>typeof storedEnvironment[key]==='string').map(key=>[key,storedEnvironment[key]]));
  const child = spawn(request.config.binary, cliCommand(request.runtime, request.config, workspace), {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, ...runtimeEnvironment, ...(request.config.codexHome ? { CODEX_HOME: request.config.codexHome } : {}) },
  });
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    hardStop = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 5000);
  };
  const timer = setTimeout(stop, request.config.timeoutSeconds * 1000);
  const heartbeat = setInterval(save, 15000);
  const line = (text: string) => {
    let event: any;
    try { event = JSON.parse(text); } catch { return; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') row.nativeSession = event.thread_id;
    if (event.type === 'system' && typeof event.session_id === 'string') row.nativeSession = event.session_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') finalText = event.item.text;
    if (event.type === 'turn.completed') terminal = true;
    if (event.type === 'turn.failed' || event.type === 'error') failure = true;
    if (event.type === 'result') {
      terminal = true; failure = Boolean(event.is_error) || event.subtype !== 'success';
      if (typeof event.result === 'string') finalText = event.result;
    }
  };
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) { stop(); return; }
    output += chunk.toString('utf8');
    let index: number;
    while ((index = output.indexOf('\n')) >= 0) { line(output.slice(0, index)); output = output.slice(index + 1); }
  });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stop(); });
  child.stdin.on('error', () => { /* Child exit is evaluated below. */ });
  child.stdin.end(request.message);
  await new Promise<void>(resolve => {
    let finished = false;
    const finish = (code: number | null, spawnError = false) => {
      if (finished) return; finished = true; clearTimeout(timer); clearInterval(heartbeat); if (hardStop) clearTimeout(hardStop);
      if (output.trim()) line(output);
      const good = code === 0 && terminal && !failure && finalText.trim() && Buffer.byteLength(finalText) <= 32000;
      row.state = good ? 'completed' : spawnError || failure ? 'failed' : 'unknown';
      row.text = good ? finalText : spawnError ? 'The configured native CLI could not start.'
        : stopped ? 'The original CLI exceeded its execution limit. Inspect that execution; it was not restarted.'
        : 'The original CLI did not return a verified successful result. Check its login, permissions and native execution.';
      save(); resolve();
    };
    child.once('error', () => finish(null, true)); child.once('close', code => finish(code));
  });
}
if (process.env.ENVAR_EXECUTION_CHILD === '1' && process.argv[2]) {
  executeCli(process.argv[2]).catch(() => { process.exitCode = 1; });
}
