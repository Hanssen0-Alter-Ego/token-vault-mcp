import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';

const uploader=resolve('cli/vault-upload.sh');
const hasPTY=process.platform==='linux'&&spawnSync('script',['--version'],{encoding:'utf8'}).stdout?.includes('util-linux');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";

// A real terminal exercises hidden input and traps. curl is replaced locally;
// this fixture never reaches /admin/tokens or reads real credentials.
async function terminal(t,{overwrite=false,fail=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'vault-manual-test-')),bin=join(dir,'bin');
 t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(bin);
 const master=randomBytes(32).toString('hex'),token='synthetic-"quote"\\slash\ttab$(not-executed)';
 await writeFile(join(bin,'curl'),`#!${process.execPath}
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
const args=process.argv.slice(2);
assert.equal(args[0],'-q');
assert.equal(args.at(-1),process.env.TEST_ORIGIN+'/admin/tokens');
assert.ok(!args.includes('-L')&&!args.includes('--location'));
const header=args[args.indexOf('--header')+1].slice(1);
const body=args[args.indexOf('--data-binary')+1].slice(1);
assert.equal(statSync(header).mode&0o777,0o600);
assert.equal(statSync(body).mode&0o777,0o600);
assert.equal(statSync(dirname(body)).mode&0o777,0o700);
assert.equal(readFileSync(header,'utf8'),'Authorization: Bearer '+process.env.TEST_MASTER+'\\n');
assert.deepEqual(JSON.parse(readFileSync(body,'utf8')),{name:'test/manual',envVar:'GH_TOKEN',overwrite:process.env.TEST_OVERWRITE==='true',token:process.env.TEST_VALUE});
for(const secret of [process.env.TEST_MASTER,process.env.TEST_VALUE])assert.ok(!args.join(' ').includes(secret));
assert.equal(process.env.vault_master,undefined);assert.equal(process.env.vault_value,undefined);
writeFileSync(process.env.TEST_MARKER,'checked');
if(process.env.TEST_FAIL==='true'){console.error('curl: HTTP 409');process.exit(22);}
console.log('{"stored":true}');
`,{mode:0o700});
 const marker=join(dir,'checked');
 const env={...process.env,PATH:bin+':'+process.env.PATH,TMPDIR:dir,TEST_MASTER:master,TEST_VALUE:token,TEST_OVERWRITE:String(overwrite),TEST_FAIL:String(fail),TEST_MARKER:marker,TEST_ORIGIN:'https://users-own-vault.example:8443'};
 const args=['/bin/sh',uploader,'--origin',env.TEST_ORIGIN,'test/manual','GH_TOKEN',...(overwrite?['--overwrite']:[])];
 const result=await new Promise((resolve,reject)=>{
   const child=spawn('script',['-q','-e','-c',args.map(quote).join(' '),'/dev/null'],{env,stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='',sent=0;
   const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Terminal test timed out'));},10000);
   child.on('error',error=>{clearTimeout(timeout);reject(error);});
   child.stdin.on('error',()=>{});
   child.stdout.on('data',data=>{
     stdout+=data;
     if(sent===0&&stdout.includes('MCP_ACCESS_KEY (hidden): ')){child.stdin.write(master+'\n');sent=1;}
     if(sent===1&&stdout.includes('Service Token, one line (hidden): ')){child.stdin.write(token+'\n');sent=2;}
   });
   child.stderr.on('data',data=>stderr+=data);
   child.on('close',code=>{clearTimeout(timeout);resolve({code,stdout,stderr});});
 });
 assert.equal(await readFile(marker,'utf8'),'checked');
 assert.equal(result.code,fail?22:0,result.stdout+result.stderr);
 for(const secret of [master,token])assert.ok(!(result.stdout+result.stderr).includes(secret));
 assert.deepEqual((await readdir(dir)).sort(),['bin','checked']);
 return result;
}

test('manual uploader uses the explicit origin, hides input and correctly encodes create/update requests',{skip:!hasPTY&&'Requires Linux util-linux script for a real terminal'},async t=>{
 for(const overwrite of [false,true])assert.match((await terminal(t,{overwrite})).stdout,/\{"stored":true\}/);
});

test('manual uploader preserves HTTP failure exit code and removes private files',{skip:!hasPTY&&'Requires Linux util-linux script for a real terminal'},async t=>{
 const result=await terminal(t,{overwrite:true,fail:true});assert.match(result.stdout+result.stderr,/409/);
});

test('manual uploader requires an HTTPS origin and valid names before reading credentials',()=>{
 const call=args=>spawnSync('/bin/sh',[uploader,...args],{encoding:'utf8'});
 assert.equal(call(['--help']).status,0);
 for(const args of [
   ['test/name','GH_TOKEN'],
   ...['http://vault.example','https://vault.example/','https://vault.example/path','https://vault.example?key=secret','https://vault.example#secret','https://user:secret@vault.example','https://vault.example\nhttps://other.example'].map(origin=>['--origin',origin,'test/name','GH_TOKEN']),
   ['--origin','https://vault.example','bad"name','GH_TOKEN'],
   ['--origin','https://vault.example','test/name','GH_TOKEN;exit'],
   ['--origin','https://vault.example','test/name','GH_TOKEN','--wrong'],
 ]){
   const result=call(args);assert.equal(result.status,2);assert.ok(!result.stdout.includes('hidden')&&!result.stderr.includes('MCP_ACCESS_KEY (hidden)'));
 }
});
