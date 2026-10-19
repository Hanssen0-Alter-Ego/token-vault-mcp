import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {fetchApp} from '../dist/app.mjs';
import {testDB} from './d1.mjs';
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
test('official MCP SDK initializes, discovers tools, calls a read tool and rejects invalid authentication',async()=>{
 const env=fixture(),client=new Client({name:'vault-verification',version:'1.0.0'});
 const transport=new StreamableHTTPClientTransport(new URL(`${env.PUBLIC_ORIGIN}/mcp/${env.MCP_ACCESS_KEY}`),{fetch:(url,init)=>fetchApp(new Request(url,init),env)});
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,5);
 const result=await client.callTool({name:'list_tokens',arguments:{}});assert.deepEqual(result.structuredContent.credentials,[]);assert.equal(result.structuredContent.proofMethod,'S256');assert.equal(result.structuredContent.helper.url,env.PUBLIC_ORIGIN+'/vault-cli.sh');
 await client.close();
 const failed=new Client({name:'invalid-auth',version:'1.0.0'});
 await assert.rejects(failed.connect(new StreamableHTTPClientTransport(new URL(`${env.PUBLIC_ORIGIN}/mcp`),{fetch:(url,init)=>fetchApp(new Request(url,init),env)})));
 await failed.close();
});
test('one public shell helper matches MCP integrity and removed Node endpoint returns 404',async()=>{
 const env=fixture();
 const {result}=await (await rpc(env,'list_tokens')).json();
 const {helper}=result.structuredContent;
 assert.deepEqual(Object.keys(result.structuredContent).sort(),['credentials','helper','proofMethod']);
 const response=await fetchApp(new Request(helper.url),env);
 assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/^text\/plain/);
 assert.equal(createHash('sha256').update(await response.text()).digest('hex'),helper.sha256);
 assert.equal((await fetchApp(request(env,'/vault-cli.mjs'),env)).status,404);
});
