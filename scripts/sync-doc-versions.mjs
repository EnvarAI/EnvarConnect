import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const documents = ['README.md', 'docs/native-connector.md', 'docs/compatibility.md'];
export function syncDocVersions({ check = false } = {}) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changed = [];
  for (const name of documents) {
    const path = new URL('../' + name, import.meta.url);
    const original = readFileSync(path, 'utf8');
    assert.match(original, /@envarai\/connect@\d{4}\.\d{3,4}\.\d+/, name + ' needs an explicit install version');
    const updated = original.replace(/@envarai\/connect@\d{4}\.\d{3,4}\.\d+/g, pkg.name + '@' + pkg.version);
    if (original !== updated) {
      changed.push(name);
      if (!check) writeFileSync(path, updated);
    }
  }
  assert.ok(!check || changed.length === 0, 'Install versions are stale: ' + changed.join(', ') + '. Run node scripts/sync-doc-versions.mjs');
  return changed;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) syncDocVersions({ check: process.argv.includes('--check') });
