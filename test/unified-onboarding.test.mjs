import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {onboard} from '../dist/connector/onboarding.js';

test('UUID-free enrollment prints only owner instructions and stores one binding',async()=>{
 const root=mkdtempSync(join(tmpdir(),'envar-onboard-')),session=randomUUID(),agent=randomUUID(),connection=randomUUID();
 const outputs=[];let body,secret;
 const fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/sessions')){body=JSON.parse(options.body);secret=options.headers.Authorization;
   return Response.json({session_id:session,user_code:'ABCD-EFGH',verification_uri:'https://envar.ai/connect/onboard?code=ABCD-EFGH',expires_at:new Date(Date.now()+60000).toISOString(),interval:2});}
  assert.equal(options.headers.Authorization,secret);
  if(path.endsWith('/current'))return Response.json({status:'approved',session_id:session});
  return Response.json({version:2,session_id:session,agent_id:agent,connection_id:connection,runtime:'generic-client',binding_digest:body.binding_digest,platform_origin:'https://envar.ai',token:'envar_agent_'+'a'.repeat(43),scopes:['connection:read','work:read','work:send'],expires_at:new Date(Date.now()+86400000).toISOString(),test_consent_until:null});
 };
 const result=await onboard({origin:'https://envar.ai',runtime:'generic-client',receive:false,stateRoot:root,fetch,output:v=>outputs.push(v)});
 assert.equal(result.config.agentId,agent);assert.ok(!('agent_id'in body));
 const printed=JSON.stringify(outputs);assert.ok(!printed.includes('envar_agent_'));assert.ok(!printed.includes('envar_onboard_'));
 assert.ok(result.config.nativeConfigured);assert.equal(readdirSync(join(root,'connectors')).length,1);
 assert.match(readFileSync(join(result.directory,`credential-${connection}.txt`),'utf8'),/^envar_agent_/);
});

test('approval URL cannot redirect device enrollment to another origin',async()=>{
 const root=mkdtempSync(join(tmpdir(),'envar-bad-origin-'));
 await assert.rejects(onboard({origin:'https://envar.ai',runtime:'generic-client',receive:false,stateRoot:root,output:()=>{},
 fetch:async()=>Response.json({session_id:randomUUID(),user_code:'ABCD-EFGH',verification_uri:'https://evil.example/connect/onboard?code=ABCD-EFGH',expires_at:new Date(Date.now()+60000).toISOString(),interval:2})}),/selected Envar origin/);
});

test('enabling receiving retains the original client journal even when native endpoint changes',async()=>{
 const {connectorJournal}=await import('../dist/connector/config.js');
 const {writePrivateJson,writePrivate}=await import('../dist/connector/files.js');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'envar-upgrade-')),home=join(root,'native'),bin=join(root,'bin');mkdirSync(home,{mode:0o700});mkdirSync(bin);
 writeFileSync(join(home,'config.yaml'),'model: original-model\n',{mode:0o600});writeFileSync(join(home,'.env'),'\n',{mode:0o600});
 writeFileSync(join(bin,'hermes'),'#!/bin/sh\necho Hermes 1.2.3\n',{mode:0o700});
 const agent=randomUUID(),connection=randomUUID(),directory=join(root,'connectors',agent),session=randomUUID();
 const old={version:2,origin:'https://envar.ai',agentId:agent,connectionId:connection,framework:'hermes',scopes:['connection:read','work:read','work:send'],bindingDigest:'old',nativeConfigured:true,runtime:{home:directory,agentId:agent,cardUrl:'envar-local:original-client',binary:[],peerName:'envar-'+agent,mcpName:'envar-'+agent}};
 writePrivateJson(join(directory,'connector.json'),old);writePrivate(join(directory,`credential-${connection}.txt`),'envar_agent_'+'a'.repeat(43));
 const key=randomUUID(),order=randomUUID(),body={input:'original'};let journal=connectorJournal(directory,old);journal.orderRequest(key,body);journal.saveOrderRequest(key,order);journal.close();
 let request;
 const fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/sessions')){request=JSON.parse(options.body);return Response.json({session_id:session,user_code:'ABCD-EFGH',verification_uri:'https://envar.ai/connect/onboard?code=ABCD-EFGH',expires_at:new Date(Date.now()+60000).toISOString(),interval:2});}
  if(path.endsWith('/current'))return Response.json({session_id:session,status:'approved'});
  return Response.json({version:2,session_id:session,agent_id:agent,connection_id:connection,runtime:'hermes',binding_digest:request.binding_digest,platform_origin:'https://envar.ai',token:'envar_agent_'+'b'.repeat(43),scopes:[...old.scopes,'work:receive','work:report'],expires_at:new Date(Date.now()+86400000).toISOString(),test_consent_until:null});
 };
 const path=process.env.PATH;process.env.PATH=bin+':'+path;
 try{
  const result=await onboard({origin:'https://envar.ai',runtime:'hermes',receive:true,configurationApproved:true,home,stateRoot:root,fetch,output:()=>{}});
  assert.equal(result.config.agentId,agent);assert.equal(result.config.connectionId,connection);
  assert.notEqual(result.config.runtime.cardUrl,old.runtime.cardUrl);assert.equal(result.config.journalCardUrl,old.runtime.cardUrl);
  journal=connectorJournal(directory,result.config);assert.equal(journal.orderRequest(key,body),order);journal.close();
  assert.ok(readdirSync(directory).some(f=>f.startsWith('client-before-receiving-')));
 }finally{process.env.PATH=path;}
});
