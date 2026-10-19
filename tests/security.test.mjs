import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {encryptSecret,decryptSecret,assertSameOrigin,validateName,validateEnvVar,readJSON,redemptionOrigin} from '../.test-build/security.mjs';
test('authenticated encryption uses random nonces and binds ciphertext to user and record',async()=>{
 const key=randomBytes(32).toString('base64'),value='synthetic-only';
 const a=await encryptSecret(value,'a:one',key),b=await encryptSecret(value,'a:one',key);
 assert.notEqual(a,b);assert.ok(!a.includes(value));assert.equal(await decryptSecret(a,'a:one',key),value);
 for(const identity of ['b:one','a:two'])await assert.rejects(decryptSecret(a,identity,key));
 await assert.rejects(decryptSecret(a,'a:one',randomBytes(32).toString('base64')));
 const damaged=JSON.parse(a);damaged.ciphertext='AAAA';await assert.rejects(decryptSecret(JSON.stringify(damaged),'a:one',key));
});
test('browser mutations, environment names and configured gateway origins are validated',()=>{
 assert.doesNotThrow(()=>assertSameOrigin(new Request('https://vault.example/api',{headers:{Origin:'https://vault.example'}})));
 assert.throws(()=>assertSameOrigin(new Request('https://vault.example/api',{headers:{Origin:'https://evil.example'}})));
 assert.throws(()=>assertSameOrigin(new Request('https://vault.example/api')));
 assert.equal(validateName('github/main'),'github/main');assert.throws(()=>validateName('../other'));
 assert.equal(validateEnvVar('GH_TOKEN'),'GH_TOKEN');for(const v of ['NODE_OPTIONS','PATH','LD_PRELOAD','A;exit'])assert.throws(()=>validateEnvVar(v));
 for(const value of [undefined,'http://evil.example','https://user:pass@host.example','https://host.example/path','https://host.example?x=1'])assert.throws(()=>redemptionOrigin(value));
});
test('JSON parsing refuses unbounded or non-JSON input',async()=>{
 await assert.rejects(readJSON(new Request('https://vault.example',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})));
 await assert.rejects(readJSON(new Request('https://vault.example',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:'a'.repeat(1000)})}),100));
});
