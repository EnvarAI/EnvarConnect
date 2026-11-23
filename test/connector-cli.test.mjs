import test from 'node:test';
import assert from 'node:assert/strict';
import { SocketTransport } from '../dist/connector/transport.js';
import { runUnifiedCli } from '../dist/connector/unified-cli.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivate, writePrivateJson } from '../dist/connector/files.js';

test('CLI reads its current connection over WebSocket without rewriting its identity', async t => {
  const directory=mkdtempSync(join(tmpdir(),'envar-cli-config-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const agentId=randomUUID(), connectionId=randomUUID();
  const config={version:2,origin:'https://envar.example',agentId,connectionId,framework:'hermes',
    scopes:['connection:read'],nativeConfigured:true,runtime:{home:directory,agentId:'main',cardUrl:'http://127.0.0.1:9900/card',binary:[],peerName:'envar-'+agentId,mcpName:'envar-'+agentId}};
  const file=join(directory,'connector.json'); writePrivateJson(file,config);
  writePrivate(join(directory,`credential-${connectionId}.txt`),'envar_agent_'+'a'.repeat(43));
  const before=readFileSync(file,'utf8'), calls=[], outputs=[];
  t.mock.method(SocketTransport.prototype,'call',async (method)=>{
    calls.push({method});
    return {id:connectionId,agent_id:agentId,mode:'inbox',status:'active'};
  });
  t.mock.method(console,'log',value=>outputs.push(JSON.parse(value)));
  const args=['status','--directory',directory,'--connection',connectionId];
  await runUnifiedCli(args); await runUnifiedCli(args);
  assert.deepEqual(outputs[0],outputs[1]);
  assert.deepEqual(calls,Array.from({length:2},()=>({method:'get_connection'})));
  assert.equal(readFileSync(file,'utf8'),before);
  await assert.rejects(runUnifiedCli([...args.slice(0,-1),randomUUID()]),/earlier connection/);
  assert.equal(calls.length,2);
});
