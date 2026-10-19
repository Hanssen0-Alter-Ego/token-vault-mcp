import {build} from 'esbuild';
await import('../scripts/build.mjs');
await build({entryPoints:['src/lib/security.ts','src/lib/vault-service.ts'],outdir:'.test-build',bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'}});
