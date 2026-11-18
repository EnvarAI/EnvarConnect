import test from 'node:test';
import assert from 'node:assert/strict';
import { runConnectorCli } from '../dist/connector/cli.js';
import { runUnifiedCli } from '../dist/connector/unified-cli.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivate, writePrivateJson } from '../dist/connector/files.js';

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

test('current and installed compatibility entries read the same connection without rewriting it', async t => {
  const directory=mkdtempSync(join(tmpdir(),'envar-cli-config-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const agentId=randomUUID(), connectionId=randomUUID();
  const config={version:1,origin:'https://envar.example',agentId,connectionId,framework:'hermes',
    scopes:['connection:read'],nativeConfigured:true,runtime:{home:directory,agentId:'main',cardUrl:'http://127.0.0.1:9900/card',binary:[],peerName:'envar-'+agentId,mcpName:'envar-'+agentId}};
  const file=join(directory,'connector.json'); writePrivateJson(file,config);
  writePrivate(join(directory,`credential-${connectionId}.txt`),'envar_agent_'+'a'.repeat(43));
  const before=readFileSync(file,'utf8'), calls=[], outputs=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push({url:String(url),method:options.method});
    return Response.json({id:connectionId,agent_id:agentId,mode:'inbox',status:'active'});
  });
  t.mock.method(console,'log',value=>outputs.push(JSON.parse(value)));
  const args=['status','--directory',directory,'--connection',connectionId];
  await runUnifiedCli(args); await runConnectorCli(args,['envarpay','connector']);
  assert.deepEqual(outputs[0],outputs[1]);
  assert.deepEqual(calls,Array.from({length:2},()=>({url:'https://envar.example/api/v1/agent-connections/current',method:'GET'})));
  assert.equal(readFileSync(file,'utf8'),before);
  await assert.rejects(runUnifiedCli([...args.slice(0,-1),randomUUID()]),/earlier connection/);
  assert.equal(calls.length,2);
});
