import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('root help points new users to UUID-free onboarding and retains existing-connection commands', () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const help = JSON.parse(result.stdout);
    assert.ok(help.commands.includes('onboard'));
    assert.ok(help.commands.includes('connections'));
    assert.match(help.next, /onboard --runtime auto/);
    assert.ok(help.commands.includes('run --agent UUID'));
  }
});

test('retired connector subcommand is no longer accepted', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'connector'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
