// Docker adapter. Cloudflare production uses native D1; SQLite implements the same small interface.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
export function sqliteDB(path=':memory:') {
 if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const sqlite=new DatabaseSync(path);sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort()) {
  if(sqlite.prepare('SELECT name FROM schema_migrations WHERE name=?').get(file))continue;
  sqlite.exec('BEGIN');try{sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));sqlite.prepare('INSERT INTO schema_migrations VALUES(?)').run(file);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
 }
 class Statement {
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.args)};}
  first(){return this.all().results[0] || null;}
  run(){sqlite.prepare(this.sql).run(...this.args);return {success:true};}
 }
 return {prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const result=statements.map(x=>x.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},close:()=>sqlite.close()};
}
