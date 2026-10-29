import test from 'node:test';
import assert from 'node:assert/strict';
import { runConnectorCli } from '../dist/connector/cli.js';

test('standalone and compatibility help advertise the installed command', async () => {
  const lines=[], log=console.log;
  console.log=value=>lines.push(value);
  try {
    await runConnectorCli(['--help']);
    await runConnectorCli(['--help'],['envarpay','connector']);
  } finally {console.log=log;}
  assert.match(lines[0],/envar-connect run/);
  assert.match(lines[1],/envarpay connector run/);
  assert.ok(!lines[1].includes('envar-connect'));
});
