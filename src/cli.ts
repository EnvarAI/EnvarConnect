#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else {
  try {
    const { runConnectorCli } = await import('./connector/cli.js');
    await runConnectorCli(args[0] === 'connector' ? args.slice(1) : args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Connector operation failed');
    process.exitCode = 1;
  }
}
