import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,chmod,stat,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {webcrypto,createHash} from 'node:crypto';
const helper=resolve('cli/vault-envelope.mjs'), origin='https://vault.example';
const {subtle}=webcrypto, encoder=new TextEncoder();
const b64=x=>Buffer.from(x).toString('base64url');
const fake='FAKE_ONLY_credential_for_offline_tests';
function call(args,input=''){
 const child=spawn(process.execPath,[helper,...args],{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 child.stdin.on('error',()=>{});child.stdin.end(input);
 return new Promise((res,rej)=>{child.once('error',rej);child.once('close',code=>res({code,stdout,stderr}));});
}
async function fixture(t){
 const dir=await mkdtemp(`${tmpdir()}/vault-envelope-test-`);t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=`${dir}/state`, args=['--origin',origin,'--name','github/test','--env','GH_TOKEN','--state',state];
 const p=await call(['prepare',...args]);assert.equal(p.code,0,p.stderr);const request=JSON.parse(p.stdout);
 assert.deepEqual(Object.keys(request).sort(),['audience','name','publicKey','requestId']);assert.deepEqual(Object.keys(request.publicKey).sort(),['e','kty','n']);
 return {dir,state,args,request};
}
async function seal(request,changes={},token=fake){
 const now=Date.now();
 const header={alg:'RSA-OAEP-256',enc:'A256GCM',typ:'vault-envelope+jwe',v:1,requestId:request.requestId,name:request.name,envVar:'GH_TOKEN',audience:request.audience,issuedAt:now,expiresAt:now+60000,...changes};
 const h=b64(encoder.encode(JSON.stringify(header)));
 const publicKey=await subtle.importKey('jwk',request.publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const key=await subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=webcrypto.getRandomValues(new Uint8Array(12));
 const ciphertext=Buffer.from(await subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(h)},key,encoder.encode(JSON.stringify({token}))));
 const wrapped=await subtle.encrypt({name:'RSA-OAEP'},publicKey,await subtle.exportKey('raw',key));
 return {envelope:[h,b64(wrapped),b64(iv),b64(ciphertext.subarray(0,-16)),b64(ciphertext.subarray(-16))].join('.')};
}
const childArgs=['--',process.execPath,'-e',`const fs=require('node:fs'),crypto=require('node:crypto'); if(fs.existsSync(process.argv[1]))process.exit(12);console.log(crypto.createHash('sha256').update(process.env.GH_TOKEN).digest('hex'));process.exit(7);`];
test('offline helper keeps key private, consumes before child and preserves child exit status',async t=>{
 const f=await fixture(t);assert.equal((await stat(f.state)).mode&0o777,0o600);const payload=await seal(f.request);
 assert(!JSON.stringify(payload).includes(fake));
 const result=await call(['run',...f.args,...childArgs,f.state],JSON.stringify(payload));
 assert.equal(result.code,7,result.stderr);assert.equal(result.stderr,'');assert.equal(result.stdout.trim(),createHash('sha256').update(fake).digest('hex'));
 await assert.rejects(access(f.state));
 const replay=await call(['run',...f.args,'--',process.execPath,'-e','process.exit(99)'],JSON.stringify(payload));assert.equal(replay.code,1);
});
test('prepare refuses overwrite, permissive directories, symlink directories and dangerous env',async t=>{
 const f=await fixture(t),before=await readFile(f.state);
 assert.equal((await call(['prepare',...f.args])).code,1);assert.deepEqual(await readFile(f.state),before);
 await chmod(f.dir,0o755);assert.equal((await call(['prepare',...f.args])).code,1);await chmod(f.dir,0o700);
 const link=`${f.dir}/alias`;await symlink(f.dir,link);const args=[...f.args];args[args.indexOf('--state')+1]=`${link}/second`;
 assert.equal((await call(['prepare',...args])).code,1);
 args[args.indexOf('--env')+1]='NODE_OPTIONS';assert.equal((await call(['prepare',...args])).code,1);
});
test('run rejects symlink or nonprivate state without reading/deleting target',async t=>{
 const f=await fixture(t),payload=await seal(f.request),target=`${f.dir}/target`;await writeFile(target,await readFile(f.state),{mode:0o600});await rm(f.state);await symlink(target,f.state);
 assert.equal((await call(['run',...f.args,'--','true'],JSON.stringify(payload))).code,1);await access(target);
 await rm(f.state);await writeFile(f.state,await readFile(target),{mode:0o644});assert.equal((await call(['run',...f.args,'--','true'],JSON.stringify(payload))).code,1);
});
for(const [label,change] of [
 ['mismatched credential',{name:'github/other'}],['dangerous environment',{envVar:'PATH'}],['wrong audience',{audience:'https://other.example'}],['wrong request',{requestId:'00000000-0000-4000-8000-000000000000'}],['expired',{issuedAt:Date.now()-61000,expiresAt:Date.now()-1000}],['extended validity',{expiresAt:Date.now()+600000}],['algorithm confusion',{alg:'RSA1_5'}],['extra field',{extra:'rejected'}]
])test(`run rejects ${label} and consumes key`,async t=>{
 const f=await fixture(t);const p=await seal(f.request,change);
 const result=await call(['run',...f.args,'--',process.execPath,'-e','process.exit(99)'],JSON.stringify(p));assert.equal(result.code,1);assert.equal(result.stdout,'');assert(!result.stderr.includes(fake));await assert.rejects(access(f.state));
});
test('run rejects corrupted authentication tag',async t=>{const f=await fixture(t),p=await seal(f.request),parts=p.envelope.split('.');const tag=Buffer.from(parts[4],'base64url');tag[0]^=1;parts[4]=b64(tag);p.envelope=parts.join('.');const r=await call(['run',...f.args,'--','true'],JSON.stringify(p));assert.equal(r.code,1);await assert.rejects(access(f.state));});
test('concurrent normal helper runs have at most one credential recipient',async t=>{
 const f=await fixture(t),p=JSON.stringify(await seal(f.request));const args=['run',...f.args,...childArgs,f.state];const results=await Promise.all([call(args,p),call(args,p)]);assert.deepEqual(results.map(x=>x.code).sort((a,b)=>a-b),[1,7]);
});
test('run consumes private state even if input is oversized or child is missing',async t=>{
 const f=await fixture(t);assert.equal((await call(['run',...f.args,'--','true'],'x'.repeat(98305))).code,1);await assert.rejects(access(f.state));
 const g=await fixture(t);assert.equal((await call(['run',...g.args,'--','/nonexistent-vault-test-command'],JSON.stringify(await seal(g.request)))).code,1);await assert.rejects(access(g.state));
});
test('state age is bounded; signals while waiting for ciphertext leave no private file',async t=>{
 const f=await fixture(t),s=JSON.parse(await readFile(f.state,'utf8'));s.createdAt-=300001;await writeFile(f.state,JSON.stringify(s));assert.equal((await call(['run',...f.args,'--','true'],'{}')).code,1);await assert.rejects(access(f.state));
 const g=await fixture(t);const child=spawn(process.execPath,[helper,'run',...g.args,'--','true'],{stdio:['pipe','pipe','pipe']});
 const done=new Promise(res=>child.once('close',res));child.stdin.on('error',()=>{});
 // Wait until helper consumed its state and is blocked on stdin.
 for(let i=0;i<100;i++){try{await access(g.state);}catch{break;}await new Promise(r=>setTimeout(r,10));}
 await assert.rejects(access(g.state));child.kill('SIGTERM');await done;await assert.rejects(access(g.state));
});
test('wrong RSA recipient fails even with matching public header metadata',async t=>{
 const f=await fixture(t),g=await fixture(t),p=await seal({...f.request,publicKey:g.request.publicKey});
 const r=await call(['run',...f.args,'--','true'],JSON.stringify(p));assert.equal(r.code,1);assert.equal(r.stdout,'');await assert.rejects(access(f.state));
});
test('invalid token and noncanonical base64 are never passed to child',async t=>{
 const f=await fixture(t);const p=await seal(f.request,{},'FAKE_ONLY_\nnot-an-env-token');assert.equal((await call(['run',...f.args,'--','true'],JSON.stringify(p))).code,1);
 const g=await fixture(t),q=await seal(g.request);q.envelope+='=';assert.equal((await call(['run',...g.args,'--','true'],JSON.stringify(q))).code,1);
});
test('state is gone during child execution and SIGTERM is forwarded',{timeout:10000},async t=>{
 const f=await fixture(t),p=await seal(f.request);
 const c=spawn(process.execPath,[helper,'run',...f.args,'--',process.execPath,'-e',"process.on('SIGTERM',()=>process.exit(23));console.log('child-ready');setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});
 let out='';const ready=new Promise(res=>c.stdout.on('data',x=>{out+=x;if(out.includes('child-ready'))res();}));const done=new Promise(res=>c.once('close',res));c.stdin.end(JSON.stringify(p));await ready;await assert.rejects(access(f.state));c.kill('SIGTERM');assert.equal(await done,23);
});

test('largest accepted JSON-escaped credential survives offline delivery',async t=>{
 const f=await fixture(t),value='\u0001'.repeat(8192),p=await seal(f.request,{},value);
 const r=await call(['run',...f.args,...childArgs,f.state],JSON.stringify(p));assert.equal(r.code,7,r.stderr);assert.equal(r.stdout.trim(),createHash('sha256').update(value).digest('hex'));
});
test('child SIGKILL returns conventional 137 exit status',async t=>{
 const f=await fixture(t);const r=await call(['run',...f.args,'--',process.execPath,'-e',"process.kill(process.pid,'SIGKILL')"],JSON.stringify(await seal(f.request)));assert.equal(r.code,137);
});
