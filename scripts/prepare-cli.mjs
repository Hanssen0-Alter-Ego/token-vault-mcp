import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source=await readFile('cli/vault-cli.mjs','utf8'),hash=createHash('sha256').update(source).digest('hex');
await writeFile('src/lib/cli-integrity.ts',`// Generated from cli/vault-cli.mjs by scripts/prepare-cli.mjs.\nexport const CLI_SHA256=${JSON.stringify(hash)};\n`);

await writeFile("src/cli-source.ts",`// Generated public CLI helper.\nexport const CLI_SOURCE=${JSON.stringify(source)};\n`);
