/** Current connection state; old roots are never auto-imported. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { privateJson } from './files.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function connectorStateRoot(baseDirectory = homedir()): string {
  return join(baseDirectory, '.envar');
}
export function connectorDirectory(
  agentId?: string,
  directory?: string,
  baseDirectory = homedir(),
): string {
  if (directory) return resolve(directory);
  const root = connectorStateRoot(baseDirectory),
    pointer = join(root, 'current-connection.json');
  if (!agentId && existsSync(pointer)) {
    const current = privateJson<{ directory: string }>(pointer);
    if (
      typeof current.directory !== 'string' ||
      dirname(resolve(current.directory)) !== join(root, 'connectors') ||
      !uuid.test(basename(current.directory))
    )
      throw new Error('Choose an explicit --agent UUID or --directory');
    return current.directory;
  }
  if (!agentId || !uuid.test(agentId))
    throw new Error('Provide --agent UUID or the original --directory');
  return join(root, 'connectors', agentId);
}
export function connectorAgentIds(baseDirectory = homedir()): string[] {
  const directory = join(connectorStateRoot(baseDirectory), 'connectors');
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((value) => uuid.test(value))
        .sort()
    : [];
}
