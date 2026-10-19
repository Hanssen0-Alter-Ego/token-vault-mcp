#!/usr/bin/env node
// Node >=24. MCP sees only the S256 challenge; the verifier never leaves the terminal except over HTTPS to the vault.
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,readFile,unlink} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
class CliError extends Error {}
const stateMaxAge=5*60*1000;
const challengeOf=secret=>createHash('sha256').update(secret,'ascii').digest('base64url');
const envPattern=/^[A-Z][A-Z0-9_]{0,63}$/;
const forbiddenEnv=/^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|LD_.*|DYLD_.*)$/;
function optionsOf(argv) {
  const mode=argv.shift(),sep=argv.indexOf('--'),pairs=sep<0?argv:argv.slice(0,sep),command=sep<0?[]:argv.slice(sep+1),options={};
  if(!['prepare','run','store'].includes(mode) || pairs.length!==6) throw new CliError('Usage: vault-cli.mjs prepare|run|store --origin https://vault.example --env GH_TOKEN --state /private/claim.json [-- command args]');
  for(let i=0;i<pairs.length;i+=2){const key=pairs[i];if(!['--origin','--env','--state'].includes(key) || options[key] || !pairs[i+1])throw new CliError('Invalid or repeated option.');options[key]=pairs[i+1];}
  const expected=new URL(options['--origin']),envName=options['--env'];
  if(expected.protocol!=='https:' || expected.origin!==options['--origin'] || !envPattern.test(envName) || forbiddenEnv.test(envName))throw new CliError('Invalid vault origin or credential environment name.');
  if(mode==='run' && !command.length)throw new CliError('A child command is required.');
  if(mode!=='run' && command.length)throw new CliError('prepare and store accept no child command.');
  return {mode,expected,envName,statePath:resolve(options['--state']),command};
}
async function readState(path,origin,envName) {
  let file;
  try {
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW || 0));
    const stat=await file.stat();
    if(!stat.isFile() || stat.size>2048 || (process.platform!=='win32' && ((stat.mode&0o077)!==0 || stat.uid!==process.getuid())))throw new CliError('invalid');
    const data=JSON.parse(await file.readFile('utf8'));
    if(data.v!==1 || data.origin!==origin || data.envName!==envName || typeof data.verifier!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(data.verifier) || !Number.isSafeInteger(data.createdAt) || Date.now()-data.createdAt>stateMaxAge || data.createdAt>Date.now()+5000)throw new CliError('invalid');
    return data;
  }catch{throw new CliError('Missing, expired, unsafe or mismatched claim state. Run prepare again; never print the state file.');}
  finally {await file?.close();}
}
export async function run(argv,{input,fetcher=fetch,spawnChild=spawn,environment=process.env,writeOutput=value=>process.stdout.write(value)}={}) {
  const {mode,expected,envName,statePath,command}=optionsOf([...argv]);
  if(mode==='prepare') {
    const verifier=randomBytes(32).toString('base64url');
    let file;
    try {
      file=await open(statePath,'wx',0o600);
      await file.writeFile(JSON.stringify({v:1,origin:expected.origin,envName,verifier,createdAt:Date.now()}));
    }catch{throw new CliError('Cannot create new claim state. Use an existing private directory and a fresh file path.');}
    finally {await file?.close();}
    // Only this public challenge reaches the model. Neither the secret nor file contents is printed.
    writeOutput(JSON.stringify({claimChallenge:challengeOf(verifier),method:'S256'})+'\n');
    return 0;
  }
  const raw=(input ?? await readFile(0,'utf8')).trim(),url=new URL(raw),kind=mode==='run'?'read':'write';
  if(url.origin!==expected.origin || url.pathname!==`/redeem/${kind}` || url.username || url.password || url.search || !/^#[a-f0-9]{64}$/.test(url.hash))throw new CliError('Link does not match the configured vault and operation.');
  const state=await readState(statePath,expected.origin,envName),claim=url.hash.slice(1);url.hash='';
  let token='',childEnv;
  try {
    const headers={Authorization:`Bearer ${claim}`,'X-Vault-Verifier':state.verifier};let body;
    if(mode==='store') {
      const source=environment[envName];
      if(!source || source.length>8192 || /[\r\n\0]/.test(source))throw new CliError('Source credential environment variable is missing or invalid.');
      headers['Content-Type']='application/json';body=JSON.stringify({token:source});
    }
    const response=await fetcher(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new CliError(`Vault request failed (${response.status}); prepare a fresh secret and request a fresh link.`);
    if(mode==='store')return 0;
    if(!response.headers.get('content-type')?.startsWith('text/plain') || response.headers.get('x-vault-env')!==envName)throw new CliError('Unexpected token response or environment name mismatch.');
    const reader=response.body?.getReader();if(!reader)throw new CliError('Empty vault response.');
    const decoder=new TextDecoder();let size=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192)throw new CliError('Token response too large.');token+=decoder.decode(value,{stream:true});}token+=decoder.decode();}
    finally {await reader.cancel().catch(()=>{});}
    if(!token || /[\r\n\0]/.test(token))throw new CliError('Invalid token response.');
    await unlink(statePath);state.verifier='';
    childEnv={...environment,[envName]:token};
    // Claim verifier is never supplied to the child. Only the requested provider credential is.
    const child=spawnChild(command[0],command.slice(1),{env:childEnv,stdio:'inherit',shell:false});
    delete childEnv[envName];token='';
    return await new Promise((resolve,reject)=>{child.once('error',()=>reject(new CliError('Unable to start requested CLI.')));child.once('exit',(code,signal)=>resolve(code ?? (signal?1:0)));});
  }finally {
    state.verifier='';token='';if(childEnv)delete childEnv[envName];
    // Also clean up after HTTP errors and uncertain delivery. A fresh attempt needs a fresh prepare.
    try {await unlink(statePath);}catch(error){if(error.code!=='ENOENT')throw new CliError('Unable to remove claim state; delete the private state file locally.');}
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {process.exitCode=await run(process.argv.slice(2));}
  catch(error){process.stderr.write(`${error instanceof CliError?error.message:'Vault operation failed; check configuration and request a new link.'}\n`);process.exitCode=1;}
}
