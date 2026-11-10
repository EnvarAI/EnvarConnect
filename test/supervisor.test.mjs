import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writePrivateJson} from '../dist/connector/files.js';
import {serviceDefinition} from '../dist/connector/supervisor.js';

test('generated services contain no credential and only invoke this connection journal',()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-supervisor-')),id=randomUUID(),connection=randomUUID();
 writePrivateJson(join(dir,'connector.json'),{version:2,origin:'https://envar.ai',agentId:id,connectionId:connection,framework:'codex',scopes:['connection:read','work:receive'],nativeConfigured:true,runtime:{home:dir,agentId:id,cardUrl:'envar-local:test',binary:[],peerName:'envar-'+id,mcpName:'envar-'+id}});
 for(const platform of ['darwin','linux']){const d=serviceDefinition(dir,platform);assert.ok(d.content.includes(dir));assert.ok(d.content.includes('ENVAR_SUPERVISED_RECEIVER'));assert.ok(!d.content.includes('envar_agent_'));assert.ok(!d.content.includes('sudo'));}
});
