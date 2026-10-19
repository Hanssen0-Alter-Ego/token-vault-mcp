import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../cli/vault-cli.mjs';
export async function prepare(t,origin='https://claim.example',envName='GH_TOKEN') {
 const folder=await mkdtemp(join(tmpdir(),'vault-proof-test-')),statePath=join(folder,'claim.json');
 t.after(()=>rm(folder,{recursive:true,force:true}));
 let output='';await run(['prepare','--origin',origin,'--env',envName,'--state',statePath],{writeOutput:data=>output+=data});
 return {statePath,claimChallenge:JSON.parse(output).claimChallenge,output,folder};
}
