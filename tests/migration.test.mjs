import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {sqliteDB} from '../src/sqlite.mjs';
import {VaultService} from '../.test-build/vault-service.mjs';
import {encryptSecret} from '../.test-build/security.mjs';

test('upgrade preserves encrypted credentials and audit history; both old Agent-use settings become readable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vault-upgrade-')),path=join(dir,'vault.sqlite');
 let db;
 t.after(async()=>{db?.close();await rm(dir,{recursive:true,force:true});});
 const old=new DatabaseSync(path);
 old.exec(await readFile('migrations/0001_initial.sql','utf8'));
 old.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)');
 old.prepare('INSERT INTO schema_migrations VALUES(?)').run('0001_initial.sql');
 const key=randomBytes(32).toString('base64'),rows=[];
 for(const flag of [0,1]){
   const name=`legacy/token-${flag}`,id=randomBytes(16).toString('hex'),token=randomBytes(32).toString('hex');
   const encrypted=await encryptSecret(token,`owner:${id}`,key),now=new Date().toISOString();
   old.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'owner',name,'github','GH_TOKEN',encrypted,flag,'legacy-revision',now,now);
   rows.push({name,id,token,encrypted});
 }
 old.prepare('INSERT INTO activity VALUES(?,?,?,?,?,?,?)').run('old-audit','owner',rows[0].name,'credential.created','vault',200,new Date().toISOString());
 old.prepare('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?)').run('old-grant','owner',rows[0].name,'read','{}','legacy purpose',Date.now()+60000,null);
 old.close();
 db=sqliteDB(path);
 const service=new VaultService(db,key,'https://vault.example');
 assert.equal((await service.list('owner')).length,2);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs').first().n,0);
 const audit=await service.recent('owner');assert.equal(audit[0].action,'credential.created');
 assert.deepEqual(Object.keys(audit[0]).sort(),['action','createdAt','credentialName','status']);
 for(const row of rows){
   const saved=db.prepare('SELECT * FROM credentials WHERE name=?').bind(row.name).first();
   assert.equal(saved.id,row.id);assert.equal(saved.encrypted_token,row.encrypted);
   assert.deepEqual(Object.keys((await service.list('owner')).find(item=>item.name===row.name)).sort(),['envVar','name','updatedAt']);
   const verifier=randomBytes(32).toString('base64url'),claimChallenge=createHash('sha256').update(verifier).digest('base64url');
   const link=await service.issue('owner','read',{name:row.name,claimChallenge});
   const result=await service.redeem('read',new URL(link.url).hash.slice(1),undefined,verifier);
   assert.equal(result.token,row.token);assert.equal(result.envVar,'GH_TOKEN');
 }
 // The same migration runner must reopen the upgraded database without reapplying DROP COLUMN.
 db.close();db=sqliteDB(path);
 assert.equal((await new VaultService(db,key,'https://vault.example').list('owner')).length,2);
});
