import test from 'node:test';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {encryptSecret} from '../.test-build/security.mjs';
test('workerd and local D1 issue an interoperable encrypted envelope',async()=>{
const origin='https://vault.example',storage=randomBytes(32).toString('base64'),auth=randomBytes(32).toString('hex'),token='synthetic-worker-envelope-only';
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'vault',modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-10-01',d1Databases:['DB'],bindings:{PUBLIC_ORIGIN:origin,VAULT_ENCRYPTION_KEY:storage,MCP_ACCESS_KEY:auth}}]}));
try{
 const db=await mf.getD1Database('DB','vault');for(const p of readdirSync('migrations').sort()){for(const sql of readFileSync('migrations/'+p,'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();}
 const id=randomUUID();await db.prepare('INSERT INTO credentials(id,user_id,name,env_var,encrypted_token,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,'owner','github/test','GH_TOKEN',await encryptSecret(token,`owner:${id}`,storage),randomUUID(),new Date().toISOString(),new Date().toISOString()).run();
 const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);const {kty,n,e}=await crypto.subtle.exportKey('jwk',pair.publicKey);
 const response=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_token_envelope',arguments:{name:'github/test',requestId:randomUUID(),audience:origin,publicKey:{kty,n,e}}}})});
 const result=await response.json();assert(!result.result.isError,JSON.stringify(result));assert(!JSON.stringify(result).includes(token));const [h,w,iv,c,t]=result.result.structuredContent.envelope.split('.');
 const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},pair.privateKey,Buffer.from(w,'base64url'));const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(iv,'base64url'),additionalData:new TextEncoder().encode(h)},key,Buffer.concat([Buffer.from(c,'base64url'),Buffer.from(t,'base64url')]));assert.equal(JSON.parse(new TextDecoder().decode(plain)).token,token);
}finally{await mf.dispose();}

});
