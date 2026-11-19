import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source=await readFile('cli/vault-cli.sh','utf8');
const hash=createHash('sha256').update(source).digest('hex');
await writeFile('src/lib/cli-integrity.ts',`// Generated from cli/vault-cli.sh by scripts/prepare-cli.mjs.\nexport const CLI_SHA256=${JSON.stringify(hash)};\n`);
await writeFile('src/cli-source.ts',`// Generated public shell helper.\nexport const CLI_SOURCE=${JSON.stringify(source)};\n`);
const skill='plugin/token-vault/skills/token-vault';
await mkdir(`${skill}/references`,{recursive:true});
await mkdir(`${skill}/scripts`,{recursive:true});
await writeFile(`${skill}/references/helper-integrity.json`,JSON.stringify({algorithm:'sha256',sha256:hash},null,2)+'\n');
await copyFile('cli/vault-cli.sh',`${skill}/scripts/vault-cli.sh`);

// Offline helper is packaged separately; existing shell helper hashes remain unchanged.
const envelopeSource=await readFile('cli/vault-envelope.mjs','utf8');
await copyFile('cli/vault-envelope.mjs',`${skill}/scripts/vault-envelope.mjs`);
await writeFile(`${skill}/references/envelope-helper-integrity.json`,JSON.stringify({algorithm:'sha256',sha256:createHash('sha256').update(envelopeSource).digest('hex')},null,2)+'\n');

await writeFile('src/envelope-source.ts',`// Generated public offline helper.\nexport const ENVELOPE_SOURCE=${JSON.stringify(envelopeSource)};\nexport const ENVELOPE_SHA256=${JSON.stringify(createHash('sha256').update(envelopeSource).digest('hex'))};\n`);

// Public download for owner-operated uploads only. Never copy this into Agent skills.
const uploadSource=await readFile('cli/vault-upload.sh','utf8');
await writeFile('src/upload-source.ts',`// Generated public owner-operated upload helper.\nexport const UPLOAD_SOURCE=${JSON.stringify(uploadSource)};\n`);
