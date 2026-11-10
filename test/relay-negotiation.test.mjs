import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EnvarWorkClient, WorkApiError} from '../dist/connector/client.js';

for (const supported of [undefined, false, true]) {
  test(`relay negotiation requires explicit authenticated server support: ${supported}`, async () => {
    const paths = [];
    const client = new EnvarWorkClient('https://envar.test','envar_agent_'+'a'.repeat(48), {fetch: async input => {
      const path = new URL(input).pathname; paths.push(path);
      if (path === '/api/v1/agent-connections/current') return Response.json({id:randomUUID(),agent_id:randomUUID(),mode:'inbox',status:'active',platform:'hermes',revision:1,readiness:{},...(supported===undefined?{}:{protocol_support:{a2a_relay_v1:supported}})});
      assert.equal(path,'/api/v1/connector/a2a-relay/hello'); return Response.json({relay_version:'1'});
    }});
    assert.equal(await client.relayHello('b'.repeat(64)), supported === true);
    assert.equal(paths.length, supported === true ? 2 : 1);
  });
}
for (const endpoint of ['status','hello']) {
  test(`negotiation preserves authorization failure at ${endpoint}`, async () => {
    const client = new EnvarWorkClient('https://envar.test','envar_agent_'+'a'.repeat(48), {fetch: async input => {
      const path=new URL(input).pathname;
      if (path.endsWith('/current') && endpoint !== 'status') return Response.json({id:randomUUID(),agent_id:randomUUID(),mode:'inbox',status:'active',platform:'hermes',revision:1,readiness:{},protocol_support:{a2a_relay_v1:true}});
      return Response.json({error:'permission_denied'},{status:403});
    }});
    await assert.rejects(() => client.relayHello('b'.repeat(64)), error => error instanceof WorkApiError && error.status===403);
  });
}
