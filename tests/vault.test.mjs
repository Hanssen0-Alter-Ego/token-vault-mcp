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
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
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
const input={name:'github/main',envVar:'GH_TOKEN',token:'synthetic-token-only'};
const claim=link=>new URL(link.url).hash.slice(1);
const fields={name:input.name,envVar:input.envVar,claimChallenge};
test('metadata is owner-isolated and secret-free; writes require explicit overwrite',async()=>{
 const {service}=fixture();await service.save('alice',input);
 assert.deepEqual(await service.list('bob'),[]);
 assert.ok(!JSON.stringify(await service.list('alice')).includes(input.token));
 assert.ok(!JSON.stringify(await service.list('alice')).includes('encrypted'));
 await assert.rejects(service.save('alice',input),e=>e.status===409);
 const link=await service.issue('bob','write',fields);await redeem(service,'write',claim(link),'synthetic-bob');
 assert.equal((await service.list('alice')).length,1);assert.equal((await service.list('bob')).length,1);
});
test('legacy read issuance and redemption are rejected even with an existing grant',async()=>{
 const {service,sqlite}=fixture();await service.save('alice',input);
 await assert.rejects(service.issue('alice','read',{name:input.name,claimChallenge}),e=>e.status===410);
 const link=await service.issue('alice','write',{...fields,overwrite:true});
 sqlite.exec("UPDATE handoffs SET kind='read'");
 await assert.rejects(redeem(service,'read',claim(link)),e=>e.status===410);
 await assert.rejects(redeem(service,'write',claim(link),'synthetic'),e=>e.status===410);
 assert.equal(sqlite.prepare('SELECT used_at FROM handoffs').get().used_at,null);
});
test('write links expire at 60 seconds and concurrent claims succeed once',async()=>{
 const {service,advance,sqlite}=fixture();const link=await service.issue('alice','write',fields);
 assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM handoffs').all()).includes(claim(link)));
 const results=await Promise.allSettled(Array.from({length:8},()=>redeem(service,'write',claim(link),input.token)));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const expired=await service.issue('alice','write',{...fields,name:'test/expiry'});advance(60000);
 await assert.rejects(redeem(service,'write',claim(expired),input.token),e=>e.status===410);
 const audit=JSON.stringify(await service.recent('alice'));assert.ok(!audit.includes(input.token));assert.ok(!audit.includes(claim(link)));
});
test('updates and deletion invalidate outstanding write grants; malformed uploads do not consume',async()=>{
 const {service}=fixture();const first=await service.issue('alice','write',fields);
 await assert.rejects(redeem(service,'write',claim(first),'bad\nvalue'));
 await redeem(service,'write',claim(first),input.token);
 await assert.rejects(service.issue('alice','write',fields),e=>e.status===409);
 const stale=await service.issue('alice','write',{...fields,overwrite:true});
 await service.save('alice',{...input,overwrite:true,token:'synthetic-new'});
 await assert.rejects(redeem(service,'write',claim(stale),'synthetic-stale'),e=>e.status===410);
 const deleted=await service.issue('alice','write',{...fields,overwrite:true});await service.remove('alice',input.name);
 await assert.rejects(redeem(service,'write',claim(deleted),'synthetic-stale'),e=>e.status===410);
});
test('write audit failure rolls back credential and same grant cannot be retried',async()=>{
 const {service,sqlite}=fixture();const link=await service.issue('alice','write',fields);
 sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON activity WHEN NEW.action='credential.created' BEGIN SELECT RAISE(ABORT,'synthetic audit outage'); END;");
 await assert.rejects(redeem(service,'write',claim(link),input.token));
 assert.deepEqual(await service.list('alice'),[]);
 await assert.rejects(redeem(service,'write',claim(link),input.token),e=>e.status===410);
});
test('write link needs valid origin and proof; failed proofs do not consume grant',async()=>{
 await assert.rejects(fixture('').service.issue('alice','write',fields),e=>e.status===503);
 const {service,sqlite}=fixture();
 for(const challenge of [undefined,'invalid'])await assert.rejects(service.issue('alice','write',{...fields,claimChallenge:challenge}));
 const link=await service.issue('alice','write',fields);
 for(const proof of [undefined,'',randomBytes(32).toString('base64url'),claimChallenge])await assert.rejects(service.redeem('write',claim(link),input.token,proof),e=>e.status===403);
 assert.equal(sqlite.prepare('SELECT used_at FROM handoffs').get().used_at,null);
 const events=await service.recent('alice');assert.equal(events.filter(x=>x.action==='write.proof_rejected').length,4);
 assert.ok(!JSON.stringify({link,events}).includes(verifier));await redeem(service,'write',claim(link),input.token);
});
test('proofs cannot cross write grants and legacy unbound grants fail closed',async()=>{
 const {service,sqlite}=fixture(),another=randomBytes(32).toString('base64url');
 const a=await service.issue('alice','write',{...fields,name:'test/a'});
 const b=await service.issue('alice','write',{...fields,name:'test/b',claimChallenge:createHash('sha256').update(another).digest('base64url')});
 await assert.rejects(service.redeem('write',claim(b),input.token,verifier),e=>e.status===403);
 await service.redeem('write',claim(a),input.token,verifier);await service.redeem('write',claim(b),input.token,another);
 const c=await service.issue('alice','write',{...fields,name:'test/c'});sqlite.exec("UPDATE handoffs SET config=json_remove(config,'$.claimChallenge')");
 await assert.rejects(service.redeem('write',claim(c),input.token,verifier),e=>e.status===403);
});
