import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {stat,readFile,access,writeFile,chmod,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {run} from '../cli/vault-cli.mjs';
import {prepare} from './proof.mjs';
const ticket='a'.repeat(64),origin='https://claim.example',readUrl=`${origin}/redeem/read#${ticket}`;
const args=state=>['run','--origin',origin,'--env','GH_TOKEN','--state',state,'--','gh','repo','view'];
test('prepare generates private random state and prints only the public S256 challenge',async t=>{
 const first=await prepare(t),second=await prepare(t);
 const state=JSON.parse(await readFile(first.statePath,'utf8'));
 assert.equal(state.verifier.length,43);assert.notEqual(first.claimChallenge,second.claimChallenge);
 assert.equal(first.claimChallenge,createHash('sha256').update(state.verifier).digest('base64url'));
 assert.ok(!first.output.includes(state.verifier));assert.equal((await stat(first.statePath)).mode&0o777,0o600);
 await assert.rejects(run(['prepare','--origin',origin,'--env','GH_TOKEN','--state',first.statePath]));
});
test('CLI sends verifier only in header, cleans state before child and injects only provider token',async t=>{
 const proof=await prepare(t);let spawned,request;
 const secret=JSON.parse(await readFile(proof.statePath,'utf8')).verifier,environment={EXISTING:'keep'};
 const code=await run(args(proof.statePath),{input:readUrl,environment,fetcher:async(url,init)=>{request={url,init};return new Response('synthetic-provider-token',{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}});},spawnChild:(bin,argv,options)=>{
  assert.equal(existsSync(proof.statePath),false);
  spawned={bin,argv,options:{...options,env:{...options.env}}};const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;
 }});
 assert.equal(code,0);assert.equal(String(request.url),`${origin}/redeem/read`);assert.equal(request.init.method,'POST');assert.equal(request.init.headers.Authorization,`Bearer ${ticket}`);assert.equal(request.init.headers['X-Vault-Verifier'],secret);
 assert.equal(spawned.bin,'gh');assert.deepEqual(spawned.argv,['repo','view']);assert.equal(spawned.options.shell,false);assert.equal(spawned.options.env.GH_TOKEN,'synthetic-provider-token');assert.equal(environment.GH_TOKEN,undefined);
 assert.ok(!JSON.stringify(spawned).includes(secret));assert.ok(!String(request.url).includes(secret));await assert.rejects(access(proof.statePath));
});
test('CLI refuses substituted origin and unsafe/mismatched/stale state before network access',async t=>{
 const proof=await prepare(t);let calls=0;const fetcher=()=>{calls++;throw new Error('must not fetch');};
 await assert.rejects(run(args(proof.statePath),{input:readUrl.replace(origin,'https://evil.example'),fetcher}));
 const contents=JSON.parse(await readFile(proof.statePath,'utf8'));
 await chmod(proof.statePath,0o644);await assert.rejects(run(args(proof.statePath),{input:readUrl,fetcher}));await chmod(proof.statePath,0o600);
 for(const change of [{origin:'https://evil.example'},{envName:'OTHER_TOKEN'},{createdAt:Date.now()-600000},{v:99}]) {
  await writeFile(proof.statePath,JSON.stringify({...contents,...change}));await assert.rejects(run(args(proof.statePath),{input:readUrl,fetcher}));
 }
 const linked=join(proof.folder,'linked.json');await symlink(proof.statePath,linked);await assert.rejects(run(args(linked),{input:readUrl,fetcher}));
 assert.equal(calls,0);
});
test('errors clean state and never include vault response bodies or secrets',async t=>{
 for(const response of [new Response('sensitive-body',{status:403}),new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),new Response('synthetic',{headers:{'Content-Type':'text/plain','X-Vault-Env':'OTHER_TOKEN'}})]) {
  const proof=await prepare(t);let spawned=false;
  await assert.rejects(run(args(proof.statePath),{input:readUrl,fetcher:async()=>response,spawnChild:()=>{spawned=true;}}),e=>!e.message.includes('sensitive-body'));
  assert.equal(spawned,false);await assert.rejects(access(proof.statePath));
 }
 const proof=await prepare(t);await assert.rejects(run(args(proof.statePath),{input:readUrl,fetcher:async()=>{throw new Error('synthetic transport failure');}}));await assert.rejects(access(proof.statePath));
});
test('Agent uploads from process environment with bound proof, then cleans state',async t=>{
 const proof=await prepare(t);let request;
 const code=await run(['store','--origin',origin,'--env','GH_TOKEN','--state',proof.statePath],{input:`${origin}/redeem/write#${ticket}`,environment:{GH_TOKEN:'synthetic-upload'},fetcher:async(url,init)=>{request={url,init};return Response.json({stored:true});}});
 assert.equal(code,0);assert.equal(String(request.url),`${origin}/redeem/write`);assert.equal(JSON.parse(request.init.body).token,'synthetic-upload');assert.ok(request.init.headers['X-Vault-Verifier']);await assert.rejects(access(proof.statePath));
});
