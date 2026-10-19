import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {run} from '../cli/vault-cli.mjs';

const ticket='a'.repeat(64),origin='https://claim.example',readUrl=`${origin}/redeem/read#${ticket}`;
const args=()=>['run','--origin',origin,'--env','GH_TOKEN','--','gh','repo','view'];
test('CLI extracts fragment, uses POST header, and token enters only child environment',async()=>{
 let spawned,request;
 const environment={EXISTING:'keep'};
 const code=await run(args(),{input:readUrl,environment,fetcher:async(url,init)=>{request={url,init};return new Response('synthetic-provider-token',{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}});},spawnChild:(bin,argv,options)=>{
  spawned={bin,argv,options:{...options,env:{...options.env}}};const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;
 }});
 assert.equal(code,0);assert.equal(String(request.url),`${origin}/redeem/read`);assert.equal(request.init.method,'POST');assert.equal(request.init.headers.Authorization,`Bearer ${ticket}`);
 assert.equal(spawned.bin,'gh');assert.deepEqual(spawned.argv,['repo','view']);assert.equal(spawned.options.shell,false);assert.equal(spawned.options.env.GH_TOKEN,'synthetic-provider-token');assert.equal(environment.GH_TOKEN,undefined);
 assert.ok(!JSON.stringify(spawned.argv).includes('synthetic-provider-token'));
});
test('CLI rejects origin substitution, redirects/errors, unexpected types and env mismatches without running CLI',async()=>{
 let calls=0;
 await assert.rejects(run(args(),{input:readUrl.replace(origin,'https://evil.example'),fetcher:()=>{calls++;}}));assert.equal(calls,0);
 for(const response of [new Response('sensitive-body',{status:410}),new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),new Response('synthetic',{headers:{'Content-Type':'text/plain','X-Vault-Env':'OTHER_TOKEN'}})]) {
  await assert.rejects(run(args(),{input:readUrl,fetcher:async()=>response,spawnChild:()=>{calls++;}}),e=>!e.message.includes('sensitive-body'));
 }
 assert.equal(calls,0);
});
test('Agent can upload directly from process environment without secret in URL or MCP arguments',async()=>{
 let request;
 const code=await run(['store','--origin',origin,'--env','GH_TOKEN'],{input:`${origin}/redeem/write#${ticket}`,environment:{GH_TOKEN:'synthetic-upload'},fetcher:async(url,init)=>{request={url,init};return Response.json({stored:true});}});
 assert.equal(code,0);assert.equal(String(request.url),`${origin}/redeem/write`);assert.equal(JSON.parse(request.init.body).token,'synthetic-upload');assert.ok(!String(request.url).includes('synthetic-upload'));
});
