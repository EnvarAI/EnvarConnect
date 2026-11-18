/** Installed compatibility entrypoint; parsing and command behavior have one owner. */
import { runUnifiedCli } from './unified-cli.js';
export const runConnectorCli = (args: string[], commandPrefix: readonly string[] = ['envar-connect']) =>
  runUnifiedCli(args, commandPrefix, true);
