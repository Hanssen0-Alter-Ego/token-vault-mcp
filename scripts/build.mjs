import {build} from 'esbuild';
await import('./prepare-cli.mjs');
await build({entryPoints:['src/worker.ts'],outfile:'dist/worker.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
await build({entryPoints:['src/app.ts'],outfile:'dist/app.mjs',bundle:true,format:'esm',platform:'node',target:'node24'});
console.log('Built one Worker: MCP + token storage + one-time claim endpoints.');
