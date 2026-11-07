import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConnectorJournal } from '../dist/connector/state.js';

const binding = { origin: 'https://example.test', agentId: 'agent', connectionId: 'connection', adapter: 'hermes', cardUrl: '' };
const linux = { skip: process.platform !== 'linux' };

test('Linux lock excludes another journal and preserves its inode across close', linux, () => {
  const root = mkdtempSync(join(tmpdir(), 'envar-lock-'));
  const lock = join(root, 'receiver.lock');
  const a = new ConnectorJournal(':memory:', binding), b = new ConnectorJournal(':memory:', binding);
  let aClosed = false;
  try {
    a.acquireProcessLock(lock);
    const inode = statSync(`${lock}.flock`).ino;
    assert.throws(() => b.acquireProcessLock(lock), /Another Connector/);
    a.close();
    aClosed = true;
    b.acquireProcessLock(lock);
    assert.equal(statSync(`${lock}.flock`).ino, inode);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).locking, 'flock');
  } finally { if (!aClosed) a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Linux lock recovers after SIGKILL even when stale metadata reuses our PID', { ...linux, timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'envar-lock-'));
  const lock = join(root, 'receiver.lock');
  const moduleUrl = new URL('../dist/connector/state.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ConnectorJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new ConnectorJournal(':memory:', ${JSON.stringify(binding)});
    journal.acquireProcessLock(${JSON.stringify(lock)});
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const journal = new ConnectorJournal(':memory:', binding);
  try {
    await once(child.stdout, 'data');
    assert.throws(() => journal.acquireProcessLock(lock), /Another Connector/);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const stale = JSON.parse(readFileSync(lock, 'utf8'));
    writeFileSync(lock, JSON.stringify({ ...stale, pid: process.pid }), { mode: 0o600 });
    journal.acquireProcessLock(lock);
    assert.notEqual(JSON.parse(readFileSync(lock, 'utf8')).nonce, stale.nonce);
  } finally { child.kill('SIGKILL'); journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Linux upgrade preserves a live legacy lock', linux, () => {
  const root = mkdtempSync(join(tmpdir(), 'envar-lock-'));
  const lock = join(root, 'receiver.lock');
  const original = JSON.stringify({ pid: process.pid, nonce: 'legacy' });
  writeFileSync(lock, original, { mode: 0o600 });
  const journal = new ConnectorJournal(':memory:', binding);
  try {
    assert.throws(() => journal.acquireProcessLock(lock), /legacy PID lock/);
    assert.equal(readFileSync(lock, 'utf8'), original);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});
