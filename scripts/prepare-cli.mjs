import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source=await readFile('cli/vault-cli.mjs','utf8'),hash=createHash('sha256').update(source).digest('hex');
await writeFile('src/lib/cli-integrity.ts',`// Generated from cli/vault-cli.mjs by scripts/prepare-cli.mjs.\nexport const CLI_SHA256=${JSON.stringify(hash)};\n`);

await writeFile("src/cli-source.ts",`// Generated public CLI helper.\nexport const CLI_SOURCE=${JSON.stringify(source)};\n`);

await mkdir('plugin/token-vault/skills/token-vault/references',{recursive:true});
await writeFile('plugin/token-vault/skills/token-vault/references/helper-integrity.json',JSON.stringify({algorithm:'sha256',sha256:hash},null,2)+'\n');

await mkdir('plugin/token-vault/skills/token-vault/scripts',{recursive:true});
await copyFile('cli/vault-cli.mjs','plugin/token-vault/skills/token-vault/scripts/vault-cli.mjs');
