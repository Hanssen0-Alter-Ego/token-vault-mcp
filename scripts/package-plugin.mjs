import {chmod,copyFile,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
class PackageError extends Error {}
const help=`Usage: npm run plugin:build -- [https://YOUR_VAULT_HOST] [--public] [--env-file .env] [--output-dir artifacts]

Default: read PUBLIC_ORIGIN and MCP_ACCESS_KEY from .env and create artifacts/token-vault-private.tar.gz.
The private archive contains the MCP access key in a fixed URL. Keep it private.
--public creates token-vault.tar.gz without a key, for hosts that configure Bearer authentication.
Neither mode includes the encryption key, provider tokens or .env. Node.js 24+ and tar are required.
--path-auth is accepted as an alias for the default private mode.`;

function options(argv) {
  const o={public:false,envFile:resolve('.env'),outputDir:resolve('artifacts')};
  const seen=new Set();
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--help'){o.help=true;continue;}
    if(arg==='--public'||arg==='--path-auth') {
      if(seen.has(arg))throw new PackageError('Repeated option. Use --help for usage.');
      seen.add(arg);if(arg==='--public')o.public=true;continue;
    }
    if(arg==='--env-file'||arg==='--output-dir') {
      if(seen.has(arg)||!argv[i+1]||argv[i+1].startsWith('--'))throw new PackageError('Missing or repeated option. Use --help for usage.');
      seen.add(arg);o[arg==='--env-file'?'envFile':'outputDir']=resolve(argv[++i]);continue;
    }
    if(arg.startsWith('--')||o.origin)throw new PackageError('Unknown option. Never pass a key or a secret URL as an argument.');
    o.origin=arg;
  }
  if(o.public&&seen.has('--path-auth'))throw new PackageError('--public and --path-auth cannot be combined.');
  return o;
}

function originOf(value) {
  try {
    const url=new URL(value);
    if(url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password)return value;
  }catch{}
  throw new PackageError('Set PUBLIC_ORIGIN to an HTTPS origin without a path, query, fragment or trailing slash.');
}

