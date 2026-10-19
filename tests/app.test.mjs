import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fetchApp} from '../dist/app.mjs';
import {testDB} from './d1.mjs';
import {run} from '../cli/vault-cli.mjs';
function fixture(){return {DB:testDB(),PUBLIC_ORIGIN:'https://vault.example',VAULT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),MCP_ACCESS_KEY:randomBytes(32).toString('hex')};}
const request=(env,path,options={})=>new Request(env.PUBLIC_ORIGIN+path,options);
async function rpc(env,name,args={}){return fetchApp(request(env,'/mcp',{method:'POST',headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);}
test('MCP requires Bearer or secret URL path; fragments and forged identity do not authenticate',async()=>{
 const env=fixture(),body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),options={method:'POST',headers:{'Content-Type':'application/json'},body};
 assert.equal((await fetchApp(request(env,'/mcp',options),env)).status,401);
 assert.equal((await fetchApp(request(env,`/mcp#${env.MCP_ACCESS_KEY}`,options),env)).status,401);
 assert.equal((await fetchApp(request(env,'/mcp',{...options,headers:{...options.headers,'oai-authenticated-user-id':'forged'}}),env)).status,401);
 const good=await fetchApp(request(env,`/mcp/${env.MCP_ACCESS_KEY}`,options),env);assert.equal(good.status,200);assert.equal((await good.json()).result.tools.length,5);
 assert.equal((await fetchApp(request(env,'/mcp',{...options,headers:{...options.headers,Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,Origin:'https://evil.example'}}),env)).status,403);
});
test('synthetic flow: MCP upload -> direct environment upload -> MCP read -> child environment, without durable token in RPC',async()=>{
 const env=fixture(),value='synthetic-end-to-end-value',params={name:'github/main',provider:'github',envVar:'GH_TOKEN',allowAgentUse:true,purpose:'synthetic CLI test'};
 const writeRPC=await (await rpc(env,'create_token_write_link',params)).json();assert.ok(!JSON.stringify(writeRPC).includes(value));const upload=writeRPC.result.structuredContent;
 const fetcher=(url,init)=>fetchApp(new Request(url,init),env);
 await run(['store','--origin',env.PUBLIC_ORIGIN,'--env','GH_TOKEN'],{input:upload.url,environment:{GH_TOKEN:value},fetcher});
 const readRPC=await (await rpc(env,'create_token_read_link',{name:params.name,purpose:'synthetic child command'})).json();const read=readRPC.result.structuredContent;
 assert.ok(!JSON.stringify(readRPC).includes(value));
 const helper=await fetcher(read.helper.url);assert.equal(createHash('sha256').update(await helper.text()).digest('hex'),read.helper.sha256);
 let childToken;const exit=await run(['run','--origin',env.PUBLIC_ORIGIN,'--env','GH_TOKEN','--','gh','repo','view'],{input:read.url,environment:{},fetcher,spawnChild:(bin,argv,opts)=>{assert.equal(bin,'gh');childToken=opts.env.GH_TOKEN;const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}});
 assert.equal(exit,0);assert.equal(childToken,value);
 const replay=await fetcher(new URL(read.url).origin+'/redeem/read',{method:'POST',headers:{Authorization:`Bearer ${new URL(read.url).hash.slice(1)}`}});assert.equal(replay.status,410);
 const logs=await (await rpc(env,'recent_activity')).text();assert.ok(!logs.includes(value));assert.ok(!logs.includes(new URL(read.url).hash.slice(1)));
});
test('official MCP SDK initializes, discovers tools, calls a read tool and rejects invalid authentication',async()=>{
 const env=fixture(),client=new Client({name:'vault-verification',version:'1.0.0'});
 const transport=new StreamableHTTPClientTransport(new URL(`${env.PUBLIC_ORIGIN}/mcp/${env.MCP_ACCESS_KEY}`),{fetch:(url,init)=>fetchApp(new Request(url,init),env)});
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,5);
 const result=await client.callTool({name:'list_tokens',arguments:{}});assert.deepEqual(result.structuredContent,{credentials:[]});
 await client.close();
 const failed=new Client({name:'invalid-auth',version:'1.0.0'});
 await assert.rejects(failed.connect(new StreamableHTTPClientTransport(new URL(`${env.PUBLIC_ORIGIN}/mcp`),{fetch:(url,init)=>fetchApp(new Request(url,init),env)})));
 await failed.close();
});
test('real child process receives the credential and prints no credential',async()=>{
 const claim='a'.repeat(64),value='synthetic-subprocess-token';let output='';
 const code=await run(['run','--origin','https://vault.example','--env','GH_TOKEN','--',process.execPath,'-e','if(!process.env.GH_TOKEN)process.exit(3);process.stdout.write("child-ok");'],{input:`https://vault.example/redeem/read#${claim}`,environment:{},fetcher:async()=>new Response(value,{headers:{'Content-Type':'text/plain','X-Vault-Env':'GH_TOKEN'}}),spawnChild:(bin,args,opts)=>{const child=spawn(bin,args,{...opts,stdio:['ignore','pipe','pipe']});child.stdout.on('data',data=>output+=data);return child;}});
 assert.equal(code,0);assert.equal(output,'child-ok');assert.ok(!output.includes(value));
});
