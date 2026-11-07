/** Diagnostics are receiver reports, never a grant or proof of task completion. */
import { readFileSync } from 'node:fs';
import type { RuntimeReadiness } from '../adapters/types.js';

export const CONNECTOR_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const version = (value: string) => /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value) ? value : 'unknown';

export function runtimeReport(runtime: RuntimeReadiness) {
  const concurrency = runtime.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error('Use a bounded runtime concurrency limit');
  return {
    schema_version: 1,
    connector_version: CONNECTOR_VERSION,
    adapter: runtime.adapter,
    runtime_version: version(runtime.runtimeVersion),
    version_source: 'agent_card',
    capabilities: {
      task_lookup: runtime.capabilities.recover,
      task_lookup_after_restart: runtime.recovery?.taskLookupAfterRestart ?? false,
      execution_key_lookup: runtime.recovery?.executionKeyLookup ?? false,
      result_persistence: runtime.recovery?.resultPersistence ?? false,
      input: runtime.capabilities.input,
      cancel: runtime.capabilities.cancel,
      max_concurrency: concurrency,
    },
  };
}
