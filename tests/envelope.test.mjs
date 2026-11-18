import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {VaultService} from '../.test-build/vault-service.mjs';
import {fetchApp} from '../dist/app.mjs';
import {testDB} from './d1.mjs';
const origin='https://vault.example';
const token='synthetic-envelope-test-only';
function fixture(){const DB=testDB(),key=randomBytes(32).toString('base64');let now=Date.now();return {db:DB,service:new VaultService(DB,key,origin,()=>now),advance:n=>now+=n,env:{DB,VAULT_ENCRYPTION_KEY:key,PUBLIC_ORIGIN:origin,MCP_ACCESS_KEY:randomBytes(32).toString('hex')}};}
async function request(){const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);const {n,e,kty}=await crypto.subtle.exportKey('jwk',pair.publicKey);return {pair,args:{name:'github/test',requestId:randomUUID(),audience:origin,publicKey:{n,e,kty}}};}
async function decrypt(envelope,privateKey){const [h,w,iv,c,t]=envelope.split('.');const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},privateKey,Buffer.from(w,'base64url'));const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(iv,'base64url'),additionalData:new TextEncoder().encode(h),tagLength:128},key,Buffer.concat([Buffer.from(c,'base64url'),Buffer.from(t,'base64url')]))));}
async function seed(service){await service.save('owner',{name:'github/test',envVar:'GH_TOKEN',token});}
test('official MCP SDK transports ciphertext only and exact credential decrypts offline',async()=>{
 const {service,env}=fixture();await seed(service);const {pair,args}=await request();
 const client=new Client({name:'fake-envelope-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`}},fetch:(url,init)=>fetchApp(new Request(url,init),env)}));
 try{const response=await client.callTool({name:'create_token_envelope',arguments:args});assert.ok(!response.isError);assert(!JSON.stringify(response).includes(token));assert.deepEqual(JSON.parse(response.content[0].text),response.structuredContent);assert.deepEqual(await decrypt(response.structuredContent.envelope,pair.privateKey),{token});assert.equal((await service.recent('owner'))[0].action,'read.envelope_issued');}finally{await client.close();}
});
test('strict request validation, missing credentials and foreign owner rejected',async()=>{
 const {service}=fixture();await seed(service);const {args}=await request();
 for(const input of [null,[],{}, {...args,extra:1},{...args,audience:'https://evil.example'},{...args,requestId:'bad'},{...args,publicKey:{...args.publicKey,d:'fake'}},{...args,publicKey:{...args.publicKey,n:'A'.repeat(512)}},{...args,publicKey:{...args.publicKey,e:'Aw'}}])await assert.rejects(service.envelope('owner',input));
 await assert.rejects(service.envelope('other',args),e=>e.status===404);
 await assert.rejects(service.envelope('owner',{...args,name:'missing/token'}),e=>e.status===404);
});
test('request and public key cannot be reissued during replay window',async()=>{
 const {service}=fixture();await seed(service);const {args}=await request();await service.envelope('owner',args);
 await assert.rejects(service.envelope('owner',args),e=>e.status===429);
 await assert.rejects(service.envelope('owner',{...args,requestId:randomUUID()}),e=>e.status===429);
});
test('atomic issue budget blocks 21st request and permits after minute',async()=>{
 const f=fixture();await seed(f.service);const {args}=await request();
 for(let i=0;i<20;i++)await f.db.prepare('INSERT INTO envelope_issuance VALUES(?,?,?,?)').bind('owner',randomUUID(),`synthetic-${i}`,Date.now()).run();
 await assert.rejects(f.service.envelope('owner',args),e=>e.status===429);f.advance(61000);assert.ok((await f.service.envelope('owner',args)).envelope);
});
test('audit persistence failure never returns an envelope',async()=>{
 const f=fixture();await seed(f.service);const {args}=await request();const db={...f.db,prepare(sql){if(sql.startsWith('INSERT INTO activity'))return {bind(){return {run(){throw Error('synthetic audit failure');}};}};return f.db.prepare(sql);}};
 await assert.rejects(new VaultService(db,f.env.VAULT_ENCRYPTION_KEY,origin).envelope('owner',args));
});
test('deletion cannot recall an already issued encrypted credential (documented boundary)',async()=>{
 const {service}=fixture();await seed(service);const {pair,args}=await request();const result=await service.envelope('owner',args);await service.remove('owner',args.name);assert.deepEqual(await decrypt(result.envelope,pair.privateKey),{token});
});

test('actual packaged helper request -> authenticated MCP -> offline helper child round trip',async()=>{
 const {mkdtemp,rm,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {spawn}=await import('node:child_process');const {createHash}=await import('node:crypto');
 const dir=await mkdtemp(`${tmpdir()}/vault-mcp-offline-test-`),state=`${dir}/state`;
 const exec=(args,stdin='')=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['cli/vault-envelope.mjs',...args],{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));p.stdin.end(stdin);});
 const flags=['--origin',origin,'--name','github/test','--env','GH_TOKEN','--state',state];
 const {service,env}=fixture();await seed(service);const client=new Client({name:'offline-helper-roundtrip',version:'1'});
 try{
  const prepared=await exec(['prepare',...flags]);assert.equal(prepared.code,0);const args=JSON.parse(prepared.out);assert(!prepared.out.includes('privateKey'));
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`}},fetch:(url,init)=>fetchApp(new Request(url,init),env)}));
  const result=await client.callTool({name:'create_token_envelope',arguments:args});assert.ok(!result.isError);assert(!JSON.stringify(result).includes(token));
  const child=await exec(['run',...flags,'--',process.execPath,'-e',"console.log(require('node:crypto').createHash('sha256').update(process.env.GH_TOKEN).digest('hex'))"],JSON.stringify(result.structuredContent));
  assert.equal(child.code,0);assert.equal(child.err,'');assert.equal(child.out.trim(),createHash('sha256').update(token).digest('hex'));await assert.rejects(stat(state),e=>e.code==='ENOENT');
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
