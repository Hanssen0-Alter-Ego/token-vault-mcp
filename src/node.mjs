import http from 'node:http';
import {Readable} from 'node:stream';
import {fetchApp} from '../dist/app.mjs';
import {sqliteDB} from './sqlite.mjs';
process.umask(0o077);
const origin=new URL(process.env.PUBLIC_ORIGIN || 'https://vault.example.invalid');
const env={...process.env,DB:sqliteDB(process.env.DATABASE_PATH || '/data/vault.sqlite')};
const server=http.createServer(async(req,res)=>{
 try {
  const request=new Request(`${origin.origin}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=await fetchApp(request,env);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
 } catch {res.writeHead(500,{'Cache-Control':'no-store'});res.end('Vault unavailable.');}
});
server.headersTimeout=10000;server.requestTimeout=15000;
server.listen(Number(process.env.PORT || 8787),process.env.BIND_ADDRESS || '127.0.0.1',()=>process.stdout.write('Token Vault listening. Use an HTTPS reverse proxy for production.\n'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{env.DB.close();process.exit(0);}));
