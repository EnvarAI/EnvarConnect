import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { onboard } from './onboarding.js';
import { connectorAgentIds } from './paths.js';
import { connectorClient, connectorDirectory, connectorJournal, readConnector, runtimeAdapter, type ConnectorConfig, type RuntimeKind } from './config.js';
import { pairDevice, platformOrigin } from './pairing.js';
import { inspectNative, configureNative } from '../adapters/configure-native.js';
import { privateDirectory, privateJson, writePrivate, writePrivateJson } from './files.js';
import { ConnectorLoop } from './loop.js';
import { connectorMcp } from './mcp.js';
import { CONNECTOR_VERSION } from './runtime-report.js';
import { supervise } from './supervisor.js';
import type { ServiceConfirmation, ServiceQuoteRequest } from './contracts.generated.js';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
export function detectRuntime(): RuntimeKind {
  const found: RuntimeKind[] = [];
  if (existsSync(join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'config.yaml'))) found.push('hermes');
  if (existsSync(join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw'), 'openclaw.json'))) found.push('openclaw');
  for (const [kind,binary] of [['codex','codex'],['claude-code','claude']] as const)
    if ((process.env.PATH ?? '').split(':').some(path=>existsSync(join(path,binary)))) found.push(kind);
  if (found.length > 1) throw new Error('Several runtimes are installed. Select this Agent explicitly with --runtime ' + found.join('|') + '.');
  return found[0] ?? 'generic-client';
}
function requestFile(file?: string): any {
  if (!file) throw new Error('Provide --file with the original JSON request and its persisted request ID.');
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 262144) throw new Error('Request file exceeds its limit.');
  return JSON.parse(text);
}

