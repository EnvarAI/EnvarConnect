#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else {
  try {
    const { runUnifiedCli } = await import('./connector/unified-cli.js');
    await runUnifiedCli(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Connector operation failed');
    process.exitCode = 1;
  }
}
