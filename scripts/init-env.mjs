import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const origin=process.argv[2] || 'https://vault.example.com';
const url=new URL(origin);if(url.origin!==origin || !['https:','http:'].includes(url.protocol))throw new Error('Pass an origin such as https://vault.example.com');
const values={PUBLIC_ORIGIN:origin,VAULT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),MCP_ACCESS_KEY:randomBytes(32).toString('hex')};
await writeFile('.env',Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Created .env with restrictive permissions. Back up the encryption key securely. Secret values were not printed.');