/** One parser and registry serve the current CLI and its installed compatibility entrypoints. */
export async function runUnifiedCli(args: string[], commandPrefix: readonly string[] = ['envar-connect'], compatibilityHelp = false): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime:{type:'string'}, origin:{type:'string'}, receive:{type:'boolean'}, workspace:{type:'string'}, profile:{type:'string'},
    home:{type:'string'}, 'native-agent':{type:'string'}, 'allow-local-http':{type:'boolean'}, json:{type:'boolean'},
    'approve-local-configuration':{type:'boolean'}, 'install-receiver':{type:'boolean'}, directory:{type:'string'}, agent:{type:'string'},
    'new-pairing':{type:'boolean'}, 'state-root':{type:'string'}, file:{type:'string'}, query:{type:'string'}, help:{type:'boolean',short:'h'},
    framework:{type:'string'}, 'runtime-url':{type:'string'}, connection:{type:'string'},
  } });
  const [command,operation,target] = positionals;
  let cached: { directory: string; config: ConnectorConfig; client: ReturnType<typeof connectorClient> } | undefined;
  const context = (receiving = false) => {
    if (!cached) {
      const directory = connectorDirectory(values.agent, values.directory), config = readConnector(directory);
      if (values.connection && values.connection !== config.connectionId)
        throw new Error('This native MCP process belongs to an earlier connection. Reload its configuration.');
      cached = { directory, config, client: connectorClient(directory, config) };
    }
    if (receiving && !cached.config.nativeConfigured) throw new Error('Finish connector connect before starting it');
    return cached;
  };
  const commands: Record<string, { usage: string; compatibility?: boolean; run: () => Promise<void> }> = {
    onboard: { usage:'onboard', run: async () => {
      const runtime = (!values.runtime || values.runtime === 'auto' ? detectRuntime() : values.runtime) as RuntimeKind;
      const result = await onboard({ origin: values.origin ?? 'https://envar.ai', runtime, receive: values.receive ?? false,
        stateRoot: values['state-root'] ? resolve(values['state-root']) : undefined, home: values.home, nativeAgent: values['native-agent'], workspace: values.workspace, profile: values.profile,
        allowLocalHttp: values['allow-local-http'], configurationApproved: values['approve-local-configuration'], fresh: values['new-pairing'], output: print });
      const client = connectorClient(result.directory, result.config);
      if (result.restartRequired) {
        print({ status:'native_restart_required', agent_id:result.config.agentId,
          next:'Restart the existing native gateway through its original service manager, then run envar-connect check. Do not start a second gateway.' }); return;
      }
      let supervisor: unknown = null;
      if (values['install-receiver']) {
        if (!values['approve-local-configuration']) throw new Error('Receiver installation needs --approve-local-configuration.');
        supervisor = supervise(result.directory,'install');
      }
      if (!result.config.scopes.includes('work:receive')) {
        print(await client.checkOnboarding(result.config.onboardingSession!, true)); return;
      }
      await runtimeAdapter(result.directory,result.config).probe();
      print({ status:'connected', agent_id:result.config.agentId, directory:result.directory, supervisor,
        run:[...commandPrefix,'run','--directory',result.directory],
        next:supervisor ? 'Checking the original receiver task.' : 'Keep the receiver running against its original directory; then check that connection.' });
      if (result.testApproved) print(await client.checkOnboarding(result.config.onboardingSession!,true));
      if (supervisor && result.testApproved) await waitCheck(result.directory);
    } },
    connections: { usage:'connections', run: async () => {
      print({ agents: connectorAgentIds() });
    } },
    services: { usage:'services list', run: async () => {
      if (operation !== 'list') throw new Error('Use services list.');
      print(await context().client.services(values.query ?? ''));
    } },
    orders: { usage:'orders quote|confirm|get|list|recover', run: async () => {
      const { directory, config, client } = context();
      if (operation === 'list') { print(await client.orders()); return; }
      if (operation === 'get' && target) { print(await client.order(target)); return; }
      if (operation === 'recover' && target) { print(await client.recoverOrder(target)); return; }
      if (operation === 'quote') {
        const body = requestFile(values.file) as ServiceQuoteRequest, journal=connectorJournal(directory,config);
        try {
          const old=journal.orderRequest(body.message_id,body);
          if (old) { print(await client.order(old)); return; }
          const order=await client.quoteService(body); journal.saveOrderRequest(body.message_id,order.id); print(order);
        } finally { journal.close(); }
        return;
      }
      if (operation === 'confirm' && target) { print(await client.confirmOrder(target,requestFile(values.file) as ServiceConfirmation)); return; }
      throw new Error('Use orders quote --file REQUEST.json, confirm ORDER --file CONFIRMATION.json, get ORDER, list or recover ORDER.');
    } },
    receiver: { usage:'receiver install|start|stop|status', run: async () => {
      if (!['install','start','stop','status'].includes(operation ?? '')) throw new Error('Choose receiver install, start, stop or status.');
      if (operation === 'install' && !values['approve-local-configuration']) throw new Error('Approve local service installation with --approve-local-configuration.');
      print(supervise(context().directory,operation as 'install'|'start'|'stop'|'status'));
    } },
    check: { usage:'check', run: async () => {
      const { directory, config, client } = context();
      if (!config.onboardingSession) throw new Error('This older connection uses the original Agent-page test.');
      if (config.scopes.includes('work:receive')) await runtimeAdapter(directory,config).probe();
      print(await client.checkOnboarding(config.onboardingSession,true));
      if (config.scopes.includes('work:receive')) await waitCheck(directory);
    } },
    connect: { usage:'connect --agent UUID --framework hermes|openclaw', compatibility:true, run: async () => {
      if (!values.agent || !['hermes', 'openclaw'].includes(values.framework ?? '')) throw new Error('Choose the Agent ID and its Hermes/OpenClaw platform');
      const directory = connectorDirectory(values.agent, values.directory), framework = values.framework as 'hermes' | 'openclaw';
      const origin = platformOrigin(values.origin ?? 'https://envar.ai', values['allow-local-http']);
      privateDirectory(directory);
      const native = inspectNative(framework, { home: values.home, nativeAgent: values['native-agent'], cardUrl: values['runtime-url'] });
      const file = join(directory, 'connector.json');
      let config = existsSync(file) ? privateJson<ConnectorConfig>(file) : undefined;
      if (config && (config.agentId !== values.agent || config.framework !== framework || config.origin !== origin ||
        config.runtime.home !== native.home || config.runtime.agentId !== native.agentId || config.runtime.cardUrl !== native.cardUrl))
        throw new Error('This Connector directory already belongs to another Agent/runtime. Preserve it and select another directory.');
      if (!config || config.disabled || values['new-pairing']) {
        const receipt = await pairDevice({ origin, agentId: values.agent, framework, runtimeVersion: native.runtimeVersion, directory,
          fresh: Boolean(config?.disabled || values['new-pairing']),
          onApproval: details => print({ action:'approve_in_browser', ...details,
            next:'Open the Envar link, match this short code and Agent name, then approve the device.' }),
        });
        writePrivate(join(directory, `credential-${receipt.connection_id}.txt`), receipt.token + '\n');
        config = { version:1, origin, agentId:receipt.agent_id, connectionId:receipt.connection_id, framework,
          scopes:receipt.scopes, expiresAt:receipt.expires_at, allowLocalHttp:values['allow-local-http'] ?? false,
          nativeConfigured:false, runtime:{ home:native.home, configFile:native.configFile, port:native.port, agentId:native.agentId, cardUrl:native.cardUrl,
            binary:native.binary, peerName:'envar-' + receipt.agent_id, mcpName:'envar-' + receipt.agent_id } };
        writePrivateJson(file, config);
      }
      const status = await connectorClient(directory, config).status();
      const restartRequired = configureNative(directory, config); config.nativeConfigured = true; writePrivateJson(file, config);
      print({ status:'configured', agent_id:config.agentId, directory, restart_required:restartRequired, receiver_online:status.readiness.online === true,
        next:restartRequired ? 'Restart the existing native gateway using its normal deployment method when ready. Then keep the Connector running.' : 'Configuration is unchanged. Keep the Connector running and test it from the Agent page.',
        native_profile_env:framework === 'hermes' ? { HERMES_HOME:config.runtime.home } : { OPENCLAW_STATE_DIR:config.runtime.home, OPENCLAW_CONFIG_PATH:config.runtime.configFile },
        service_restart:[...config.runtime.binary,'gateway','restart'], foreground_gateway:[...config.runtime.binary,'gateway','run'],
        docker_restart:'Restart the Agent container from its Docker host; do not run a second gateway.',
        run:[...commandPrefix,'run','--directory',directory], test:config.origin + '/console/agents/' + config.agentId,
        verified:status.readiness.roundtrip_verified === true && !restartRequired, expires_at:config.expiresAt });
    } },
    run: { usage:'run --agent UUID', compatibility:true, run: async () => {
      const { directory, config, client } = context(true), journal = connectorJournal(directory, config);
      journal.acquireProcessLock(join(directory,'receiver.lock'));
      const runtime=runtimeAdapter(directory,config), controller=new AbortController();
      process.once('SIGTERM',()=>controller.abort()); process.once('SIGINT',()=>controller.abort());
      print({ status:'starting', agent_id:config.agentId, connection_id:config.connectionId,
        next:'Keep this process and the native gateway running. Status in Envar updates after contact and a real test.' });
      try { await new ConnectorLoop(client,runtime,journal).run(controller.signal,error=>{
        console.error(error instanceof Error ? error.message : 'Connector request failed; original work is preserved');
      }); } finally { await runtime.close(); journal.close(); }
    } },
    doctor: { usage:'doctor --agent UUID', compatibility:true, run: async () => {
      const { directory, config, client } = context(), connection=await client.status(), runtime=await runtimeAdapter(directory,config).probe();
      const reporting=await client.reportRuntime(runtime);
      print({ connection_id:connection.id, agent_id:connection.agent_id, connector_version:CONNECTOR_VERSION, runtime,
        runtime_version_source:runtime.versionSource ?? 'agent_card', diagnostic_reporting:reporting,
        readiness:connection.readiness, next:'Send the free test from the Envar Agent page and inspect its returned result.' });
    } },
    status: { usage:'status --agent UUID', compatibility:true, run: async () => { print(await context().client.status()); } },
    disconnect: { usage:'disconnect --agent UUID', compatibility:true, run: async () => {
      const { directory, config, client }=context(), receipt=await client.disconnect();
      if (!receipt.credential_revoked) throw new Error('Envar did not confirm revocation');
      config.disabled=true; writePrivateJson(join(directory,'connector.json'),config);
      print({ status:'disconnected', ...receipt, journal_preserved:true,
        next:'Stop this Connector process. Already admitted native tasks keep their original outcome; inspect them in Envar.' });
    } },
    mcp: { usage:'mcp --agent UUID', compatibility:true, run: async () => {
      const { directory, config, client }=context(true), journal=connectorJournal(directory,config), server=connectorMcp(client,journal,config.scopes);
      const close=async()=>{ await server.close(); journal.close(); };
      process.once('SIGTERM',()=>{void close().finally(()=>process.exit(0));}); process.once('SIGINT',()=>{void close().finally(()=>process.exit(0));});
      await server.connect(new StdioServerTransport());
    } },
  };
  const entries=Object.values(commands), legacy=entries.filter(entry=>entry.compatibility);
  if (!command || command === 'help' || values.help) {
    if (compatibilityHelp || commands[command]?.compatibility) {
      console.log(['Envar Connector',...legacy.map(entry=>commandPrefix.join(' ') + ' ' + entry.usage),
        'Advanced: use --directory PATH for an existing private state directory. Keep its journal to recover original tasks.'].join('\n'));
    } else print({ commands:entries.filter(entry=>!entry.compatibility).map(entry=>entry.usage), existing_connections:legacy.map(entry=>entry.usage),
      next:'Start with onboard --runtime auto --json. Add --receive and a reviewed --workspace only to offer services.' });
    return;
  }
  if (!Object.hasOwn(commands,command)) throw new Error('Choose ' + Object.keys(commands).join(', ') + '.');
  await commands[command]!.run();
}
async function waitCheck(directory:string) {
  const config=readConnector(directory),client=connectorClient(directory,config),deadline=Date.now()+65000;
  while (Date.now()<deadline) {
    const value=await client.checkOnboarding(config.onboardingSession!);
    if (value.status !== 'checking') { print(value); return; }
    await sleep(2000);
  }
  print({ status:'checking',next:'Run envar-connect check again to read the same original task. No replacement was submitted.' });
}
