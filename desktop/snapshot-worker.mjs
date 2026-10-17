import { parentPort, workerData } from 'node:worker_threads';
import { discoverCompletedWorlds, readCompletedSnapshot } from './snapshot.mjs';
try {
  const value = workerData.action === 'discover' ? await discoverCompletedWorlds([workerData.folder]) : await readCompletedSnapshot(workerData.folder);
  parentPort.postMessage({ ok: true, value });
} catch { parentPort.postMessage({ ok: false }); }
