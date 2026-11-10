import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { onboard } from './onboarding.js';
import { connectorClient, connectorDirectory, connectorJournal, readConnector, runtimeAdapter, type RuntimeKind } from './config.js';
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
export async function runUnifiedCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime:{type:'string'}, origin:{type:'string'}, receive:{type:'boolean'}, workspace:{type:'string'}, profile:{type:'string'},
    home:{type:'string'}, 'native-agent':{type:'string'}, 'allow-local-http':{type:'boolean'}, json:{type:'boolean'},
    'approve-local-configuration':{type:'boolean'}, 'install-receiver':{type:'boolean'}, directory:{type:'string'}, agent:{type:'string'},
    'new-pairing':{type:'boolean'}, file:{type:'string'}, query:{type:'string'}, help:{type:'boolean'},
  } });
  const [command,operation,target] = positionals;
  if (values.help) { print({ commands:['onboard','services list','orders quote|confirm|get|list|recover','receiver install|start|stop|status','check'],
    next:'Start with onboard --runtime auto --json. Add --receive and a reviewed --workspace only to offer services.' }); return; }
  if (command === 'onboard') {
    const runtime = (!values.runtime || values.runtime === 'auto' ? detectRuntime() : values.runtime) as RuntimeKind;
    const result = await onboard({ origin: values.origin ?? 'https://envar.ai', runtime, receive: values.receive ?? false,
      home: values.home, nativeAgent: values['native-agent'], workspace: values.workspace, profile: values.profile,
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
      next:supervisor ? 'Checking the original receiver task.' : `Keep envar-connect run --agent ${result.config.agentId} running; then run envar-connect check.` });
    if (result.testApproved) print(await client.checkOnboarding(result.config.onboardingSession!,true));
    if (supervisor && result.testApproved) await waitCheck(result.directory);
    return;
  }
  if (command === 'connections') {
    const root=join(homedir(),'.envarpay','connectors');
    print({ agents:existsSync(root)?readdirSync(root).filter(id=>/^[0-9a-f-]{36}$/.test(id)):[] });return;
  }
  const directory=connectorDirectory(values.agent,values.directory), config=readConnector(directory), client=connectorClient(directory,config);
  if (command === 'receiver') {
    if (!['install','start','stop','status'].includes(operation ?? '')) throw new Error('Choose receiver install, start, stop or status.');
    if (operation === 'install' && !values['approve-local-configuration']) throw new Error('Approve local service installation with --approve-local-configuration.');
    print(supervise(directory,operation as 'install'|'start'|'stop'|'status'));return;
  }
  if (command === 'check') {
    if (!config.onboardingSession) throw new Error('This older connection uses the original Agent-page test.');
    if (config.scopes.includes('work:receive')) await runtimeAdapter(directory,config).probe();
    print(await client.checkOnboarding(config.onboardingSession,true));
    if (config.scopes.includes('work:receive')) await waitCheck(directory);return;
  }
  if (command === 'services' && operation === 'list') { print(await client.services(values.query ?? ''));return; }
  if (command !== 'orders') throw new Error('Choose onboard, services, orders, receiver or check.');
  if (operation === 'list') { print(await client.orders());return; }
  if (operation === 'get' && target) { print(await client.order(target));return; }
  if (operation === 'recover' && target) { print(await client.recoverOrder(target));return; }
  if (operation === 'quote') {
    const body = requestFile(values.file) as ServiceQuoteRequest, journal=connectorJournal(directory,config);
    try { const old=journal.orderRequest(body.message_id,body);
      if (old) { print(await client.order(old));return; }
      const order=await client.quoteService(body);journal.saveOrderRequest(body.message_id,order.id);print(order);
    } finally { journal.close(); } return;
  }
  if (operation === 'confirm' && target) { print(await client.confirmOrder(target,requestFile(values.file) as ServiceConfirmation));return; }
  throw new Error('Use orders quote --file REQUEST.json, confirm ORDER --file CONFIRMATION.json, get ORDER, list or recover ORDER.');
}
async function waitCheck(directory:string) {
  const config=readConnector(directory),client=connectorClient(directory,config),deadline=Date.now()+65000;
  while (Date.now()<deadline) {
    const value=await client.checkOnboarding(config.onboardingSession!);
    if (value.status !== 'checking') { print(value);return; }
    await sleep(2000);
  }
  print({ status:'checking',next:'Run envar-connect check again to read the same original task. No replacement was submitted.' });
}
