import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const content=await readFile('.env','utf8'),values=Object.fromEntries(content.split('\n').filter(x=>x && !x.startsWith('#')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
const keys=['PUBLIC_ORIGIN','VAULT_ENCRYPTION_KEY','MCP_ACCESS_KEY'];
if(keys.some(x=>!values[x]))throw new Error('Generate and configure .env first.');
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk'],{stdio:['pipe','inherit','inherit'],shell:false});
child.stdin.end(JSON.stringify(Object.fromEntries(keys.map(x=>[x,values[x]]))));
child.on('exit',code=>{process.exitCode=code ?? 1;});
