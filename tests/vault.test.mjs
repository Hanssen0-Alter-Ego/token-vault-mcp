import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {VaultService} from '../.test-build/vault-service.mjs';
const verifier=randomBytes(32).toString('base64url');
const claimChallenge=createHash('sha256').update(verifier).digest('base64url');
const redeem=(service,kind,ticket,token)=>service.redeem(kind,ticket,token,verifier);
function fixture(origin='https://claim.example') {
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
 class Statement {
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.args)};}
  first(){return this.all().results[0] || null;}
  run(){sqlite.prepare(this.sql).run(...this.args);return {success:true};}
 }
 const db={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const result=statements.map(s=>s.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 let now=Date.now();const service=new VaultService(db,randomBytes(32).toString('base64'),origin,()=>now);
 return {service,sqlite,advance:delta=>{now+=delta;}};
}
const input={name:'github/main',provider:'github',envVar:'GH_TOKEN',allowAgentUse:true,token:'synthetic-token-only'};
const claim=link=>new URL(link.url).hash.slice(1);
test('users can only issue links for their own credentials and metadata never contains ciphertext or token',async()=>{
 const {service}=fixture();await service.save('alice',input);
 assert.equal((await service.list('bob')).length,0);
 await assert.rejects(service.issue('bob','read',{name:input.name,claimChallenge,purpose:'test'}));
 assert.ok(!JSON.stringify(await service.list('alice')).includes(input.token));
 assert.ok(!JSON.stringify(await service.list('alice')).includes('encrypted'));
 await assert.rejects(service.save('alice',input),e=>e.status===409);
 await service.save('bob',{...input,token:'synthetic-bob'});
 const link=await service.issue('bob','read',{name:input.name,claimChallenge,purpose:'test'});
 assert.equal((await redeem(service,'read',claim(link))).token,'synthetic-bob');
});
test('read links expire at exactly 60 seconds and are consumed once across concurrent claims',async()=>{
 const {service,advance,sqlite}=fixture();await service.save('alice',input);
 const link=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'gh repo view'});
 assert.ok(!JSON.stringify(link).includes(input.token));
 assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM handoffs').all()).includes(claim(link)));
 const results=await Promise.allSettled(Array.from({length:8},()=>redeem(service,'read',claim(link))));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.find(x=>x.status==='fulfilled').value.token,input.token);
 const expired=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'});advance(60000);
 await assert.rejects(redeem(service,'read',claim(expired)),e=>e.status===410);
 assert.ok(!JSON.stringify(await service.recent('alice')).includes(input.token));
 assert.ok(!JSON.stringify(await service.recent('alice')).includes(claim(link)));
});
test('Agent opt-in, updates and deletion revoke prior grants',async()=>{
 const {service}=fixture();await service.save('alice',{...input,allowAgentUse:false});
 await assert.rejects(service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'}),e=>e.status===403);
 await service.save('alice',{...input,overwrite:true});
 const one=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'});
 await service.save('alice',{...input,overwrite:true,token:'synthetic-new'});
 await assert.rejects(redeem(service,'read',claim(one)),e=>e.status===410);
 const two=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'});await service.remove('alice',input.name);
 await assert.rejects(redeem(service,'read',claim(two)),e=>e.status===410);
});
test('write links upload directly, require explicit overwrite and reject stale writes',async()=>{
 const {service}=fixture();const fields={...input,token:undefined,claimChallenge,purpose:'save process token'};
 const upload=await service.issue('alice','write',fields);
 // Wrong operation and malformed upload cannot consume the valid write grant.
 await assert.rejects(redeem(service,'read',claim(upload)),e=>e.status===410);
 await assert.rejects(redeem(service,'write',claim(upload),'bad\nvalue'));
 await redeem(service,'write',claim(upload),'synthetic-upload');
 await assert.rejects(redeem(service,'write',claim(upload),'synthetic-repeat'),e=>e.status===410);
 await assert.rejects(service.issue('alice','write',fields),e=>e.status===409);
 const update=await service.issue('alice','write',{...fields,overwrite:true});
 await service.save('alice',{...input,overwrite:true});
 await assert.rejects(redeem(service,'write',claim(update),'synthetic-stale'));
 const read=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'});assert.equal((await redeem(service,'read',claim(read))).token,input.token);
});
test('read is fail-closed on audit failure and cannot be retried with same grant',async()=>{
 const {service,sqlite}=fixture();await service.save('alice',input);
 const link=await service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'});
 sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON activity WHEN NEW.action='read.redeemed' BEGIN SELECT RAISE(ABORT,'synthetic audit outage'); END;");
 await assert.rejects(redeem(service,'read',claim(link)));
 await assert.rejects(redeem(service,'read',claim(link)),e=>e.status===410);
});
test('no vault origin configuration means no unusable claim URL is issued',async()=>{
 const {service}=fixture('');await service.save('alice',input);
 await assert.rejects(service.issue('alice','read',{name:input.name,claimChallenge,purpose:'test'}),e=>e.status===503);
});

test('link alone, missing verifier, wrong verifier and public hash cannot consume the grant',async()=>{
 const {service,sqlite}=fixture();await service.save('alice',input);
 await assert.rejects(service.issue('alice','read',{name:input.name,purpose:'missing challenge'}));
 await assert.rejects(service.issue('alice','read',{name:input.name,purpose:'plaintext verifier',claimChallenge:'invalid'}));
 const link=await service.issue('alice','read',{name:input.name,purpose:'proof binding',claimChallenge});
 for(const secret of [undefined,'',randomBytes(32).toString('base64url'),claimChallenge])await assert.rejects(service.redeem('read',claim(link),undefined,secret),e=>e.status===403);
 assert.equal(sqlite.prepare('SELECT used_at FROM handoffs').get().used_at,null);
 const events=await service.recent('alice');assert.equal(events.filter(x=>x.action==='read.proof_rejected').length,4);
 const metadata=JSON.stringify({link,events});assert.ok(!metadata.includes(verifier));
 assert.equal((await service.redeem('read',claim(link),undefined,verifier)).token,input.token);
});
test('proof for one grant does not unlock a grant bound to a different terminal',async()=>{
 const {service}=fixture();await service.save('alice',input);
 const another=randomBytes(32).toString('base64url'),anotherHash=createHash('sha256').update(another).digest('base64url');
 const a=await service.issue('alice','read',{name:input.name,purpose:'terminal A',claimChallenge});
 const b=await service.issue('alice','read',{name:input.name,purpose:'terminal B',claimChallenge:anotherHash});
 await assert.rejects(service.redeem('read',claim(b),undefined,verifier),e=>e.status===403);
 assert.equal((await service.redeem('read',claim(a),undefined,verifier)).token,input.token);
 assert.equal((await service.redeem('read',claim(b),undefined,another)).token,input.token);
});
test('legacy grants without a bound challenge fail closed',async()=>{
 const {service,sqlite}=fixture();await service.save('alice',input);
 const link=await service.issue('alice','read',{name:input.name,purpose:'legacy grant',claimChallenge});
 sqlite.exec("UPDATE handoffs SET config=json_remove(config,'$.claimChallenge')");
 await assert.rejects(service.redeem('read',claim(link),undefined,verifier),e=>e.status===403);
});
