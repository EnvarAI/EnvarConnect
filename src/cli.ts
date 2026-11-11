#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else {
  try {
    if (!args.length || ['--help','-h','help','onboard','services','orders','receiver','check','connections'].includes(args[0] ?? '')) {
      const { runUnifiedCli } = await import('./connector/unified-cli.js');
      await runUnifiedCli(!args.length || ['--help','-h','help'].includes(args[0] ?? '') ? ['--help'] : args);
    } else {
    const { runConnectorCli } = await import('./connector/cli.js');
    await runConnectorCli(args[0] === 'connector' ? args.slice(1) : args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Connector operation failed');
    process.exitCode = 1;
  }
}
