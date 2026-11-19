import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {fetchApp} from '../dist/app.mjs';
import worker from '../dist/worker.mjs';

const fixture=()=>({PUBLIC_ORIGIN:'https://vault.example',MCP_ACCESS_KEY:randomBytes(32).toString('hex'),VAULT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),DB:new Proxy({}, {get(){throw new Error('Public helper must not access D1');}})});
const source=await readFile('cli/vault-upload.sh','utf8');
const trustedSHA='e52a6d390f78a9f1dbf0603985b89a8dfb03d5654ea2b10d99125a57bc7ba3ac';

test('public GET uploader exactly equals committed source without authorization or D1 access',async()=>{
 const env=fixture();
 const response=await fetchApp(new Request(env.PUBLIC_ORIGIN+'/vault-upload.sh'),env);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('Content-Type'),'text/plain; charset=utf-8');
 assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.equal(response.headers.get('Set-Cookie'),null);
 const body=await response.text();
 assert.equal(body,source);
 assert.equal(createHash('sha256').update(body).digest('hex'),trustedSHA);
 assert.ok(!body.includes(env.MCP_ACCESS_KEY));
 assert.ok(!body.includes(env.VAULT_ENCRYPTION_KEY));
});

test('compiled Worker serves identical uploader with fixed non-secret log label',async(t)=>{
 const env=fixture(),log=t.mock.method(console,'log',()=>{});
 const response=await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/vault-upload.sh'),env);
 assert.equal(response.status,200);assert.equal(await response.text(),source);
 assert.equal(log.mock.calls.length,1);
 assert.deepEqual(Object.keys(log.mock.calls[0].arguments[0]).sort(),['duration_ms','event','route','status']);
 assert.equal(log.mock.calls[0].arguments[0].route,'manual_upload_helper');
 for(const file of ['dist/worker.mjs','dist/app.mjs']){
  const bundle=await readFile(file,'utf8');
  assert.ok(!bundle.includes(env.MCP_ACCESS_KEY));
  assert.ok(!bundle.includes(env.VAULT_ENCRYPTION_KEY));
 }
});

test('uploader download has no write semantics and preserves host/query boundaries',async()=>{
 const env=fixture();
 assert.equal((await fetchApp(new Request(env.PUBLIC_ORIGIN+'/vault-upload.sh',{method:'POST'}),env)).status,404);
 assert.equal((await fetchApp(new Request(env.PUBLIC_ORIGIN+'/vault-upload.sh?token=synthetic'),env)).status,400);
 assert.equal((await fetchApp(new Request('https://other.example/vault-upload.sh'),env)).status,400);
 assert.equal((await fetchApp(new Request(env.PUBLIC_ORIGIN+'/vault-upload.sh/extra'),env)).status,404);
 // This local synthetic request only verifies rejection; no real/admin credentials used.
 assert.equal((await fetchApp(new Request(env.PUBLIC_ORIGIN+'/admin/tokens',{method:'POST'}),env)).status,401);
});

test('README and owning Skill pin the unchanged manual helper and exclude it from packaged Agent scripts',async()=>{
 for(const file of ['README.md','plugin/token-vault/skills/token-vault/SKILL.md']){
  const text=await readFile(file,'utf8');assert.ok(text.includes(trustedSHA));assert.ok(text.includes('/vault-upload.sh'));
 }
 const packaging=await readFile('scripts/package-plugin.mjs','utf8');
 assert.ok(!packaging.includes("readFile(join(root,'cli/vault-upload.sh')"));
});
