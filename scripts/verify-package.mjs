import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateVersion } from './release-version.mjs';
const directory = resolve(process.argv[2]);
const files = readdirSync(directory).filter(name => name.endsWith('.tgz'));
assert.equal(files.length, 1);
const tarball = join(directory, files[0]);
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
assert.ok(entries.includes('package/contracts/agent-work/v1/schema.json'));
assert.ok(!entries.some(path => /(^|\/)_(?:archive)(\/|$)|package\/dist\/commerce\/|wallet_fixture|\.env(?:$|\.)/.test(path)), 'Private or seller files entered the Connector package');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
validateVersion(pkg.version);
const root = mkdtempSync(join(tmpdir(), 'envar-connect-package-'));
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--cache', join(root, 'empty-cache'), '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', "import {EnvarWorkClient} from '@envarai/connect'; import {NativeA2AClient} from '@envarai/connect/adapters/native-a2a'; import {runConnectorCli} from '@envarai/connect/connector/cli'; import {digest,CommerceError} from '@envarai/connect/shared'; if(!EnvarWorkClient||!NativeA2AClient||!runConnectorCli||!digest||!CommerceError)throw Error('Missing public API');"], { cwd: root, stdio: 'inherit' });
  const cli = join(root, 'node_modules/@envarai/connect/dist/cli.js');
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /envar-connect connect/);
  assert.match(execFileSync(process.execPath, [cli, 'connector', '--help'], { encoding: 'utf8' }), /Envar Connector/);
  console.log('Offline packed CLI and public exports verified: ' + pkg.version);
} finally { rmSync(root, { recursive: true, force: true }); }