async function main() {
  const o=options(process.argv.slice(2));
  if(o.help){console.log(help);return;}
  let env={};
  try{env=parseEnv(await readFile(o.envFile,'utf8'));}
  catch(e){if(!o.public||e.code!=='ENOENT')throw new PackageError('Cannot read the local .env file. Use --env-file for another location, or --public to omit the key.');}
  const origin=originOf(o.origin??env.PUBLIC_ORIGIN);
  let key;
  if(!o.public) {
    if(originOf(env.PUBLIC_ORIGIN)!==origin)throw new PackageError('The requested origin does not match PUBLIC_ORIGIN in the credential file.');
    key=env.MCP_ACCESS_KEY;
    if(!/^[a-f0-9]{64}$/.test(key??''))throw new PackageError('MCP_ACCESS_KEY must be the existing 64-character lowercase hexadecimal key in .env.');
  }

  const mask=process.umask(0o077);let stage;
  try {
    await mkdir(o.outputDir,{recursive:true,mode:0o700});
    stage=await mkdtemp(join(o.outputDir,'.token-vault-build-'));
    const folder=join(stage,'token-vault');await mkdir(folder,{mode:0o700});
    // Explicit allowlist: never copy project credentials, databases or unrelated files.
    const files=['plugin.json','assets/icon.svg','skills/token-vault/SKILL.md'];
    for(const file of files) {
      const destination=join(folder,file);await mkdir(dirname(destination),{recursive:true,mode:0o700});
      await copyFile(join(root,'plugin/token-vault',file),destination);await chmod(destination,0o600);
    }
    const helper=await readFile(join(root,'cli/vault-cli.mjs'),'utf8');
    const hash=createHash('sha256').update(helper).digest('hex');
    await mkdir(join(folder,'skills/token-vault/scripts'),{recursive:true,mode:0o700});
    await mkdir(join(folder,'skills/token-vault/references'),{recursive:true,mode:0o700});
    await writeFile(join(folder,'skills/token-vault/scripts/vault-cli.mjs'),helper,{mode:0o600});
    await writeFile(join(folder,'skills/token-vault/references/helper-integrity.json'),JSON.stringify({algorithm:'sha256',sha256:hash},null,2)+'\n',{mode:0o600});

    const config=JSON.parse(await readFile(join(root,'plugin/mcp.json.template'),'utf8'));
    const server=config.mcpServers['token-vault'];
    server.url=o.public?`${origin}/mcp`:`${origin}/mcp/${key}`;
    server.extensions={'com.openai':{auth:o.public?{type:'api_key',headerScheme:'bearer'}:{type:'none'}}};
    await writeFile(join(folder,'mcp.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});

    const manifest=JSON.parse(await readFile(join(folder,'plugin.json'),'utf8'));
    await mkdir(join(folder,'.codex-plugin'),{mode:0o700});
    const legacy={name:manifest.name,version:manifest.version,description:manifest.description,author:manifest.author,interface:manifest.extensions['com.openai'].interface,skills:'./skills',mcpServers:'./.mcp.json'};
    await writeFile(join(folder,'.codex-plugin/plugin.json'),JSON.stringify(legacy,null,2)+'\n',{mode:0o600});
    await writeFile(join(folder,'.mcp.json'),JSON.stringify({mcpServers:{'token-vault':{...server,type:'http'}}},null,2)+'\n',{mode:0o600});
    const note=o.public?'This archive contains no connection key. Configure Bearer authentication in a host that supports it.':'PRIVATE ARCHIVE: contains the MCP master access key. Anyone with this archive can access the entire vault. Do not publish or forward it.';
    await writeFile(join(folder,'INSTALL.md'),`# Token Vault installation\n\n${note}\n\nUpload this tar.gz to a private Plugin Creator conversation and ask it to create or update a private plugin with the included SKILL, helper and MCP connection. Do not ask it to print the connection URL or configuration. Uploading a file alone does not install or verify a plugin.\n\nAfter installing, verify that list_tokens, create_token_read_link, create_token_write_link, delete_token and recent_activity appear, then actually call list_tokens. A healthy /health response or a saved plugin release is not sufficient.\n\nIf ChatGPT cannot activate the bundled remote MCP, use Plugins > + > Add custom MCP server, enter the URL from mcp.json locally, select None for a private path-auth package, and verify all five tools. Give Plugin Creator the new plugin ID and this archive, and ask it to add only the SKILL and supporting files while preserving the existing connection, identity, title and authentication. A new App connection may require this account-side step.\n\nProvider tokens stay in the vault. VAULT_ENCRYPTION_KEY and .env are not included. The agent still needs a terminal, Node.js 24+ and its target CLI.\n`,{mode:0o600});

    const temporary=join(stage,'archive.tar.gz');
    const tar=spawnSync('tar',['-czf',temporary,'-C',stage,'token-vault'],{stdio:'pipe',shell:false});
    if(tar.status!==0)throw new PackageError('Could not create tar.gz. Install tar and retry.');
    await chmod(temporary,0o600);
    const archive=join(o.outputDir,o.public?'token-vault.tar.gz':'token-vault-private.tar.gz');
    await rename(temporary,archive);
    console.log(`Created ${archive}`);
    console.log(o.public?'Public package: no connection key included.':'PRIVATE package: includes MCP_ACCESS_KEY in the MCP URL. Keep this archive private; the key was not printed.');
    console.log('Upload the tar.gz to Plugin Creator for a private installation, then verify its tools and call list_tokens. See README.md for the custom MCP fallback.');
  }finally{
    key=undefined;env={};
    if(stage)await rm(stage,{recursive:true,force:true});
    process.umask(mask);
  }
}
try{await main();}
catch(e){console.error(e instanceof PackageError?e.message:'Plugin packaging failed. Check local files, permissions and tar availability; no credential values were printed.');process.exitCode=1;}
