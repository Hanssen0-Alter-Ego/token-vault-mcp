import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,chmod,symlink,rm,stat,access,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:https';
import {fetchApp} from '../dist/app.mjs';
import {testDB} from './d1.mjs';

const helper=resolve('cli/vault-cli.sh');
const execute=(args,{input='',env={},trace=false}={})=>new Promise(resolve=>{
 const child=spawn('/bin/sh',[...(trace?['-x']:[]),helper,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 child.on('exit',code=>resolve({code,stdout,stderr}));child.stdin.on('error',()=>{});child.stdin.end(input);
});
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'vault-shell-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
 const tls=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});assert.equal(tls.status,0);
 const env={DB:testDB(),PUBLIC_ORIGIN:'',MCP_ACCESS_KEY:randomBytes(32).toString('hex'),VAULT_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
 const requests=[];let override;
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
   const parts=[];for await(const part of req)parts.push(part);
   requests.push({url:req.url,headers:req.headers,body:Buffer.concat(parts).toString()});
   const response=override?await override(req):await fetchApp(new Request(env.PUBLIC_ORIGIN+req.url,{method:req.method,headers:req.headers,body:req.method==='POST'?Buffer.concat(parts):undefined}),env);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));env.PUBLIC_ORIGIN=`https://127.0.0.1:${server.address().port}`;
 t.after(()=>new Promise(r=>server.close(r)));
 const origin=env.PUBLIC_ORIGIN,environment={CURL_CA_BUNDLE:cert,TMPDIR:dir};
 const args=(mode,state,command=[])=>[mode,'--origin',origin,'--env','GH_TOKEN','--state',state,...(command.length?['--',...command]:[])];
 const prepare=async(extraEnv={})=>{
   const state=join(dir,`claim-${randomBytes(6).toString('hex')}.state`),result=await execute(args('prepare',state),{env:{...environment,...extraEnv}});
   assert.equal(result.code,0,result.stderr);const challenge=JSON.parse(result.stdout).claimChallenge;
   const lines=(await readFile(state,'utf8')).trimEnd().split('\n');return {state,challenge,verifier:lines[4],lines,output:result.stdout};
 };
 const rpc=async(name,arguments_)=>{
   const response=await fetchApp(new Request(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})}),env);
   const payload=await response.json();assert.ok(!payload.result.isError);return payload.result.structuredContent;
 };
 return {dir,origin,environment,args,prepare,rpc,requests,env,setResponse:fn=>override=fn};
}

