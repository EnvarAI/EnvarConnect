import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvarWorkClient, WorkApiError } from '../dist/connector/client.js';
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

test('diagnostics use only the authenticated original platform origin', async () => {
  const calls = [];
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async (url, init) => {
    calls.push({ url, init }); return Response.json({});
  } });
  assert.equal(await client.reportRuntime(runtime()), 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://envar.example/api/v1/agent-connections/current/runtime');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ' + token);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), runtimeReport(runtime()));
});

for (const status of [404, 405, 429, 500, 401, 403]) {
  test(`runtime reporting handles HTTP ${status} without hiding revoked authority or retrying`, async () => {
    let calls = 0;
    const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () => {
      calls++; return Response.json({ private: 'never log this' }, { status });
    } });
    if ([401, 403].includes(status)) await assert.rejects(client.reportRuntime(runtime()), WorkApiError);
    else assert.equal(await client.reportRuntime(runtime()), [404, 405].includes(status) ? 'unsupported' : 'unavailable');
    assert.equal(calls, 1);
  });
}
