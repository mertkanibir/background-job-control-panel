import { parentPort, workerData } from 'node:worker_threads';
import { processJob } from './processors.mjs';

try {
  if (workerData.attempt <= workerData.failFirst)
    throw new Error(
      `Injected failure ${workerData.attempt}/${workerData.failFirst}; retry behavior is intentional.`,
    );
  const output = processJob(workerData.type, workerData.input, (progress) =>
    parentPort.postMessage({ kind: 'progress', progress }),
  );
  parentPort.postMessage({ kind: 'result', output });
} catch (error) {
  parentPort.postMessage({ kind: 'failure', error: error.message });
}