test('sh helper prepares cryptographic state with private permissions and prints only the S256 hash',async t=>{
 const f=await fixture(t),p=await f.prepare();
 assert.equal(p.lines[0],'token-vault-sh-v1');assert.equal(p.lines[1],f.origin);assert.equal(p.lines[2],'GH_TOKEN');
 assert.equal(p.verifier.length,43);assert.equal(p.challenge,createHash('sha256').update(p.verifier).digest('base64url'));
 assert.ok(!p.output.includes(p.verifier));assert.equal((await stat(p.state)).mode&0o777,0o600);
 const duplicate=await execute(f.args('prepare',p.state),{env:f.environment});assert.notEqual(duplicate.code,0);
 assert.equal(f.requests.length,0);assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('sh upload works with real HTTPS and Worker, stores exact token and rejects replay',async t=>{
 const f=await fixture(t),name='shell/test',value='synthetic-"quote"\\slash\ttab$(not-executed)';
 const upload=await f.prepare();
 const write=await f.rpc('create_token_write_link',{name,envVar:'GH_TOKEN',claimChallenge:upload.challenge});
 assert.equal(write.helper.url,f.origin+'/vault-cli.sh');
 const stored=await execute(f.args('store',upload.state),{input:write.url+'\n',env:{...f.environment,GH_TOKEN:value},trace:true});
 assert.equal(stored.code,0,stored.stderr);assert.equal(stored.stdout,'');assert.ok(!stored.stderr.includes(value)&&!stored.stderr.includes(upload.verifier));
 await assert.rejects(access(upload.state));assert.equal(JSON.parse(f.requests[0].body).token,value);
 assert.equal(f.requests[0].headers['x-vault-verifier'],upload.verifier);assert.equal(f.requests[0].url,'/redeem/write');
 assert.ok(!JSON.stringify(write).includes(value)&&!JSON.stringify(write).includes(upload.verifier));
 const url=new URL(write.url),replay=await fetchApp(new Request(f.origin+url.pathname,{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(1)}`,'X-Vault-Verifier':upload.verifier,'Content-Type':'application/json'},body:JSON.stringify({token:value})}),f.env);
 assert.equal(replay.status,410);
 const audit=JSON.stringify(await f.rpc('recent_activity',{}));
 assert.ok(!audit.includes(value)&&!audit.includes(upload.verifier)&&!audit.includes(url.hash.slice(1)));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('removed shell run mode and read links cannot read a credential or execute a child',async t=>{
 const f=await fixture(t),p=await f.prepare();
 const result=await execute(f.args('run',p.state,['/bin/sh','-c','printf must-not-run']),{input:f.origin+'/redeem/read#'+'a'.repeat(64),env:f.environment});
 assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(f.requests.length,0);await access(p.state);
 const wrong=await execute(f.args('store',p.state),{input:f.origin+'/redeem/read#'+'a'.repeat(64),env:{...f.environment,GH_TOKEN:'synthetic-store-token'}});
 assert.equal(wrong.code,1);assert.equal(f.requests.length,0);
 const extra=await execute(f.args('store',p.state,['/bin/echo','must-not-run']),{env:f.environment});
 assert.equal(extra.code,1);assert.equal(extra.stdout,'');assert.equal(f.requests.length,0);
});

test('sh helper rejects unsafe state, origin and env substitution before sending a request',async t=>{
 const f=await fixture(t),p=await f.prepare(),link=f.origin+'/redeem/write#'+'a'.repeat(64);
 const run=state=>execute(f.args('store',state),{input:link,env:{...f.environment,GH_TOKEN:'synthetic-store-token'}});
 await chmod(p.state,0o644);assert.notEqual((await run(p.state)).code,0);await chmod(p.state,0o600);
 const linked=join(f.dir,'symlink.state');await symlink(p.state,linked);assert.notEqual((await run(linked)).code,0);
 for(const [index,value] of [[0,'untrusted-format'],[1,'https://other.example'],[2,'OTHER_TOKEN'],[3,'1'],[4,'$(not-executed)']]) {
   const lines=[...p.lines];lines[index]=value;await writeFile(p.state,lines.join('\n')+'\n');assert.notEqual((await run(p.state)).code,0);
 }
 await writeFile(p.state,p.lines.join('\n')+'\n');
 assert.notEqual((await execute(f.args('store',p.state),{input:link.replace(f.origin,'https://evil.example'),env:{...f.environment,GH_TOKEN:'synthetic-store-token'}})).code,0);
 assert.equal(f.requests.length,0);
});

test('sh store rejects redirects, HTTP errors and oversized response, cleaning private state',async t=>{
 const f=await fixture(t);
 for(const response of [
   ()=>new Response('sensitive-error',{status:403}),
   ()=>new Response('sensitive-redirect',{status:302,headers:{Location:f.origin+'/redirected'}}),
   ()=>new Response('x'.repeat(8193)),
 ]) {
   f.setResponse(response);const p=await f.prepare(),link=f.origin+'/redeem/write#'+'a'.repeat(64);
   const result=await execute(f.args('store',p.state),{input:link,env:{...f.environment,GH_TOKEN:'synthetic-store-token'}});
   assert.notEqual(result.code,0);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('sensitive')&&!result.stderr.includes(p.verifier));await assert.rejects(access(p.state));
 }
 assert.ok(f.requests.every(r=>r.url==='/redeem/write'));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('sh store rejects empty, control-byte and oversized source credentials before network',async t=>{
 const f=await fixture(t);
 for(const token of ['', 'newline\n', 'carriage\rreturn', 'x'.repeat(8193)]) {
   const p=await f.prepare();
   const result=await execute(f.args('store',p.state),{input:f.origin+'/redeem/write#'+'a'.repeat(64),env:{...f.environment,GH_TOKEN:token}});
   assert.equal(result.code,1);assert.equal(result.stdout,'');await assert.rejects(access(p.state));
 }
 assert.equal(f.requests.length,0);assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('sh helper prepares and stores without Node, Python, jq or Bash on PATH',async t=>{
 const f=await fixture(t),bin=join(f.dir,'bin');await mkdir(bin);
 for(const command of ['curl','openssl','awk','tr','wc','cmp','stat','id','date','dirname','mktemp','cat','rm']) {
   const found=spawnSync('/bin/sh',['-c','command -v "$1"','sh',command],{encoding:'utf8'});assert.equal(found.status,0);await symlink(found.stdout.trim(),join(bin,command));
 }
 const p=await f.prepare({PATH:bin});
 const grant=await f.rpc('create_token_write_link',{name:'shell/minimal',envVar:'GH_TOKEN',claimChallenge:p.challenge});
 const result=await execute(f.args('store',p.state),{input:grant.url,env:{...f.environment,PATH:bin,GH_TOKEN:'synthetic-minimal-token'}});
 assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'');await assert.rejects(access(p.state));
 assert.equal(JSON.parse(f.requests[0].body).token,'synthetic-minimal-token');
});

test('a wrong shell proof cannot burn a valid write grant, and redemption never needs the MCP master key',async t=>{
 const f=await fixture(t),p=await f.prepare();
 const grant=await f.rpc('create_token_write_link',{name:'shell/proof',envVar:'GH_TOKEN',claimChallenge:p.challenge});
 const changed=[...p.lines];changed[4]=randomBytes(32).toString('base64url');await writeFile(p.state,changed.join('\n')+'\n');
 const denied=await execute(f.args('store',p.state),{input:grant.url,env:{...f.environment,GH_TOKEN:'synthetic-proof-token'}});
 assert.notEqual(denied.code,0);assert.match(denied.stderr,/403/);await assert.rejects(access(p.state));
 assert.ok(!JSON.stringify(f.requests).includes(f.env.MCP_ACCESS_KEY));
 const url=new URL(grant.url),accepted=await fetchApp(new Request(f.origin+url.pathname,{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(1)}`,'X-Vault-Verifier':p.verifier,'Content-Type':'application/json'},body:JSON.stringify({token:'synthetic-proof-token'})}),f.env);
 assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{stored:true});
});

