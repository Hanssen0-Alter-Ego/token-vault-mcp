#!/usr/bin/env node
// Fixed offline helper. Run with Node >=24, never source or eval received data.
// Ciphertext is not a server signature: obtain it only from the authenticated Vault MCP.
import {constants as fsConstants, lstatSync, realpathSync, openSync, fstatSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync, rmdirSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {webcrypto, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants as osConstants} from 'node:os';
const {subtle}=webcrypto;
const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{fatal:true});
const MAX_INPUT=98304, MAX_STATE=16384;
// write callback reports EPIPE; do not emit an unhandled stream error/stack.
process.stdout.on('error',()=>{});
let cleanupState=null, cleanupLock=null, child=null, terminating=false;
const fail=()=>{throw new Error('Invalid envelope or local state. Prepare a fresh state and request a fresh envelope.');};
const ownObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(x,keys){if(!ownObject(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail();}
function clean(){
  if(cleanupState){const {path,ino,dev}=cleanupState;try{const s=lstatSync(path);if(s.ino===ino&&s.dev===dev&&!s.isSymbolicLink())unlinkSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}cleanupState=null;}
  if(cleanupLock){rmdirSync(cleanupLock);cleanupLock=null;}
}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{
  terminating=true;
  try{clean();}catch{}
  if(child){child.kill(signal);return;}
  process.exit(128+({SIGHUP:1,SIGINT:2,SIGTERM:15}[signal]));
});
function bytes(value){
  if(typeof value!=='string'||!value||!/^[A-Za-z0-9_-]+$/.test(value))fail();
  const result=Buffer.from(value,'base64url');if(result.toString('base64url')!==value)fail();return result;
}
function parse(text){try{return JSON.parse(text);}catch{fail();}}
function canonicalObject(text,keys){const x=parse(text);exact(x,keys);if(JSON.stringify(x)!==text)fail();return x;}
function options(argv){
  const mode=argv.shift();if(!['prepare','run'].includes(mode))fail();
  const o={};let command=[];
  while(argv.length){const key=argv.shift();if(key==='--'){command=argv;break;}
    if(!['--origin','--name','--env','--state'].includes(key)||!argv.length||Object.hasOwn(o,key))fail();o[key]=argv.shift();}
  if(Object.keys(o).length!==4||(mode==='prepare'?command.length!==0:command.length===0))fail();
  const origin=o['--origin'], name=o['--name'],env=o['--env'],state=o['--state'];
  let url;try{url=new URL(origin);}catch{fail();}
  if(origin.length>300||url.protocol!=='https:'||url.origin!==origin||url.username||url.password)fail();
  if(!/^[a-z][a-z0-9_/-]{0,63}$/.test(name)||name.includes('//')||name.endsWith('/'))fail();
  if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(env)||/^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|LD_.*|DYLD_.*)$/.test(env))fail();
  if(!isAbsolute(state)||resolve(state)!==state||state===dirname(state))fail();
  if(typeof process.getuid!=='function')throw new Error('This helper requires a POSIX filesystem.');
  const parent=dirname(state),s=lstatSync(parent);
  // Reject ancestor symlinks too, not merely the final directory entry.
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(parent)!==parent||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail();
  return {mode,origin,name,env,state,command};
}
function claim(o){
  // mkdir is an atomic lock; unlike rename, it never replaces a competing claim.
  const lock=`${o.state}.claim`;mkdirSync(lock,{mode:0o700});cleanupLock=lock;
  const fd=openSync(o.state,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
  try{
    const s=fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>MAX_STATE)fail();
    cleanupState={path:o.state,ino:s.ino,dev:s.dev};
    const data=readFileSync(fd,'utf8');
    // No on-disk private key remains while waiting for input or running the command.
    clean();
    const state=canonicalObject(data,['v','requestId','name','envVar','audience','createdAt','privateKey']);
    if(state.v!==1||state.name!==o.name||state.envVar!==o.env||state.audience!==o.origin||!Number.isSafeInteger(state.createdAt))fail();
    const now=Date.now();if(state.createdAt>now+5000||now-state.createdAt>300000)fail();
    if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(state.requestId))fail();
    return state;
  }finally{closeSync(fd);}
}
async function input(){
  const chunks=[];let size=0;
  // Do not keep a private key in a process blocked indefinitely on stdin.
  const timer=setTimeout(()=>process.stdin.destroy(new Error('Envelope input timeout.')),60000);
  try {
    for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)fail();chunks.push(chunk);}
    return decoder.decode(Buffer.concat(chunks));
  } finally {clearTimeout(timer);}
}
async function prepare(o){
  // Reject a live claim and never overwrite old state.
  try{lstatSync(`${o.state}.claim`);fail();}catch(e){if(e.code!=='ENOENT')throw e;}
  const pair=await subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const pub=await subtle.exportKey('jwk',pair.publicKey);
  const state={v:1,requestId:randomUUID(),name:o.name,envVar:o.env,audience:o.origin,createdAt:Date.now(),privateKey:await subtle.exportKey('jwk',pair.privateKey)};
  const fd=openSync(o.state,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
  try{const s=fstatSync(fd);cleanupState={path:o.state,ino:s.ino,dev:s.dev};writeFileSync(fd,JSON.stringify(state));}finally{closeSync(fd);}
  const request={name:o.name,publicKey:{kty:pub.kty,n:pub.n,e:pub.e},requestId:state.requestId,audience:o.origin};
  await new Promise((resolve,reject)=>process.stdout.write(`${JSON.stringify(request)}\n`,e=>e?reject(e):resolve()));
  cleanupState=null; // Deliberately retained only after public request was emitted.
}
async function run(o){
  const state=claim(o);
  const payload=parse(await input());exact(payload,['envelope']);
  if(typeof payload.envelope!=='string')fail();
  const parts=payload.envelope.split('.');if(parts.length!==5)fail();
  const [headerBytes,wrapped,iv,ciphertext,tag]=parts.map(bytes);
  const h=canonicalObject(decoder.decode(headerBytes),['alg','enc','typ','v','requestId','name','envVar','audience','issuedAt','expiresAt']);
  if(h.alg!=='RSA-OAEP-256'||h.enc!=='A256GCM'||h.typ!=='vault-envelope+jwe'||h.v!==1)fail();
  for(const key of ['requestId','name','envVar','audience'])if(h[key]!==state[key])fail();
  const now=Date.now();
  if(!Number.isSafeInteger(h.issuedAt)||!Number.isSafeInteger(h.expiresAt)||h.expiresAt-h.issuedAt!==60000||h.issuedAt>now+5000||h.issuedAt<state.createdAt-5000||now>=h.expiresAt||now-state.createdAt>300000)fail();
  if(wrapped.length!==384||iv.length!==12||tag.length!==16||ciphertext.length>65536)fail();
  const privateKey=await subtle.importKey('jwk',state.privateKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  delete state.privateKey;
  const raw=await subtle.decrypt({name:'RSA-OAEP'},privateKey,wrapped);
  let plain;
  try{
    if(raw.byteLength!==32)fail();
    const key=await subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
    plain=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(parts[0]),tagLength:128},key,Buffer.concat([ciphertext,tag])));
  }finally{new Uint8Array(raw).fill(0);}
  let decoded;try{decoded=parse(decoder.decode(plain));}finally{plain.fill(0);}
  exact(decoded,['token']);
  if(typeof decoded.token!=='string'||!decoded.token.trim()||decoded.token.length>8192||/[\r\n\0]/.test(decoded.token))fail();
  // JS strings are not securely erasable; never promise forensic memory erasure.
  const env={...process.env,[o.env]:decoded.token};decoded.token='';
  if(terminating)fail();
  child=spawn(o.command[0],o.command.slice(1),{env,stdio:'inherit'});delete env[o.env];
  return await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>{child=null;resolve(code??128+(osConstants.signals[signal]||1));});
  });
}
try{
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node 24 or newer is required.');
  const o=options(process.argv.slice(2));
  process.exitCode=o.mode==='prepare'?(await prepare(o),0):await run(o);
}catch{
  // Never include crypto, JSON, spawn or filesystem error details: they may contain data.
  process.stderr.write('Vault envelope operation failed. Check arguments/private directory, then prepare fresh state.\n');
  process.exitCode=1;
}finally{try{clean();}catch{process.stderr.write('Private state cleanup failed. Remove local state before retrying.\n');process.exitCode=1;}}
