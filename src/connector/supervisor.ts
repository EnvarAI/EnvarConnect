/** Only this owner's generated Envar service is managed; native gateways are untouched. */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConnector } from './config.js';

const xml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const systemd = (s: string) => '"' + s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$','$$') + '"';
export function serviceDefinition(directory: string, platform = process.platform) {
  const config = readConnector(directory);
  if (!config.scopes.includes('work:receive')) throw new Error('This connection has no receiving permission.');
  const name = 'ai.envar.receiver.' + config.agentId, cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const args = [process.execPath, cli, 'run', '--directory', directory];
  if (platform === 'darwin') return { name, path: join(homedir(), 'Library', 'LaunchAgents', name + '.plist'),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by EnvarConnect: ${config.connectionId} -->\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string><key>ENVAR_SUPERVISED_RECEIVER</key><string>1</string></dict></dict></plist>\n` };
  if (platform === 'linux') return { name, path: join(homedir(), '.config', 'systemd', 'user', name + '.service'),
    content: `# Managed by EnvarConnect: ${config.connectionId}\n[Unit]\nDescription=Envar Agent receiver\n[Service]\nType=simple\nExecStart=${args.map(systemd).join(' ')}\nEnvironment=${systemd('PATH=' + (process.env.PATH ?? '/usr/bin:/bin'))}\nEnvironment=ENVAR_SUPERVISED_RECEIVER=1\nRestart=on-failure\nRestartSec=30\n[Install]\nWantedBy=default.target\n` };
  throw new Error('No verified service manager for this environment. Run the receiver in the foreground; background receiving is not verified.');
}
export function supervise(directory: string, action: 'install'|'start'|'stop'|'status') {
  const definition = serviceDefinition(directory), config = readConnector(directory);
  const run = (binary: string, args: string[]) => execFileSync(binary, args, { stdio: 'pipe', timeout: 15000, maxBuffer: 65536 });
  if (action === 'install') {
    if (existsSync(definition.path) && readFileSync(definition.path, 'utf8') !== definition.content)
      throw new Error('The existing service definition differs. Inspect it before changing the original receiver.');
    mkdirSync(join(definition.path, '..'), { recursive: true });
    if (!existsSync(definition.path)) writeFileSync(definition.path, definition.content, { flag: 'wx', mode: 0o600 });
  } else if (!existsSync(definition.path) || !readFileSync(definition.path, 'utf8').includes('Managed by EnvarConnect: ' + config.connectionId))
    throw new Error('No matching owner-managed Envar receiver service.');
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid!()}`, target = domain + '/' + definition.name;
    if (action === 'status') { run('launchctl', ['print',target]); return { managed: true, status: 'loaded' }; }
    if (action === 'stop') run('launchctl',['bootout',target]);
    else { try { run('launchctl',['print',target]); } catch { run('launchctl',['bootstrap',domain,definition.path]); } }
  } else {
    if (action === 'install') run('systemctl',['--user','daemon-reload']);
    run('systemctl',['--user', ...(action === 'install' ? ['enable','--now',definition.name] : [action === 'status' ? 'is-active' : action,definition.name])]);
  }
  return { managed: true, status: action === 'stop' ? 'stopped' : 'started', autostart: 'user-session' };
}
