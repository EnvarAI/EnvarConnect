import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {CliRuntimeAdapter,cliCommand} from '../dist/adapters/cli-runtime.js';
import {privateJson} from '../dist/connector/files.js';

test('CLI runner executes once and completed output survives an adapter restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-cli-'));mkdirSync(join(dir,'workspace'));
 const binary=join(dir,'native');const count=join(dir,'count');
 writeFileSync(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex 0.145.0');process.exit(0)}fs.appendFileSync(${JSON.stringify(count)},'run\\n');process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'actual result'}}));console.log(JSON.stringify({type:'turn.completed'}));});\n`,{mode:0o700});
 const config={binary,workspace:join(dir,'workspace'),timeoutSeconds:20,configurationApproved:true};
 const adapter=new CliRuntimeAdapter(dir,'codex',config),id=randomUUID(),work={id,request:{message:'do work'}};
 const first=await adapter.start(work,id);assert.equal(first.state,'working');
 let value;
 for(let n=0;n<100;n++){await sleep(50);value=await adapter.observe(first.reference);if(value.state==='completed')break;}
 assert.equal(value.state,'completed');assert.equal(value.text,'actual result');
 const again=new CliRuntimeAdapter(dir,'codex',config);assert.equal((await again.start(work,id)).state,'completed');
 assert.equal(readFileSync(count,'utf8'),'run\n');
 await assert.rejects(again.start({...work,request:{message:'different'}},id));
 assert.equal(privateJson(join(dir,'executions',id,'result.json')).key,id);
});

test('CLI flags preserve an isolated workspace and no shell interpolation',()=>{
 const config={binary:'/bin/codex',workspace:'/tmp/service',timeoutSeconds:20,configurationApproved:true};
 const args=cliCommand('codex',config,'/tmp/service/order');
 assert.ok(args.includes('--cd'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.equal(args.at(-1),'-');
 const claude=cliCommand('claude-code',config,'/tmp/service/order');assert.ok(claude.includes('--strict-mcp-config'));assert.equal(claude[claude.indexOf('--tools')+1],'');
});

test('ambiguous intent never spawns another native process',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-intent-'));mkdirSync(join(dir,'workspace'));
 const config={binary:'/bin/false',workspace:join(dir,'workspace'),timeoutSeconds:20,configurationApproved:true};
 const id=randomUUID(),folder=join(dir,'executions',id);mkdirSync(folder,{recursive:true,mode:0o700});
 writeFileSync(join(folder,'intent.json'),'{}',{mode:0o600});
 const adapter=new CliRuntimeAdapter(dir,'codex',config);
 await assert.rejects(adapter.start({id,request:{message:'x'}},id));
 assert.ok(!existsSync(join(folder,'result.json')));
});

test('relay v2 projects the original CLI execution without inventing a native HTTP URL',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-relay-cli-'));mkdirSync(join(dir,'workspace'));
 const binary=join(dir,'native');writeFileSync(binary,`#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('Claude 2.1.241');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'relay actual result'})));\n`,{mode:0o700});
 const config={binary,workspace:join(dir,'workspace'),timeoutSeconds:20,configurationApproved:true};
 const adapter=new CliRuntimeAdapter(dir,'claude-code',config),workId=randomUUID(),contextId=randomUUID();
 const result=await adapter.relay.send({message:{messageId:'public-message',parts:[{text:'original text'}]}},{workId,contextId});
 assert.equal(adapter.relay.version,'2');assert.equal(result.reference.kind,'local_cli_execution');assert.equal(result.reference.task_id,workId);
 assert.ok(!('origin'in result.reference));let snapshot;
 for(let n=0;n<100;n++){await sleep(50);try{snapshot=await adapter.relay.read(result.reference);}catch{continue;}if(snapshot.status.state==='TASK_STATE_COMPLETED')break;}
 assert.equal(snapshot.id,workId);assert.equal(snapshot.contextId,contextId);assert.equal(snapshot.artifacts[0].parts[0].text,'relay actual result');
 await assert.rejects(adapter.relay.read({...result.reference,binding_digest:'different'}));
});
