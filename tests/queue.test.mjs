import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Queue } from '../server/queue.mjs';
import { parseCsv } from '../server/processors.mjs';

const textJob = (extra) => ({
  name: 'Words',
  type: 'text-analysis',
  input: { text: 'Hello durable world. Hello workers!' },
  ...extra,
});
const hashJob = (extra) => ({
  name: 'CPU workload',
  type: 'hash-chain',
  input: { seed: 'relay', iterations: 2_000_000 },
  ...extra,
});
async function waitFor(check, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for queue state.');
}
async function useQueue(t, opts = {}) {
  const queue = new Queue(':memory:', { tickMs: 10, ...opts });
  t.after(() => queue.close());
  return queue;
}

test('a real worker analyzes text and persists output plus attempt history', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue(textJob());
  await waitFor(() => queue.get(job.id).status === 'completed');
  const detail = queue.detail(job.id);
  assert.equal(detail.output.words, 5);
  assert.equal(detail.output.uniqueWords, 4);
  assert.deepEqual(detail.output.topWords[0], { word: 'hello', count: 2 });
  assert.equal(detail.history[0].status, 'completed');
  assert.equal(detail.history.length, 1);
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    ['completed', 'started', 'enqueued'],
  );
});

test('CSV handles quoted fields, escaped quotes, missing values and duplicate rows', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue({
    name: 'CSV',
    type: 'csv-summary',
    input: { csv: 'name,total\r\n"North, region",12\r\n"He said ""hi""",\r\n"North, region",12' },
  });
  await waitFor(() => queue.get(job.id).status === 'completed');
  const { output } = queue.detail(job.id);
  assert.equal(output.rows, 3);
  assert.equal(output.duplicateRows, 1);
  assert.equal(output.columns[1].missing, 1);
  assert.equal(output.columns[1].sum, 24);
  assert.equal(output.preview[1][0], 'He said "hi"');
  assert.throws(() => parseCsv('a,b\n1'), /match/);
  assert.throws(() => parseCsv('a,a\n1,2'), /unique/);
});

test('large valid CSV fits input limits and calculates extrema without argument overflow', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue({
    name: 'Large CSV',
    type: 'csv-summary',
    input: { csv: 'value\n' + '1\n'.repeat(130_000) },
  });
  await waitFor(() => queue.get(job.id).status === 'completed');
  const output = queue.detail(job.id).output;
  assert.equal(output.rows, 130_000);
  assert.equal(output.columns[0].min, 1);
  assert.equal(output.columns[0].max, 1);
  assert.equal(output.columns[0].sum, 130_000);
});

test('hash-chain runs CPU work in a worker and persists a deterministic digest', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue(hashJob({ input: { seed: 'relay', iterations: 1000 } }));
  await waitFor(() => queue.get(job.id).status === 'completed');
  const output = queue.detail(job.id).output;
  assert.equal(output.iterations, 1000);
  assert.equal(output.digest, 'dc33ca87fa06484fd9763ee70f613c27cf2eea81ee1dec739ea79ff730f2df7b');
});

test('retries use exponential backoff, preserve failures, then execute real processor', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue(textJob({ failFirst: 2, maxAttempts: 3, backoffMs: 100 }));
  await waitFor(() => queue.get(job.id).status === 'completed');
  const detail = queue.detail(job.id);
  assert.equal(detail.attempts, 3);
  assert.equal(detail.output.words, 5);
  const attempts = detail.history.toReversed();
  assert.deepEqual(
    attempts.map((item) => item.status),
    ['failed', 'failed', 'completed'],
  );
  assert.ok(attempts[1].started_at - attempts[0].finished_at >= 100);
  assert.ok(attempts[2].started_at - attempts[1].finished_at >= 200);
  assert.equal(queue.snapshot().metrics.retries, 2);
});

test('dead letters stop automatically and manual retry preserves history and recovers', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue(textJob({ failFirst: 2, maxAttempts: 2, backoffMs: 100 }));
  await waitFor(() => queue.get(job.id).status === 'dead');
  assert.equal(queue.get(job.id).attempts, 2);
  assert.equal(queue.active.size, 0);
  queue.retry(job.id);
  await waitFor(() => queue.get(job.id).status === 'completed');
  assert.equal(queue.detail(job.id).history.length, 3);
  assert.equal(queue.get(job.id).maxAttempts, 3);
  assert.ok(queue.detail(job.id).events.some((event) => event.kind === 'manual_retry'));
});

