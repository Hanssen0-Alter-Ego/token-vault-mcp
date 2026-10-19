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
 child.on('exit',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
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

test('sh upload and read work with real HTTPS and Worker, inject exact token and reject replay',async t=>{
 const f=await fixture(t),name='shell/test',value='synthetic-"quote"\\slash\ttab$(not-executed)';
 const upload=await f.prepare();
 const write=await f.rpc('create_token_write_link',{name,envVar:'GH_TOKEN',claimChallenge:upload.challenge});
 assert.equal(write.helper.url,f.origin+'/vault-cli.sh');
 const stored=await execute(f.args('store',upload.state),{input:write.url+'\n',env:{...f.environment,GH_TOKEN:value},trace:true});
 assert.equal(stored.code,0,stored.stderr);assert.ok(!stored.stdout.includes(value)&&!stored.stderr.includes(value)&&!stored.stderr.includes(upload.verifier));
 await assert.rejects(access(upload.state));assert.equal(JSON.parse(f.requests[0].body).token,value);
 assert.equal(f.requests[0].headers['x-vault-verifier'],upload.verifier);assert.equal(f.requests[0].url,'/redeem/write');
 const p=await f.prepare(),read=await f.rpc('create_token_read_link',{name,claimChallenge:p.challenge});
 const metadata=JSON.stringify({write,read});
 assert.ok(!metadata.includes(value)&&!metadata.includes(upload.verifier)&&!metadata.includes(p.verifier));
 const childCode='const fs=require("node:fs"),c=require("node:crypto");if(fs.existsSync(process.argv[1])||c.createHash("sha256").update(process.env.GH_TOKEN||"").digest("hex")!==process.argv[2])process.exit(7);process.stdout.write("child-ok")';
 const result=await execute(f.args('run',p.state,[process.execPath,'-e',childCode,p.state,createHash('sha256').update(value).digest('hex')]),{input:read.url+'\n',env:f.environment});
 assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'child-ok');assert.ok(!result.stderr.includes(value)&&!result.stderr.includes(p.verifier));
 await assert.rejects(access(p.state));
 const url=new URL(read.url),replay=await fetchApp(new Request(f.origin+url.pathname,{method:'POST',headers:{Authorization:`Bearer ${url.hash.slice(1)}`,'X-Vault-Verifier':p.verifier}}),f.env);
 assert.equal(replay.status,410);
 const audit=JSON.stringify(await f.rpc('recent_activity',{}));
 assert.ok(!audit.includes(value)&&!audit.includes(p.verifier)&&!audit.includes(url.hash.slice(1)));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('sh helper rejects unsafe state, origin and env substitution before sending a request',async t=>{
 const f=await fixture(t),p=await f.prepare(),link=f.origin+'/redeem/read#'+'a'.repeat(64);
 const run=state=>execute(f.args('run',state,['/bin/true']),{input:link,env:f.environment});
 await chmod(p.state,0o644);assert.notEqual((await run(p.state)).code,0);await chmod(p.state,0o600);
 const linked=join(f.dir,'symlink.state');await symlink(p.state,linked);assert.notEqual((await run(linked)).code,0);
 for(const [index,value] of [[0,'untrusted-format'],[1,'https://other.example'],[2,'OTHER_TOKEN'],[3,'1'],[4,'$(not-executed)']]) {
   const lines=[...p.lines];lines[index]=value;await writeFile(p.state,lines.join('\n')+'\n');assert.notEqual((await run(p.state)).code,0);
 }
 await writeFile(p.state,p.lines.join('\n')+'\n');
 assert.notEqual((await execute(f.args('run',p.state,['/bin/true']),{input:link.replace(f.origin,'https://evil.example'),env:f.environment})).code,0);
 assert.equal(f.requests.length,0);
});

test('sh helper rejects redirects, wrong headers, HTTP errors and control bytes, cleaning all private state',async t=>{
 const f=await fixture(t);
 for(const response of [
   ()=>new Response('sensitive-error',{status:403}),
   ()=>new Response('sensitive-redirect',{status:302,headers:{Location:f.origin+'/redirected'}}),
   ()=>new Response('sensitive-html',{headers:{'Content-Type':'text/html','X-Vault-Env':'GH_TOKEN'}}),
   ()=>new Response('sensitive-env',{headers:{'Content-Type':'text/plain','X-Vault-Env':'OTHER_TOKEN'}}),
   ()=>new Response('nul\0byte',{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}}),
   ()=>new Response('newline\n',{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}}),
   ()=>new Response('x'.repeat(8193),{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}}),
 ]) {
   f.setResponse(response);const p=await f.prepare(),link=f.origin+'/redeem/read#'+'a'.repeat(64);
   const result=await execute(f.args('run',p.state,['/bin/sh','-c','printf must-not-run']),{input:link,env:f.environment});
   assert.notEqual(result.code,0);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('sensitive')&&!result.stderr.includes(p.verifier));await assert.rejects(access(p.state));
 }
 assert.ok(f.requests.every(r=>r.url==='/redeem/read'));
 assert.deepEqual((await readdir(f.dir)).filter(n=>n.startsWith('token-vault.')),[]);
});

test('sh helper runs without Node, Python, jq or Bash on PATH and preserves child exit code',async t=>{
 const f=await fixture(t),bin=join(f.dir,'bin');await mkdir(bin);
 for(const command of ['curl','openssl','awk','tr','wc','cmp','stat','id','date','dirname','mktemp','cat','rm']) {
   const found=spawnSync('/bin/sh',['-c','command -v "$1"','sh',command],{encoding:'utf8'});assert.equal(found.status,0);await symlink(found.stdout.trim(),join(bin,command));
 }
 const p=await f.prepare({PATH:bin});f.setResponse(()=>new Response('synthetic-minimal-token',{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}}));
 const result=await execute(f.args('run',p.state,['/bin/sh','-c','[ -n "$GH_TOKEN" ] || exit 9; printf minimal-ok; exit 23']),{input:f.origin+'/redeem/read#'+'a'.repeat(64),env:{...f.environment,PATH:bin}});
 assert.equal(result.code,23);assert.equal(result.stdout,'minimal-ok');await assert.rejects(access(p.state));
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
