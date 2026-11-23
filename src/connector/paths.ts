/** New installations use the neutral root; existing bindings are never moved. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { privateJson } from './files.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function connectorRoots(baseDirectory = homedir()): string[] {
  return [join(baseDirectory, '.envar'), join(baseDirectory, '.envarpay')];
}
export function connectorStateRoot(baseDirectory = homedir()): string {
  const roots = connectorRoots(baseDirectory);
  const existing = roots.filter(root => ['current-connection.json', 'connectors', 'onboarding', 'runtimes']
    .some(name => existsSync(join(root, name))));
  if (existing.length > 1) throw new Error('Multiple Connector state roots exist. Use the original --agent or --directory; do not copy credentials or journals.');
  return existing[0] ?? roots[0]!;
}
export function connectorDirectory(agentId?: string, directory?: string, baseDirectory = homedir()): string {
  if (directory) return resolve(directory);
  if (!agentId) {
    const root = connectorStateRoot(baseDirectory), pointer = join(root, 'current-connection.json');
    if (existsSync(pointer)) {
      const current = privateJson<{ directory: string }>(pointer);
      if (typeof current.directory !== 'string' || dirname(resolve(current.directory)) !== join(root, 'connectors') ||
        !uuid.test(basename(current.directory))) throw new Error('Choose an explicit --agent UUID or --directory');
      return current.directory;
    }
  }
  if (!agentId || !uuid.test(agentId)) throw new Error('Provide --agent UUID or the original --directory');
  const existing = connectorRoots(baseDirectory).map(root => join(root, 'connectors', agentId!)).filter(existsSync);
  if (existing.length > 1) throw new Error('This Agent has multiple state directories. Use its original --directory; do not start a second receiver.');
  return existing[0] ?? join(connectorStateRoot(baseDirectory), 'connectors', agentId);
}
export function connectorAgentIds(baseDirectory = homedir()): string[] {
  return [...new Set(connectorRoots(baseDirectory).flatMap(root => {
    const directory = join(root, 'connectors');
    return existsSync(directory) ? readdirSync(directory).filter(value => uuid.test(value)) : [];
  }))].sort();
}
