import {AppError,redemptionOrigin,validateName} from './security';
export type EnvelopeRequest={name:string;requestId:string;audience:string;publicKey:{kty:'RSA';n:string;e:'AQAB'}};
const encode=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function modulus(value:unknown){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{512}$/.test(value))throw new AppError('Use a fresh RSA-3072 public key from vault-envelope.mjs prepare.');
 const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));
 if(bytes.length!==384 || !(bytes[0]&128) || !(bytes[383]&1) || encode(bytes)!==value)throw new AppError('Invalid public key.');
 return value;
}
export async function validateEnvelopeRequest(value:unknown,origin:string|undefined){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Invalid envelope request.');
 const input=value as Record<string,unknown>;
 if(Object.keys(input).sort().join(',')!=='audience,name,publicKey,requestId')throw new AppError('Use name, requestId, audience and publicKey only.');
 const name=validateName(input.name),audience=redemptionOrigin(origin);
 if(input.audience!==audience)throw new AppError('Envelope audience does not match this vault.');
 if(typeof input.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.requestId))throw new AppError('Use a fresh requestId from the local helper.');
 const jwk=input.publicKey;
 if(!jwk||typeof jwk!=='object'||Array.isArray(jwk)||Object.keys(jwk).sort().join(',')!=='e,kty,n')throw new AppError('Only public RSA key fields kty, n and e are allowed.');
 const publicKey=jwk as Record<string,unknown>;
 if(publicKey.kty!=='RSA'||publicKey.e!=='AQAB')throw new AppError('Unsupported public key.');
 const n=modulus(publicKey.n);
 const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n,e:'AQAB'},{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const fingerprint=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(n))));
 return {name,audience,requestId:input.requestId,key,fingerprint};
}
export async function sealEnvelope(key:CryptoKey,header:{requestId:string;name:string;envVar:string;audience:string;issuedAt:number;expiresAt:number},token:string){
 const protectedHeader=encode(new TextEncoder().encode(JSON.stringify({alg:'RSA-OAEP-256',enc:'A256GCM',typ:'vault-envelope+jwe',v:1,...header})));
 const contentKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(protectedHeader),tagLength:128},contentKey,new TextEncoder().encode(JSON.stringify({token}))));
 const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,await crypto.subtle.exportKey('raw',contentKey)));
 return [protectedHeader,encode(wrapped),encode(iv),encode(encrypted.slice(0,-16)),encode(encrypted.slice(-16))].join('.');
}
