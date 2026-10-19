import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const origin=new URL(process.argv[2] || ''),pathAuth=process.argv.includes('--path-auth');
if(origin.protocol!=='https:' || origin.origin!==process.argv[2] || origin.username || origin.password || origin.search || origin.hash)throw new Error('Pass your deployed HTTPS origin only; never pass a key or secret URL.');
const folder=resolve('.package/token-vault');await rm(folder,{recursive:true,force:true});await mkdir('.package',{recursive:true});
await cp('plugin/token-vault',folder,{recursive:true});await mkdir(`${folder}/skills/token-vault/scripts`,{recursive:true});await cp('cli/vault-cli.mjs',`${folder}/skills/token-vault/scripts/vault-cli.mjs`);
const config=JSON.parse(await readFile('plugin/mcp.json.template','utf8')),server=config.mcpServers['token-vault'];server.url=`${origin.origin}/mcp`;
if(pathAuth){server.extensions['com.openai'].auth={type:'none'};server.extensions['com.openai'].urlTemplates=['https://{vault_host}/mcp/{vault_token}'];}
await writeFile(`${folder}/mcp.json`,JSON.stringify(config,null,2)+'\n');
const archive=resolve('.package/token-vault.tar.gz');
const result=spawnSync('tar',['-czf',archive,'-C',resolve('.package'),'token-vault'],{stdio:'inherit',shell:false});if(result.status!==0)throw new Error('tar packaging failed.');
console.log(`Created ${archive}. No connection key was packaged. Configure connection values in the host; actual UI support must be verified there.`);
