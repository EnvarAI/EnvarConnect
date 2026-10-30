import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ConnectorJournal } from '../dist/connector/state.js';

const binding = { origin: 'https://envar.test', agentId: 'agent', connectionId: 'connection', adapter: 'openclaw', cardUrl: 'http://127.0.0.1:18789/.well-known/agent-card.json' };
const moduleUrl = new URL('../dist/connector/state.js', import.meta.url).href;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-lock-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { journal: join(directory, 'journal.sqlite3'), lock: join(directory, 'receiver.lock') };
}

test('receiver lock excludes a second receiver while native MCP journal access continues', t => {
  const f = fixture(t), first = new ConnectorJournal(f.journal, binding), second = new ConnectorJournal(f.journal, binding);
  try {
    first.acquireProcessLock(f.lock);
    assert.throws(() => second.acquireProcessLock(f.lock), /Another Connector/);
    assert.deepEqual(second.pending(), []);
    assert.equal(second.outgoing("native-mcp-request", { text: "journal remains writable" }), undefined);
    first.close();
    assert.equal(existsSync(f.lock), false);
    second.acquireProcessLock(f.lock);
    second.close();
  } catch (error) { try { first.close(); } catch {} try { second.close(); } catch {} throw error; }
});

test('live legacy receiver remains protected and its marker is preserved', t => {
  const f = fixture(t), value = JSON.stringify({ pid: process.pid, nonce: 'legacy' });
  writeFileSync(f.lock, value, { mode: 0o600 });
  const journal = new ConnectorJournal(f.journal, binding);
  try {
    assert.throws(() => journal.acquireProcessLock(f.lock), /Another Connector/);
    assert.equal(readFileSync(f.lock, 'utf8'), value);
  } finally { journal.close(); }
});

test('a proved-dead legacy process can migrate without deleting the task journal', t => {
  const f = fixture(t), child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  writeFileSync(f.lock, JSON.stringify({ pid: child.pid, nonce: 'legacy' }), { mode: 0o600 });
  const journal = new ConnectorJournal(f.journal, binding);
  try {
    journal.acquireProcessLock(f.lock);
    const marker = JSON.parse(readFileSync(f.lock, 'utf8'));
    assert.equal(marker.version, 2);
    assert.equal(Number.isSafeInteger(marker.pid), false); // Legacy clients reject this marker.
  } finally { journal.close(); }
});

test('hard process exit releases the lock even when a new receiver reuses the recorded PID', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const script = `import { ConnectorJournal } from ${JSON.stringify(moduleUrl)};
    const j = new ConnectorJournal(${JSON.stringify(f.journal)}, ${JSON.stringify(binding)});
    j.acquireProcessLock(${JSON.stringify(f.lock)}); process.send('locked'); setInterval(() => j.pending(), 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'message');
  const journal = new ConnectorJournal(f.journal, binding);
  try {
    assert.throws(() => journal.acquireProcessLock(f.lock), /Another Connector/);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const marker = JSON.parse(readFileSync(f.lock, 'utf8'));
    marker.ownerPid = process.pid; // Container restart can reuse PID 1; PID liveness is not ownership.
    writeFileSync(f.lock, JSON.stringify(marker), { mode: 0o600 });
    journal.acquireProcessLock(f.lock);
    assert.deepEqual(journal.pending(), []);
  } finally { journal.close(); }
});

test('receiver rejects an insecure lock database', t => {
  const f = fixture(t);
  writeFileSync(f.lock + '.sqlite3', '', { mode: 0o644 });
  const journal = new ConnectorJournal(f.journal, binding);
  try { assert.throws(() => journal.acquireProcessLock(f.lock), /owner-only/); }
  finally { journal.close(); }
});
