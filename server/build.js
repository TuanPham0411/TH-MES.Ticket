import {build} from 'esbuild';
import {cp,mkdir} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['server/index.js'],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:'dist/server/app.cjs',external:['pg-native']});
await cp('server/migrations','dist/server/migrations',{recursive:true});
// Migration runner executes from its own directory alongside SQL files.
await build({entryPoints:['server/migrate.js'],bundle:true,platform:'node',target:'node22',format:'cjs',external:['pg-native'],outfile:'dist/server/migrate.cjs'});
await build({entryPoints:['server/bootstrap-owner.js'],bundle:true,platform:'node',target:'node22',format:'cjs',external:['pg-native'],outfile:'dist/server/bootstrap-owner.cjs'});

await build({entryPoints:['server/heic-worker.js'],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:'dist/server/heic-worker.cjs'});


await build({entryPoints:['server/storage-operator.js'],bundle:true,platform:'node',target:'node22',format:'cjs',external:['pg-native'],outfile:'dist/server/storage-operator.cjs'});
await cp('server/th-storage/capture.sql','dist/server/storage-capture.sql');