test('failure diagnostics expose only numeric timings and final strictly formatted IDs',async t=>{
 const f=await fixture(t);
 f.setResponse(()=>new Response('sensitive-response-body',{status:503,headers:{
  'CF-Ray':'a5bcdad4fbb17a72-DFW','X-Request-ID':'12345678-1234-1234-1234-123456789abc',
  'Authorization':'Bearer sensitive-response-header','Location':'https://secret.invalid/claim#sensitive-fragment'
 }}));
 const p=await f.prepare(),link=f.origin+'/redeem/write#'+'a'.repeat(64);
 const result=await execute(f.args('store',p.state),{input:link,env:{...f.environment,GH_TOKEN:'synthetic-store-token'}});
 assert.equal(result.code,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/curl_exit=0 started_epoch_s=\d+ finished_epoch_s=\d+ elapsed_s=\d+ http_status=503/);
 assert.match(result.stderr,/total_s=\d+\.\d+/);assert.match(result.stderr,/cf_ray=a5bcdad4fbb17a72-DFW/);
 assert.match(result.stderr,/request_id=12345678-1234-1234-1234-123456789abc/);
 for(const secret of ['sensitive','synthetic-store-token',p.verifier,link,'a'.repeat(64),f.origin])assert.ok(!result.stderr.includes(secret));
 await assert.rejects(access(p.state));
 for(const invalid of ['https://secret.invalid/claim#value','Bearer SECRET','a'.repeat(64),'a5bcdad4fbb17a72-DFW,other']) {
  f.setResponse(()=>new Response('private',{status:403,headers:{'CF-Ray':invalid,'X-Request-ID':invalid}}));
  const next=await f.prepare(),r=await execute(f.args('store',next.state),{input:link,env:{...f.environment,GH_TOKEN:'synthetic-store-token'}});
  assert.equal(r.code,1);assert.ok(!r.stderr.includes(invalid));assert.ok(!r.stderr.includes('cf_ray=')&&!r.stderr.includes('request_id='));
 }
});

test('transport diagnostics preserve curl errno but never raw stderr, proof or body',async t=>{
 const f=await fixture(t),bin=join(f.dir,'mock-bin');await mkdir(bin);
 // Only synthetic local test data. Mock curl reads private files to prove none leak.
 await writeFile(join(bin,'curl'),`#!/bin/sh
headers='';out=''
while [ "$#" -gt 0 ]; do
 case "$1" in --header) shift; headers=\${1#@};; --dump-header) shift; out=$1;; esac
 shift
done
cat "$headers" >&2
printf 'https://secret.invalid/path#private-body\\n' >&2
printf 'HTTP/1.1 200 Connection established\\r\\nCF-Ray: 1111111111111111-DFW\\r\\n\\r\\nHTTP/2 503\\r\\nCF-Ray: malformed-secret\\r\\n\\r\\n' > "$out"
printf '000\\n0.000001\\n0.000000\\n0.000000\\n0.000000\\n10.001234\\n'
exit 28
`,{mode:0o700});
 const p=await f.prepare(),link=f.origin+'/redeem/write#'+'b'.repeat(64);
 const result=await execute(f.args('store',p.state),{input:link,env:{...f.environment,PATH:bin+':'+process.env.PATH,GH_TOKEN:'synthetic-store-token'}});
 assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/curl_exit=28/);assert.match(result.stderr,/total_s=10.001234/);
 for(const secret of ['synthetic-store-token',p.verifier,'b'.repeat(64),'secret.invalid','private-body','malformed-secret','1111111111111111'])assert.ok(!result.stderr.includes(secret));
 await assert.rejects(access(p.state));assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('store transport failure before headers exists never discloses the source token',async t=>{
 const f=await fixture(t),bin=join(f.dir,'mock-store-bin');await mkdir(bin);
 await writeFile(join(bin,'curl'),`#!/bin/sh
while [ "$#" -gt 0 ]; do
 case "$1" in --header|--data-binary) shift; cat "\${1#@}" >&2;; esac
 shift
done
printf '000\\n0.000000\\n0.000000\\n0.000000\\n0.000000\\n0.000001\\n'
exit 6
`,{mode:0o700});
 const p=await f.prepare(),token='synthetic-store-secret',link=f.origin+'/redeem/write#'+'c'.repeat(64);
 const result=await execute(f.args('store',p.state),{input:link,env:{...f.environment,PATH:bin+':'+process.env.PATH,GH_TOKEN:token}});
 assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/curl_exit=6/);assert.match(result.stderr,/http_status=000/);
 for(const secret of [token,p.verifier,link,'c'.repeat(64)])assert.ok(!result.stderr.includes(secret));
 await assert.rejects(access(p.state));assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});
