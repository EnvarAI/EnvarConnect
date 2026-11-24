/** Explicit, local service configuration. Only its fingerprint reaches Envar. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { digest } from '../shared/json.js';

export interface ServiceProfile {
  root: string;
  digest: string;
  skillCount: number;
  environmentKeys: string[];
}
export const CLAUDE_SERVICE_PLUGIN = 'envar-service';
const configuration = ['config.toml', 'settings.json', 'mcp.json', 'AGENTS.md', 'CLAUDE.md'];

function files(root: string, runtime: 'codex' | 'claude-code') {
  const result: string[] = []; let bytes = 0;
  const visit = (path: string) => {
    // Codex installs its bundled system skills on first execution. Those are
    // runtime assets, not seller-selected service skills or configuration drift.
    if (runtime === 'codex' && relative(root, path) === 'skills/.system') return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Service profile files must not be symbolic links');
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!stat.isFile()) throw new Error('Service profiles contain only regular files');
    bytes += stat.size; result.push(relative(root, path));
    if (result.length > 512 || bytes > 8 * 1024 * 1024) throw new Error('Service profile exceeds 512 files or 8 MiB');
  };
  for (const name of [...configuration, 'skills', 'tools']) if (existsSync(join(root, name))) visit(join(root, name));
  return result.sort();
}

export function inspectServiceProfile(runtime: 'codex' | 'claude-code', path: string): ServiceProfile {
  if (!isAbsolute(path)) throw new Error('Choose an absolute, dedicated --service-profile directory');
  const root = realpathSync(path), stat = lstatSync(root);
  if (!stat.isDirectory() || root === '/' || root === homedir() || (stat.mode & 0o077))
    throw new Error('Use an owner-only dedicated service profile directory (mode 700)');
  const required = runtime === 'codex' ? 'config.toml' : 'settings.json';
  if (!existsSync(join(root, required))) throw new Error(`The service profile requires ${required}`);
  const selected = files(root, runtime), environmentKeys = new Set<string>();
  const fingerprints = selected.map(name => {
    const bytes = readFileSync(join(root, name));
    if (configuration.includes(name)) {
      const text = bytes.toString('utf8');
      for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) environmentKeys.add(match[1]!);
      if (name.endsWith('.json')) {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile settings must be JSON objects');
      }
    }
    return [name, createHash('sha256').update(bytes).digest('hex')];
  });
  return { root, digest: digest({ runtime, files: fingerprints }),
    skillCount: selected.filter(name => name.startsWith('skills/') && name.endsWith('/SKILL.md')).length,
    environmentKeys: [...environmentKeys].sort() };
}

export function verifyServiceProfile(runtime: 'codex' | 'claude-code', profile: ServiceProfile) {
  const actual = inspectServiceProfile(runtime, profile.root);
  if (actual.digest !== profile.digest) throw new Error('The approved service profile changed. Review it and test a new service revision');
  return actual;
}

export function materializeServiceProfile(runtime: 'codex' | 'claude-code', profile: ServiceProfile, workspace: string) {
  verifyServiceProfile(runtime, profile);
  const claudePlugin = join(workspace, '.claude');
  if (runtime === 'claude-code' && existsSync(claudePlugin))
    throw new Error('The Claude service workspace already contains configuration outside the selected profile');
  // Only approved skills, tool scripts and project instructions enter this job.
  // Native login/configuration stays in the dedicated profile, not in Envar.
  for (const name of files(profile.root, runtime)) {
    let destination: string;
    if (name.startsWith('skills/')) destination = join(workspace, runtime === 'codex' ? '.agents' : '.claude', name);
    else if (name.startsWith('tools/') || name === 'AGENTS.md' || name === 'CLAUDE.md') destination = join(workspace, name);
    else continue;
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(join(profile.root, name), destination);
  }
  if (runtime === 'claude-code' && profile.skillCount) {
    const manifest = join(claudePlugin, '.claude-plugin', 'plugin.json');
    mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
    writeFileSync(manifest, JSON.stringify({ name: CLAUDE_SERVICE_PLUGIN, version: '1.0.0' }) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
