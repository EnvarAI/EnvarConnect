import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectorJournal } from '../dist/connector/state.js';
import { configureNative } from '../dist/adapters/configure-native.js';
import { parse as yaml } from 'yaml';

const previous = resolve(process.argv[2]);
assert.equal('sha512-' + createHash('sha512').update(readFileSync(previous)).digest('base64'),
  'sha512-dPfEF6BADqWlcCwTyzfC/KV6TqBFMg4QgYYnXInC+uEfXZN/KDec4U66t2YXsbVlh3lufK1VYw8EzpEgs0NkHg==', 'Use the reviewed original EnvarPay 2026.1027.2 artifact');
const root = mkdtempSync(join(tmpdir(), 'envar-connect-migration-'));
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({private:true,type:'module'}));
  execFileSync('npm', ['install', '--offline', '--cache', join(root,'empty-cache'), '--ignore-scripts', '--no-audit', '--no-fund', previous], {cwd:root,stdio:'inherit'});
  const module = name => import(pathToFileURL(join(root,'node_modules/@envarai/envarpay/dist',name)).href);
  const {ConnectorJournal:PreviousJournal} = await module('connector/state.js');
  const {configureNative:previousConfigure} = await module('adapters/configure-native.js');
  const binding={origin:'https://envar.example',agentId:randomUUID(),connectionId:randomUUID(),adapter:'hermes',cardUrl:'http://127.0.0.1:9900/.well-known/agent-card.json'};
  const path=join(root,'state','journal.sqlite3'), lock=join(root,'state','receiver.lock');
  const requestId=randomUUID(), orderId=randomUUID(), taskId=randomUUID(), claimId=randomUUID(), eventId=randomUUID();
  let old=new PreviousJournal(path,binding);
  old.orderRequest(requestId,{service_id:'original',message_id:requestId});old.saveOrderRequest(requestId,orderId);
  old.save({work:{id:taskId},phase:'report_pending',claim:{id:claimId,fence:3},reference:{adapter:'hermes',version:1,value:{task:'native-original'}},
    pendingReport:{claim:{id:claimId,fence:3},event_id:eventId,kind:'completed',text:'Original result'},afterReport:'terminal'});
  old.acquireProcessLock(lock);
  let current=new ConnectorJournal(path,binding);
  assert.throws(()=>current.acquireProcessLock(lock),/Another Connector/);current.close();old.close();
  current=new ConnectorJournal(path,binding);current.acquireProcessLock(lock);
  assert.equal(current.orderRequest(requestId,{service_id:'original',message_id:requestId}),orderId);
  const record=current.get(taskId);assert.equal(record.pendingReport.event_id,eventId);assert.equal(record.reference.value.task,'native-original');
  record.phase='terminal';delete record.pendingReport;current.save(record);current.close();
  old=new PreviousJournal(path,binding);assert.equal(old.get(taskId).phase,'terminal');assert.equal(old.orderRequest(requestId,{service_id:'original',message_id:requestId}),orderId);old.close();

  const home=join(root,'profile'), directory=join(root,'state');
  const {mkdirSync}=await import('node:fs');mkdirSync(home,{mode:0o700});
  writeFileSync(join(home,'config.yaml'),'model: owner-model\n',{mode:0o600});
  const config={version:1,origin:binding.origin,agentId:binding.agentId,connectionId:binding.connectionId,framework:'hermes',scopes:['work:read'],expiresAt:'2099-01-01T00:00:00Z',nativeConfigured:true,
    runtime:{home,agentId:'main',cardUrl:binding.cardUrl,binary:['hermes'],peerName:'envar-'+binding.agentId,mcpName:'envar-'+binding.agentId}};
  previousConfigure(directory,config);
  const token=readFileSync(join(directory,'native.token'),'utf8');
  assert.equal(configureNative(directory,config),true);
  let profile=yaml(readFileSync(join(home,'config.yaml'),'utf8'));
  const command=profile.mcp_servers[config.runtime.mcpName];assert.equal(command.args[1],'mcp');assert.ok(command.args.includes(binding.connectionId));
  assert.equal(readFileSync(join(directory,'native.token'),'utf8'),token);assert.equal(profile.model,'owner-model');
  assert.equal(configureNative(directory,config),false);
  assert.equal(previousConfigure(directory,config),true);profile=yaml(readFileSync(join(home,'config.yaml'),'utf8'));
  assert.equal(profile.mcp_servers[config.runtime.mcpName].args[1],'connector');assert.equal(readFileSync(join(directory,'native.token'),'utf8'),token);
  console.log('Original package -> Connect -> original package: journal, lock, orders, pending reports and native binding preserved');
} finally {rmSync(root,{recursive:true,force:true});}
