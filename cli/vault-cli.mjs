#!/usr/bin/env node
// Node >=22. Read one-time URL from stdin. Never print the fetched token.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export async function run(argv,{input,fetcher=fetch,spawnChild=spawn,environment=process.env}={}) {
  const mode=argv.shift(),sep=argv.indexOf('--'),options=sep<0?argv:argv.slice(0,sep),command=sep<0?[]:argv.slice(sep+1);
  if(!['run','store'].includes(mode) || options.length!==4 || options[0]!=='--origin' || options[2]!== '--env') throw new Error('Usage: node vault-cli.mjs run|store --origin https://gateway.example --env GH_TOKEN [-- gh ...] < one-time-link');
  const expected=new URL(options[1]),envName=options[3];
  if(expected.protocol!=='https:' || expected.origin!==options[1] || !/^[A-Z][A-Z0-9_]{0,63}$/.test(envName) || /^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|LD_.*|DYLD_.*)$/.test(envName)) throw new Error('Invalid gateway origin or credential environment name.');
  const raw=(input ?? await readFile(0,'utf8')).trim(),url=new URL(raw),kind=mode==='run'?'read':'write';
  if(url.origin!==expected.origin || url.pathname!==`/redeem/${kind}` || url.username || url.password || url.search || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error('Link does not match the configured gateway and operation.');
  if(mode==='run' && !command.length) throw new Error('A child command is required.');
  if(mode==='store' && command.length) throw new Error('store accepts no child command.');
  const claim=url.hash.slice(1);url.hash='';
  const headers={Authorization:`Bearer ${claim}`};let body;
  if(mode==='store') {
    const token=environment[envName];
    if(!token || token.length>8192 || /[\r\n\0]/.test(token)) throw new Error('Source credential environment variable is missing or invalid.');
    headers['Content-Type']='application/json';body=JSON.stringify({token});
  }
  const response=await fetcher(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(15000)});
  // Errors never include response bodies, URLs, headers, or environment values.
  if(!response.ok) throw new Error(`Vault request failed (${response.status}); request a fresh link.`);
  if(mode==='store') return 0;
  if(!response.headers.get('content-type')?.startsWith('text/plain') || response.headers.get('x-vault-env')!==envName) throw new Error('Unexpected token response or environment name mismatch.');
  const reader=response.body?.getReader();if(!reader) throw new Error('Empty vault response.');
  const decoder=new TextDecoder();let token='',size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192)throw new Error('Token response too large.');token+=decoder.decode(value,{stream:true});}token+=decoder.decode();}
  finally {await reader.cancel().catch(()=>{});}
  if(!token || /[\r\n\0]/.test(token)) throw new Error('Invalid token response.');
  const childEnv={...environment,[envName]:token};
  const child=spawnChild(command[0],command.slice(1),{env:childEnv,stdio:'inherit',shell:false});
  delete childEnv[envName];token=''; // best-effort reference cleanup; JS cannot promise secure memory erasure.
  return await new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('Unable to start requested CLI.')));child.once('exit',(code,signal)=>resolve(code ?? (signal?1:0)));});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {process.exitCode=await run(process.argv.slice(2));}
  catch(e){process.stderr.write(`${e instanceof Error?e.message:'Vault command failed.'}\n`);process.exitCode=1;}
}
