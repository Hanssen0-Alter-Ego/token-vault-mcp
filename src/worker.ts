import {fetchApp,type Env} from './app';
// Never emit request URLs: /mcp/<key> contains a long-lived management secret.
function routeLabel(request:Request):string {
 const path=new URL(request.url).pathname;
 if(path==='/mcp' || path.startsWith('/mcp/'))return 'mcp';
 switch(path){
  case '/health':return 'health';
  case '/vault-cli.sh':return 'helper';
  case '/vault-upload.sh':return 'manual_upload_helper';
  case '/redeem/read':return 'redeem_read';
  case '/redeem/write':return 'redeem_write';
  case '/admin/tokens':return 'manual_upload';
  default:return 'other';
 }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const start=Date.now();
 const response=await fetchApp(request,env);
 // Fixed labels and numeric fields only; no headers, bodies, errors or user input.
 console.log({event:'vault_request',route:routeLabel(request),status:response.status,duration_ms:Math.max(0,Date.now()-start)});
 return response;
}};
