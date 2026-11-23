import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorJournal, normalizeConnector, readConnector, runtimeAdapter } from '../dist/connector/config.js';
import { writePrivateJson } from '../dist/connector/files.js';

function config(version, framework = 'hermes') {
  const agentId = randomUUID();
  return { version, origin:'https://envar.example', agentId, connectionId:randomUUID(), framework,
    scopes:['connection:read','work:send','work:receive','work:report'], nativeConfigured:true,
    runtime:{ home:'/native', agentId:'native-main', cardUrl:'http://127.0.0.1:9900/card', binary:[], peerName:'envar-' + agentId, mcpName:'envar-' + agentId } };
}
test('current configuration preserves its original journal binding', t => {
  const directory=mkdtempSync(join(tmpdir(),'envar-config-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for (const version of [2]) {
    const stored=config(version); stored.journalCardUrl='envar-local:original-client';
    const path=join(directory,'connector.json'); writePrivateJson(path,stored); const before=readFileSync(path,'utf8');
    const loaded=readConnector(directory), normalized=normalizeConnector(loaded);
    assert.deepEqual(loaded,stored); assert.equal(normalized.receiver.kind,'native-a2a');
    assert.equal(normalized.receiver.cardUrl,stored.runtime.cardUrl);
    assert.equal(normalized.journal.cardUrl,stored.journalCardUrl);
    const first=connectorJournal(directory,loaded); first.close();
    const second=connectorJournal(directory,readConnector(directory)); second.close();
    assert.equal(readFileSync(path,'utf8'),before);
  }
});
test('client and CLI configurations do not treat compatibility Card placeholders as native endpoints', () => {
  const client=config(2,'hermes'); client.scopes=['connection:read','work:send']; client.runtime.cardUrl='envar-local:client';
  assert.equal(normalizeConnector(client).receiver.kind,'client');
  assert.throws(()=>runtimeAdapter('/unused',client),/approved execution adapter/);
  for (const framework of ['codex','claude-code']) {
    const cli=config(2,framework); cli.runtime.cardUrl='envar-local:cli';
    cli.execution={binary:'/bin/false',workspace:'/service',timeoutSeconds:300,configurationApproved:true};
    const normalized=normalizeConnector(cli);
    assert.equal(normalized.receiver.kind,'cli'); assert.equal(normalized.receiver.adapter,framework);
    assert.equal(runtimeAdapter('/unused',cli).key,framework);
  }
  assert.throws(()=>normalizeConnector({...client,disabled:true}),/disconnected/);
});

test('retired connection formats require fresh onboarding', () => {
  assert.throws(() => normalizeConnector(config(1)), /Invalid Connector configuration/);
});