test('idempotency returns existing job and rejects conflicting payload', async (t) => {
  const queue = await useQueue(t);
  queue.configure({ paused: true });
  const first = queue.enqueue(textJob({ idempotencyKey: 'import-42' }));
  const duplicate = queue.enqueue(textJob({ idempotencyKey: 'import-42' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.job.id, duplicate.job.id);
  assert.equal(queue.snapshot().metrics.total, 1);
  assert.throws(
    () => queue.enqueue(textJob({ idempotencyKey: 'import-42', name: 'Different' })),
    /different payload/,
  );
});

test('pause and delayed jobs remain unclaimed; pending cancellation executes no worker', async (t) => {
  const queue = await useQueue(t);
  queue.configure({ paused: true });
  const first = queue.enqueue(textJob()).job;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(queue.get(first.id).attempts, 0);
  await queue.cancel(first.id);
  assert.equal(queue.detail(first.id).history.length, 0);
  const delayed = queue.enqueue(textJob({ delayMs: 250 })).job;
  queue.configure({ paused: false });
  assert.equal(queue.get(delayed.id).status, 'queued');
  await waitFor(() => queue.get(delayed.id).status === 'completed');
  assert.ok(queue.get(delayed.id).startedAt >= delayed.availableAt);
});

test('running cancellation terminates the actual worker and prevents late result writes', async (t) => {
  const queue = await useQueue(t);
  const { job } = queue.enqueue(hashJob());
  const worker = queue.active.get(job.id);
  assert.ok(worker);
  await waitFor(() => queue.get(job.id).progress > 0);
  await queue.cancel(job.id);
  assert.equal(worker.threadId, -1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const detail = queue.detail(job.id);
  assert.equal(detail.status, 'cancelled');
  assert.equal(detail.output, null);
  assert.equal(detail.history[0].status, 'cancelled');
  assert.equal(queue.active.size, 0);
});

test('concurrent cancel and manual retry retain new worker tracking and concurrency bound', async (t) => {
  const queue = await useQueue(t);
  queue.configure({ concurrency: 1 });
  const { job } = queue.enqueue(hashJob());
  await waitFor(() => queue.get(job.id).progress > 0);
  const cancel = queue.cancel(job.id);
  queue.retry(job.id);
  await cancel;
  const second = queue.enqueue(textJob()).job;
  let max = 0;
  const listener = () => {
    max = Math.max(max, queue.active.size);
  };
  queue.on('change', listener);
  await waitFor(() => queue.get(job.id).status === 'completed');
  await waitFor(() => queue.get(second.id).status === 'completed');
  assert.ok(max <= 1);
  assert.equal(queue.detail(job.id).history.length, 2);
  assert.equal(queue.detail(job.id).history[0].status, 'completed');
});

test('atomic claims respect concurrency bounds across a batch and do not reclaim terminal work', async (t) => {
  const queue = await useQueue(t);
  queue.configure({ concurrency: 2, paused: true });
  const jobs = Array.from(
    { length: 8 },
    (_, i) =>
      queue.enqueue(hashJob({ name: `CPU ${i}`, input: { seed: 'relay', iterations: 80_000 } }))
        .job,
  );
  let maximum = 0;
  queue.on('change', () => {
    maximum = Math.max(maximum, queue.active.size);
    assert.ok(queue.snapshot().counts.running <= 2);
  });
  queue.configure({ paused: false });
  await waitFor(() => queue.snapshot().counts.completed === 8);
  assert.equal(maximum, 2);
  jobs.forEach((job) => assert.equal(queue.get(job.id).attempts, 1));
  queue.tick();
  assert.equal(queue.snapshot().counts.completed, 8);
});

test('abrupt process death recovers running work from disk without reclaiming completed work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-recovery-'));
  const db = join(dir, 'queue.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = `import { Queue } from ${JSON.stringify(new URL('../server/queue.mjs', import.meta.url).href)};
    const q = new Queue(${JSON.stringify(db)},{tickMs:10});
    const done=q.enqueue(${JSON.stringify(textJob())}).job;
    const interval=setInterval(()=>{ if(q.get(done.id).status==='completed') {
      clearInterval(interval); const pending=q.enqueue(${JSON.stringify(hashJob())}).job;
      console.log(JSON.stringify({done:done.id,pending:pending.id}));
    }},10);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const ids = await new Promise((resolveIds, reject) => {
    let data = '';
    let errors = '';
    const timeout = setTimeout(
      () => reject(new Error(`Child did not initialize: ${errors}`)),
      5000,
    );
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        clearTimeout(timeout);
        resolveIds(JSON.parse(data.trim()));
      }
    });
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const queue = new Queue(db, { tickMs: 10 });
  t.after(() => queue.close());
  await waitFor(() => queue.get(ids.pending).status === 'completed');
  assert.equal(queue.get(ids.done).attempts, 1);
  assert.equal(queue.get(ids.pending).attempts, 2);
  assert.deepEqual(
    queue.detail(ids.pending).history.map((attempt) => attempt.status),
    ['completed', 'interrupted'],
  );
  assert.ok(queue.detail(ids.pending).events.some((event) => event.kind === 'recovered'));
  assert.equal(queue.detail(ids.pending).output.iterations, 2_000_000);
});

test('single owner lock prevents a second scheduler and settings survive restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-owner-'));
  const db = join(dir, 'queue.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Queue(db);
  first.configure({ paused: true, concurrency: 4 });
  assert.throws(() => new Queue(db), /already owned/);
  await unlink(`${db}.lock`);
  assert.throws(
    () => new Queue(db),
    /already owned/,
    'Database ownership must protect claims even if lock file is deleted.',
  );
  await first.close();
  const second = new Queue(db);
  t.after(() => second.close());
  assert.deepEqual(second.settings(), { paused: true, concurrency: 4 });
});

test('validation blocks arbitrary task types and bounded input abuse', async (t) => {
  const queue = await useQueue(t);
  assert.throws(
    () => queue.enqueue({ type: 'shell', input: { command: 'anything' } }),
    /Type must/,
  );
  assert.throws(
    () => queue.enqueue(hashJob({ input: { seed: 'x', iterations: 3_000_000 } })),
    /Iterations/,
  );
  assert.throws(() => queue.configure({ concurrency: 99 }), /Concurrency/);
  assert.throws(() => queue.enqueue(textJob({ maxAttempts: 0 })), /Max attempts/);
});
