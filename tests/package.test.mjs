import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,stat,rm,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
const packager=resolve('scripts/package-plugin.mjs');
async function fixture(t,{env=true}={}) {
 const dir=await mkdtemp(join(tmpdir(),'vault-package-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const key=randomBytes(32).toString('hex'),encryption=randomBytes(32).toString('base64'),provider=`provider-${randomBytes(24).toString('hex')}`;
 if(env)await writeFile(join(dir,'.env'),`PUBLIC_ORIGIN=https://vault.example.com\nMCP_ACCESS_KEY=${key}\nVAULT_ENCRYPTION_KEY=${encryption}\nGH_TOKEN=${provider}\n`,{mode:0o600});
 const build=(args=[],extra={})=>spawnSync(process.execPath,[packager,...args],{cwd:dir,encoding:'utf8',...extra});
 return {dir,key,encryption,provider,build};
}
function extract(archive,path) {
 const result=spawnSync('tar',['-xOf',archive,`token-vault/${path}`],{encoding:'utf8'});assert.equal(result.status,0);return result.stdout;
}
test('packaged SKILL includes the exact verified helper and its runnable prepare prints only a public challenge',async t=>{
 const {dir,build}=await fixture(t,{env:false});const built=build(['https://vault.example.com','--public']);assert.equal(built.status,0);
 const archive=join(dir,'artifacts/token-vault.tar.gz');
 const helper=extract(archive,'skills/token-vault/scripts/vault-cli.sh'),source=await readFile('cli/vault-cli.sh','utf8');assert.equal(helper,source);
 const integrity=JSON.parse(extract(archive,'skills/token-vault/references/helper-integrity.json'));assert.equal(integrity.sha256,createHash('sha256').update(helper).digest('hex'));
 assert.equal(spawnSync('/bin/sh',['-n'],{input:helper}).status,0);
 const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'}).stdout;
 assert.equal(listing.split('\n').filter(path=>path.includes('scripts/')&&!path.endsWith('/')).length,1);
 assert.ok(!listing.includes('vault-cli.mjs')&&!listing.includes('shell-helper-integrity.json')&&!listing.includes('vault-upload.sh'));
 assert.match(extract(archive,'skills/token-vault/SKILL.md'),/--state/);assert.match(extract(archive,'skills/token-vault/SKILL.md'),/claimChallenge/);
 assert.equal(spawnSync('tar',['-xzf',archive,'-C',dir]).status,0);
 const statePath=join(dir,'test.claim.state'),script=join(dir,'token-vault/skills/token-vault/scripts/vault-cli.sh');
 const result=spawnSync('/bin/sh',[script,'prepare','--origin','https://vault.example.com','--env','GH_TOKEN','--state',statePath],{encoding:'utf8'});assert.equal(result.status,0);
 const output=JSON.parse(result.stdout),verifier=(await readFile(statePath,'utf8')).trimEnd().split('\n')[4];
 assert.equal(output.claimChallenge,createHash('sha256').update(verifier).digest('base64url'));assert.ok(!result.stdout.includes(verifier));assert.equal((await stat(statePath)).mode&0o777,0o600);
});

test('default private tar embeds only the MCP key, preserves fixed auth and leaves no staging secrets',async t=>{
 const {dir,key,encryption,provider,build}=await fixture(t);
 const result=build();assert.equal(result.status,0);
 const logs=result.stdout+result.stderr;for(const secret of [key,encryption,provider])assert.ok(!logs.includes(secret),'packaging logs must not contain secrets');
 const archive=join(dir,'artifacts/token-vault-private.tar.gz');
 const config=JSON.parse(extract(archive,'mcp.json')),legacyConfig=JSON.parse(extract(archive,'.mcp.json'));
 const server=config.mcpServers['token-vault'];assert.ok(server.url===`https://vault.example.com/mcp/${key}`);
 assert.deepEqual(server.extensions,{'com.openai':{auth:{type:'none'}}});
 assert.ok(legacyConfig.mcpServers['token-vault'].url===server.url);
 const root=JSON.parse(extract(archive,'plugin.json')),overlay=JSON.parse(extract(archive,'.codex-plugin/plugin.json'));
 assert.equal(root.name,overlay.name);assert.equal(root.version,overlay.version);assert.equal(overlay.mcpServers,'./.mcp.json');
 const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});assert.equal(listing.status,0);
 for(const path of listing.stdout.trim().split('\n')) {
   assert.ok(path.startsWith('token-vault/'));assert.ok(!/\.env|sqlite|claim\.json|node_modules/.test(path));
   if(path.endsWith('/'))continue;
   const value=extract(archive,path.slice('token-vault/'.length));
   assert.ok(!value.includes(encryption)&&!value.includes(provider),'only the MCP connection key may be included');
   if(!['token-vault/mcp.json','token-vault/.mcp.json'].includes(path))assert.ok(!value.includes(key));
 }
 if(process.platform!=='win32')assert.equal((await stat(archive)).mode&0o777,0o600);
 assert.deepEqual(await readdir(join(dir,'artifacts')),['token-vault-private.tar.gz']);
});

test('public mode omits all keys even when a credential .env is present',async t=>{
 const {dir,key,encryption,provider,build}=await fixture(t);
 const result=build(['--public']);assert.equal(result.status,0);
 const archive=join(dir,'artifacts/token-vault.tar.gz');
 const config=JSON.parse(extract(archive,'mcp.json'));assert.equal(config.mcpServers['token-vault'].url,'https://vault.example.com/mcp');
 assert.deepEqual(config.mcpServers['token-vault'].extensions,{'com.openai':{auth:{type:'api_key',headerScheme:'bearer'}}});
 const unpacked=spawnSync('tar',['-xOf',archive],{encoding:'utf8'});assert.equal(unpacked.status,0);
 for(const secret of [key,encryption,provider])assert.ok(!unpacked.stdout.includes(secret));
});

test('packaging fails closed for missing credentials, wrong origin and invalid CLI options',async t=>{
 const f=await fixture(t);
 for(const args of [['https://different.example.com'],['https://vault.example.com/mcp/'+f.key],['--token',f.key],['--public','--path-auth'],['--env-file','missing.env']]) {
   const result=f.build(args);assert.notEqual(result.status,0);assert.ok(!(result.stdout+result.stderr).includes(f.key));
 }
 await writeFile(join(f.dir,'.env'),'PUBLIC_ORIGIN=https://vault.example.com\nMCP_ACCESS_KEY=invalid-secret-value\n');
 const invalid=f.build();assert.notEqual(invalid.status,0);assert.ok(!(invalid.stdout+invalid.stderr).includes('invalid-secret-value'));
 const empty=await fixture(t,{env:false});assert.notEqual(empty.build().status,0);
 assert.ok(!(await readdir(f.dir)).includes('artifacts'));
});

test('tar failure removes private staging files, and alternate env/output paths work',async t=>{
 const {dir,key,build}=await fixture(t);
 const failure=build([],{env:{...process.env,PATH:''}});assert.notEqual(failure.status,0);assert.ok(!(failure.stdout+failure.stderr).includes(key));
 assert.deepEqual(await readdir(join(dir,'artifacts')),[]);
 const result=build(['--env-file',join(dir,'.env'),'--output-dir',join(dir,'exports'),'--path-auth']);assert.equal(result.status,0);
 assert.ok((await stat(join(dir,'exports/token-vault-private.tar.gz'))).isFile());
});
