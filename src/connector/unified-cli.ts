import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { onboard } from './onboarding.js';
import { connectorClient, connectorDirectory, connectorJournal, readConnector, runtimeAdapter, type ConnectorConfig, type RuntimeKind } from './config.js';
import { writePrivateJson } from './files.js';
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

/** One CLI for onboarding and WebSocket-connected Agents. */
export async function runUnifiedCli(args: string[]): Promise<void> {
  const commandPrefix = ['envar-connect'];
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'service-profile':{type:'string'}, runtime:{type:'string'}, origin:{type:'string'}, receive:{type:'boolean'}, workspace:{type:'string'}, profile:{type:'string'},
    home:{type:'string'}, 'native-agent':{type:'string'}, 'allow-local-http':{type:'boolean'}, json:{type:'boolean'},
    'approve-local-configuration':{type:'boolean'}, 'install-receiver':{type:'boolean'}, directory:{type:'string'}, agent:{type:'string'},
    'new-pairing':{type:'boolean'}, file:{type:'string'}, query:{type:'string'}, help:{type:'boolean',short:'h'},
    connection:{type:'string'},
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
    if (receiving && !cached.config.nativeConfigured) throw new Error('Finish onboarding before starting the receiver');
    return cached;
  };
  const commands: Record<string, { usage: string; run: () => Promise<void> }> = {
    onboard: { usage:'onboard', run: async () => {
      const runtime = (!values.runtime || values.runtime === 'auto' ? detectRuntime() : values.runtime) as RuntimeKind;
      const result = await onboard({ origin: values.origin ?? 'https://envar.ai', runtime, receive: values.receive ?? false,
        home: values.home, nativeAgent: values['native-agent'], workspace: values.workspace, profile: values.profile, serviceProfile: values['service-profile'],
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
      print({ status:'connected', agent_id:result.config.agentId, supervisor,
        next:supervisor ? 'Checking the original receiver task.' : `Keep ${commandPrefix.join(' ')} run --agent ${result.config.agentId} running; then run envar-connect check.` });
      if (result.testApproved) print(await client.checkOnboarding(result.config.onboardingSession!,true));
      if (supervisor && result.testApproved) await waitCheck(result.directory);
    } },
    connections: { usage:'connections', run: async () => {
      const root=join(homedir(),'.envar','connectors');
      print({ agents:existsSync(root)?readdirSync(root).filter(id=>/^[0-9a-f-]{36}$/.test(id)):[] });
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
    run: { usage:'run --agent UUID', run: async () => {
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
    doctor: { usage:'doctor --agent UUID', run: async () => {
      const { directory, config, client } = context(), connection=await client.status(), runtime=await runtimeAdapter(directory,config).probe();
      const reporting=await client.reportRuntime(runtime);
      print({ connection_id:connection.id, agent_id:connection.agent_id, connector_version:CONNECTOR_VERSION, runtime,
        runtime_version_source:runtime.versionSource ?? 'agent_card', diagnostic_reporting:reporting,
        readiness:connection.readiness, next:'Send the free test from the Envar Agent page and inspect its returned result.' });
    } },
    status: { usage:'status --agent UUID', run: async () => { print(await context().client.status()); } },
    disconnect: { usage:'disconnect --agent UUID', run: async () => {
      const { directory, config, client }=context(), receipt=await client.disconnect();
      if (!receipt.credential_revoked) throw new Error('Envar did not confirm revocation');
      config.disabled=true; writePrivateJson(join(directory,'connector.json'),config);
      print({ status:'disconnected', ...receipt, journal_preserved:true,
        next:'Stop this Connector process. Already admitted native tasks keep their original outcome; inspect them in Envar.' });
    } },
    mcp: { usage:'mcp --agent UUID', run: async () => {
      const { directory, config, client }=context(true), journal=connectorJournal(directory,config), server=connectorMcp(client,journal,config.scopes);
      const close=async()=>{ await server.close(); client.close(); journal.close(); };
      process.once('SIGTERM',()=>{void close().finally(()=>process.exit(0));}); process.once('SIGINT',()=>{void close().finally(()=>process.exit(0));});
      await server.connect(new StdioServerTransport());
    } },
  };
  if (!command || command === 'help' || values.help) {
    print({ commands:Object.values(commands).map(entry=>entry.usage),
      next:'Start with onboard --runtime auto --json. Add --receive and a reviewed --workspace to offer services.' });
    return;
  }
  if (!Object.hasOwn(commands,command)) throw new Error('Choose ' + Object.keys(commands).join(', ') + '.');
  try { await commands[command]!.run(); } finally { if (command !== 'mcp') cached?.client.close(); }
}
async function waitCheck(directory:string) {
  const config=readConnector(directory),client=connectorClient(directory,config);
  try { print(await client.waitResult(() => client.checkOnboarding(config.onboardingSession!),
    value => value.status !== 'checking', 65)); } finally { client.close(); }
}
