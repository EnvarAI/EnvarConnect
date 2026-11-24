import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvarTaskClient, TaskApiError } from '../dist/connector/client.js';
import { CONNECTOR_VERSION, runtimeReport } from '../dist/connector/runtime-report.js';

const runtime = () => ({ adapter: 'hermes', runtimeVersion: '1.0', capabilities: { recover: true, input: false, cancel: false } });
const token = 'envar_agent_' + 'r'.repeat(43);

test('legacy recover capability never implies durable native execution or result storage', () => {
  const report = runtimeReport(runtime());
  assert.equal(report.connector_version, CONNECTOR_VERSION);
  assert.equal(report.version_source, 'agent_card');
  assert.deepEqual(report.capabilities, { task_lookup: true, task_lookup_after_restart: false,
    execution_key_lookup: false, result_persistence: false, input: false, cancel: false, max_concurrency: 1 });
  assert.equal(runtimeReport({ ...runtime(), runtimeVersion: 'untrusted\nconfiguration' }).runtime_version, 'unknown');
});

test('runtime diagnostics use the scoped RPC and retain demonstrated capabilities', async () => {
  const calls = [];
  const client = new EnvarTaskClient('https://envar.example', token, { rpc: async (method, params) => {
    calls.push({ method, params }); return {};
  } });
  assert.equal(await client.reportRuntime(runtime()), 'accepted');
  assert.deepEqual(calls, [{ method: 'report_runtime', params: runtimeReport(runtime()) }]);
});
for (const status of [404, 405, 429, 500, 401, 403]) {
  test(`runtime reporting rejects ${status} without a compatibility fallback or retry`, async () => {
    let calls = 0;
    const client = new EnvarTaskClient('https://envar.example', token, { rpc: async () => {
      calls++; throw new TaskApiError(status, 'rpc_rejected');
    } });
    await assert.rejects(client.reportRuntime(runtime()), TaskApiError);
    assert.equal(calls, 1);
  });
}
