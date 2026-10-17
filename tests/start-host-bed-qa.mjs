// Disposable synthetic server. Never opens the user's data/ or game files.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/main.mjs';
const app=createApp({dataDir:mkdtempSync(join(tmpdir(),'vrm-host-bed-browser-')),port:37843,token:'host-bed-browser-fixture-no-game-authority'});
await app.listen();
console.log('Synthetic host-bed browser QA: http://127.0.0.1:37843');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
