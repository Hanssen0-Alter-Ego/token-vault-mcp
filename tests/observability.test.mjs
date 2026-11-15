import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import worker from '../dist/worker.mjs';
import {testDB} from './d1.mjs';

test('Worker logs only fixed route labels, status and duration, never secret-bearing inputs',async()=>{
 const env={DB:testDB(),PUBLIC_ORIGIN:'https://vault.example',VAULT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),MCP_ACCESS_KEY:randomBytes(32).toString('hex')};
 const logs=[],previous=console.log;console.log=value=>logs.push(value);
 try {
  for(const [path,route,status] of [[`/mcp/${env.MCP_ACCESS_KEY}`,'mcp',200],['/redeem/read','redeem_read',410],['/redeem/write','redeem_write',410],['/unknown-private-path','other',404],['/health?private_query','health',400]]){
   const response=await worker.fetch(new Request(env.PUBLIC_ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-private-header','X-Vault-Verifier':'synthetic-verifier'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping',private:'synthetic-private-body'})}),env);
   assert.equal(response.status,status);
   const log=logs.at(-1);
   assert.deepEqual(Object.keys(log).sort(),['duration_ms','event','route','status']);
   assert.equal(log.event,'vault_request');assert.equal(log.route,route);assert.equal(log.status,status);assert.ok(Number.isFinite(log.duration_ms)&&log.duration_ms>=0);
  }
 }finally{console.log=previous;}
 for(const secret of [env.MCP_ACCESS_KEY,env.VAULT_ENCRYPTION_KEY,'private_query','unknown-private-path','synthetic-private-header','synthetic-verifier','synthetic-private-body'])assert.ok(!JSON.stringify(logs).includes(secret));
});

test('Wrangler enables custom logs without raw invocation logs or traces',async()=>{
 const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
 assert.equal(config.observability.enabled,true);
 assert.equal(config.observability.logs.enabled,true);
 assert.equal(config.observability.logs.invocation_logs,false);
 assert.equal(config.observability.traces.enabled,false);
});
