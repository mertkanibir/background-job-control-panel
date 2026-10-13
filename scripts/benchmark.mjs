import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Queue } from '../server/queue.mjs';

const argumentsMap = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (
    !['--jobs', '--concurrency', '--workload', '--iterations'].includes(key) ||
    process.argv[i + 1] === undefined
  ) {
    throw new Error(
      'Usage: node scripts/benchmark.mjs [--jobs 100] [--concurrency 3] [--workload text|hash] [--iterations 100000]',
    );
  }
  argumentsMap.set(key, process.argv[i + 1]);
}
function integerArgument(key, fallback, min, max) {
  const value = Number(argumentsMap.get(key) ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  return value;
}
const jobs = integerArgument('--jobs', 100, 1, 1000);
const concurrency = integerArgument('--concurrency', 3, 1, 8);
const iterations = integerArgument('--iterations', 100000, 1000, 2000000);
const workload = argumentsMap.get('--workload') ?? 'text';
if (!['text', 'hash'].includes(workload)) throw new Error('--workload must be text or hash.');
const directory = await mkdtemp(join(tmpdir(), 'relay-benchmark-'));
const queue = new Queue(join(directory, 'queue.sqlite'), { tickMs: 10 });
try {
  queue.configure({ concurrency, paused: true });
  const ids = [];
  const started = performance.now();
  const text =
    'Durable queues need observable state transitions. Workers process real data, retries preserve attempts, and failures remain inspectable. '.repeat(
      100,
    );
  for (let i = 0; i < jobs; i++) {
    const payload =
      workload === 'text'
        ? { type: 'text-analysis', input: { text } }
        : { type: 'hash-chain', input: { seed: `benchmark-${i}`, iterations } };
    ids.push(queue.enqueue({ ...payload, name: `Benchmark ${i + 1}`, maxAttempts: 1 }).job.id);
  }
  const enqueued = performance.now();
  let maxObservedConcurrency = 0;
  queue.on('change', () => {
    maxObservedConcurrency = Math.max(maxObservedConcurrency, queue.active.size);
  });
  queue.configure({ paused: false });
  const deadline = performance.now() + 120000;
  while (true) {
    const snapshot = queue.snapshot();
    if (snapshot.counts.dead || snapshot.counts.cancelled)
      throw new Error('A benchmark job did not complete successfully.');
    if (snapshot.counts.completed === jobs) break;
    if (performance.now() > deadline)
      throw new Error('Benchmark exceeded 120 seconds; lower the job count or hash iterations.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const finished = performance.now();
  const durations = ids
    .map((id) => {
      const job = queue.get(id);
      if (job.status !== 'completed' || job.output == null)
        throw new Error(`Missing persisted result for ${id}.`);
      return job.finishedAt - job.startedAt;
    })
    .sort((a, b) => a - b);
  if (maxObservedConcurrency > concurrency)
    throw new Error('Configured concurrency bound was exceeded.');
  const percentile = (value) => durations[Math.max(0, Math.ceil(value * durations.length) - 1)];
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        workload:
          workload === 'text'
            ? { type: 'text-analysis', charactersPerJob: text.length }
            : { type: 'hash-chain', iterationsPerJob: iterations },
        jobs,
        concurrency,
        maxObservedConcurrency,
        elapsedMs: Number((finished - started).toFixed(2)),
        enqueueMs: Number((enqueued - started).toFixed(2)),
        jobsPerSecond: Number((jobs / ((finished - started) / 1000)).toFixed(2)),
        attemptDurationMs: { p50: percentile(0.5), p95: percentile(0.95), max: durations.at(-1) },
        completedJobsWithPersistedOutput: jobs,
        note: 'Single local run on a temporary SQLite database, including worker startup and durable writes. This is a reproducible demonstration, not a production capacity guarantee.',
      },
      null,
      2,
    ),
  );
} finally {
  await queue.close();
  await rm(directory, { recursive: true, force: true });
}
