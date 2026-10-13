import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Queue } from '../server/queue.mjs';
import { createApp } from '../server/index.mjs';

const job = {
  name: 'API report',
  type: 'text-analysis',
  input: { text: 'Durable queues process real work.' },
};
async function setup(t) {
  const queue = new Queue(':memory:', { tickMs: 10 });
  const app = createApp({ queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { ...app, url, post };
}
async function terminal(queue, id) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (['completed', 'dead', 'cancelled'].includes(queue.get(id).status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('API job did not reach terminal state.');
}

test('API accepts jobs, processes data, exposes persisted output and derived metrics', async (t) => {
  const { queue, url, post } = await setup(t);
  const response = await post('/api/jobs', job);
  assert.equal(response.status, 201);
  const { job: created } = await response.json();
  await terminal(queue, created.id);
  const detailResponse = await fetch(`${url}/api/jobs/${created.id}`);
  const detail = await detailResponse.json();
  assert.equal(detail.status, 'completed');
  assert.equal(detail.output.words, 5);
  const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(snapshot.metrics.successRate, 100);
  assert.equal(snapshot.jobs[0].input, undefined);
  assert.equal(snapshot.metrics.total, 1);
});

test('HTTP idempotency and invalid input produce explicit responses', async (t) => {
  const { queue, url, post } = await setup(t);
  queue.configure({ paused: true });
  const body = { ...job, idempotencyKey: 'api-key' };
  assert.equal((await post('/api/jobs', body)).status, 201);
  assert.equal((await post('/api/jobs', body)).status, 200);
  assert.equal((await post('/api/jobs', { ...body, name: 'Conflict' })).status, 400);
  assert.equal((await post('/api/jobs', { type: 'shell' })).status, 400);
  assert.equal((await fetch(url + '/api/jobs/missing')).status, 404);
  assert.equal((await fetch(url + '/api/jobs', { method: 'POST', body: '{}' })).status, 400);
});

test('mutating endpoints block foreign origins and DNS rebinding hostnames', async (t) => {
  const { post, url } = await setup(t);
  assert.equal((await post('/api/jobs', job, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/jobs', job, { Origin: url })).status, 201);
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(
      url + '/api/snapshot',
      { headers: { Host: 'evil.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.once('error', reject);
    req.end();
  });
  assert.equal(rebound, 403);
});

test('SSE emits invalidations on durable mutation and reconnect starts with fresh state', async (t) => {
  const { queue, url, post } = await setup(t);
  queue.configure({ paused: true });
  const controller = new AbortController();
  const response = await fetch(url + '/api/events', { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: update/);
  const nextChunk = reader.read();
  await post('/api/jobs', job);
  const next = new TextDecoder().decode((await nextChunk).value);
  assert.match(next, /version/);
  controller.abort();
  await reader.cancel().catch(() => {});
  const reconnect = new AbortController();
  const newStream = await fetch(url + '/api/events', { signal: reconnect.signal });
  const newReader = newStream.body.getReader();
  assert.match(new TextDecoder().decode((await newReader.read()).value), /event: update/);
  reconnect.abort();
  await newReader.cancel().catch(() => {});
  const snapshot = await (await fetch(url + '/api/snapshot')).json();
  assert.equal(snapshot.metrics.total, 1);
});

test('HTTP pause, cancellation and manual retry drive persisted state transitions', async (t) => {
  const { queue, post } = await setup(t);
  await post('/api/settings', { paused: true, concurrency: 1 });
  const created = (await (await post('/api/jobs', job)).json()).job;
  const cancelled = await post(`/api/jobs/${created.id}/cancel`, {});
  assert.equal((await cancelled.json()).status, 'cancelled');
  await post(`/api/jobs/${created.id}/retry`, {});
  assert.equal(queue.get(created.id).status, 'queued');
  await post('/api/settings', { paused: false });
  await terminal(queue, created.id);
  assert.equal(queue.get(created.id).status, 'completed');
  assert.equal(queue.detail(created.id).history.length, 1);
});
