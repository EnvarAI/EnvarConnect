import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectorJournal } from '../dist/connector/state.js';
import { connectorDirectory, connectorStateRoot, connectorAgentIds } from '../dist/connector/paths.js';

const temporary = () => mkdtempSync(join(tmpdir(), 'envar-paths-'));
test('fresh installations use the neutral root even when an old CLI was installed', () => {
  const base = temporary(), id = randomUUID();
  mkdirSync(join(base, '.envarpay', 'cli'), { recursive: true });
  assert.equal(connectorStateRoot(base), join(base, '.envar'));
  assert.equal(connectorDirectory(id, undefined, base), join(base, '.envar', 'connectors', id));
});

test('upgrading the CLI preserves the original pointer, credential and journal', () => {
  const base = temporary(), id = randomUUID(), root = join(base, '.envar');
  const directory = join(root, 'connectors', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(base, '.envar', 'cli'), { recursive: true });
  writeFileSync(join(directory, 'credential.txt'), 'original-private-fixture', { mode: 0o600 });
  const binding = { origin: 'https://envar.ai', agentId: id, connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'https://agent.example/card' };
  const requestId = randomUUID(), orderId = randomUUID(), input = { text: 'original order' };
  let journal = new ConnectorJournal(join(directory, 'journal.sqlite3'), binding);
  journal.orderRequest(requestId, input); journal.saveOrderRequest(requestId, orderId); journal.close();
  writeFileSync(join(root, 'current-connection.json'), JSON.stringify({ directory }), { mode: 0o600 });
  assert.equal(connectorStateRoot(base), root);
  assert.equal(connectorDirectory(undefined, undefined, base), directory);
  assert.equal(connectorDirectory(id, undefined, base), directory);
  assert.equal(readFileSync(join(directory, 'credential.txt'), 'utf8'), 'original-private-fixture');
  journal = new ConnectorJournal(join(connectorDirectory(id, undefined, base), 'journal.sqlite3'), binding);
  assert.equal(journal.orderRequest(requestId, input), orderId); journal.close();
  assert.deepEqual(connectorAgentIds(base), [id]);
});


test('current pointers require a direct UUID child; explicit original directories remain usable', () => {
  const base = temporary(), root = connectorStateRoot(base); mkdirSync(root);
  writeFileSync(join(root, 'current-connection.json'), JSON.stringify({ directory: join(root, 'connectors', '..', 'other') }), { mode: 0o600 });
  assert.throws(() => connectorDirectory(undefined, undefined, base), /explicit/);
  const selected = join(base, 'original');
  assert.equal(connectorDirectory(undefined, selected, base), selected);
});
