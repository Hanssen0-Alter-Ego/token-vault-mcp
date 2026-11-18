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
 const good=await fetchApp(request(env,`/mcp/${env.MCP_ACCESS_KEY}`,options),env);assert.equal(good.status,200);assert.equal((await good.json()).result.tools.length,6);
 assert.equal((await fetchApp(request(env,'/mcp',{...options,headers:{...options.headers,Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,Origin:'https://evil.example'}}),env)).status,403);
});
test('official MCP SDK initializes, discovers tools, calls a read tool and rejects invalid authentication',async()=>{
 const env=fixture(),client=new Client({name:'vault-verification',version:'1.0.0'});
 const transport=new StreamableHTTPClientTransport(new URL(`${env.PUBLIC_ORIGIN}/mcp/${env.MCP_ACCESS_KEY}`),{fetch:(url,init)=>fetchApp(new Request(url,init),env)});
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,6);
 const verifier=randomBytes(32).toString('base64url');
 const claimChallenge=createHash('sha256').update(verifier).digest('base64url');
 const upload=await client.callTool({name:'create_token_write_link',arguments:{name:'sdk/token',envVar:'GH_TOKEN',claimChallenge}});
 assert.ok(!upload.isError);const writeURL=new URL(upload.structuredContent.url);
 const stored=await fetchApp(new Request(writeURL.origin+writeURL.pathname,{method:'POST',headers:{Authorization:`Bearer ${writeURL.hash.slice(1)}`,'X-Vault-Verifier':verifier,'Content-Type':'application/json'},body:JSON.stringify({token:'synthetic-sdk-token'})}),env);
 assert.equal(stored.status,200);
 const read=await client.callTool({name:'create_token_read_link',arguments:{name:'sdk/token',claimChallenge}});
 assert.equal(read.isError,true);
 await client.callTool({name:'delete_token',arguments:{name:'sdk/token'}});
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

test('manual upload uses only Bearer MCP auth, stores or explicitly replaces tokens and remains outside MCP tools',async()=>{
 const env=fixture(),value='synthetic-manual-token',name='manual/token';
 const upload=(body,headers={Authorization:`Bearer ${env.MCP_ACCESS_KEY}`},path='/admin/tokens')=>fetchApp(request(env,path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),env);
 const input={name,envVar:'GH_TOKEN',token:value};
 assert.equal((await upload(input,{})).status,401);
 assert.equal((await upload(input,{Authorization:`Bearer ${'0'.repeat(64)}`})).status,401);
 assert.equal((await upload(input,{},'/admin/tokens?token='+env.MCP_ACCESS_KEY)).status,400);
 assert.equal((await upload(input,{},'/admin/tokens/'+env.MCP_ACCESS_KEY)).status,404);
 assert.equal((await upload(input,{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,Origin:env.PUBLIC_ORIGIN})).status,403);
 assert.equal((await fetchApp(request(env,'/admin/tokens'),env)).status,405);
 const stored=await upload(input);assert.equal(stored.status,200);assert.deepEqual(await stored.json(),{stored:true});
 const listing=(await (await rpc(env,'list_tokens')).json()).result.structuredContent;
 assert.deepEqual(listing.credentials.map(item=>({name:item.name,envVar:item.envVar})),[{name,envVar:'GH_TOKEN'}]);
 assert.ok(!JSON.stringify(listing).includes(value));
 assert.equal((await upload(input)).status,409);
 const proof=()=>{const verifier=randomBytes(32).toString('base64url');return {verifier,claimChallenge:createHash('sha256').update(verifier).digest('base64url')};};
 const first=proof(),oldLink=(await (await rpc(env,'create_token_write_link',{name,envVar:'GH_TOKEN',overwrite:true,claimChallenge:first.claimChallenge})).json()).result.structuredContent;
 const newer='synthetic-replacement-token';assert.equal((await upload({...input,token:newer,envVar:'OPENAI_API_KEY',overwrite:true})).status,200);
 const link=new URL(oldLink.url);
 const stale=await fetchApp(new Request(link.origin+link.pathname,{method:'POST',headers:{Authorization:`Bearer ${link.hash.slice(1)}`,'X-Vault-Verifier':first.verifier,'Content-Type':'application/json'},body:JSON.stringify({token:'synthetic-stale'})}),env);
 assert.equal(stale.status,410);
 for(const method of ['GET','POST'])assert.equal((await fetchApp(request(env,'/redeem/read',{method}),env)).status,410);
 const toolResponse=await fetchApp(request(env,'/mcp',{method:'POST',headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);
 const names=(await toolResponse.json()).result.tools.map(tool=>tool.name);
 assert.deepEqual(names.sort(),['get_cli_helper','create_token_envelope','create_token_write_link','delete_token','list_tokens','recent_activity'].sort());
 const audit=JSON.stringify((await (await rpc(env,'recent_activity')).json()).result.structuredContent);
 for(const secret of [value,newer,env.MCP_ACCESS_KEY,first.verifier])assert.ok(!audit.includes(secret));
});

test('manual upload rejects malformed, excessive or accidental fields without changing stored data',async()=>{
 const env=fixture();
 const upload=body=>fetchApp(request(env,'/admin/tokens',{method:'POST',headers:{Authorization:`Bearer ${env.MCP_ACCESS_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
 for(const body of [null,[],{}, {name:'invalid/token',envVar:'PATH',token:'synthetic'}, {name:'invalid/token',envVar:'GH_TOKEN',token:'bad\nvalue'}, {name:'invalid/token',envVar:'GH_TOKEN',token:'synthetic',overwrite:'true'}, {name:'invalid/token',envVar:'GH_TOKEN',token:'synthetic',unexpected:true}])
   assert.equal((await upload(body)).status,400);
 assert.equal((await upload({name:'invalid/token',envVar:'GH_TOKEN',token:'x'.repeat(20000)})).status,413);
 assert.deepEqual((await (await rpc(env,'list_tokens')).json()).result.structuredContent.credentials,[]);
});

test('MCP helper is fixed public data, matches packaged trusted hash, and rejects arguments',async()=>{
 const {readFile}=await import('node:fs/promises');
 const env=fixture(),res=(await (await rpc(env,'get_cli_helper')).json()).result;
 const helper=res.structuredContent;
 assert.equal(helper.source,await readFile('cli/vault-envelope.mjs','utf8'));
 assert.equal(helper.sha256,JSON.parse(await readFile('plugin/token-vault/skills/token-vault/references/envelope-helper-integrity.json','utf8')).sha256);
 assert.equal(createHash('sha256').update(helper.source).digest('hex'),helper.sha256);
 assert.equal(helper.filename,'vault-envelope.mjs');
 assert.equal(helper.version,'0.7.0');
 assert.ok(!JSON.stringify(res).includes(env.MCP_ACCESS_KEY));
 assert.ok(!JSON.stringify(res).includes(env.VAULT_ENCRYPTION_KEY));
 for(const args of [{name:'secret'},[],{path:'/etc/passwd'},{source:'untrusted'}])
  assert.equal((await (await rpc(env,'get_cli_helper',args)).json()).result.isError,true);
});
