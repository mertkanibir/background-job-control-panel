import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';

const dir = await mkdtemp(join(tmpdir(), 'relay-browser-'));
const app = createApp({ database: join(dir, 'queue.sqlite') });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
let browser;
async function poll(check, timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser flow timed out waiting for verified state.');
}
const apiUrl = `http://127.0.0.1:${app.server.address().port}`;
const snapshot = async () => (await fetch(apiUrl + '/api/snapshot')).json();
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(apiUrl);
  await page.getByRole('heading', { name: 'Keep the work moving.' }).waitFor();
  await page.locator('.connection').filter({ hasText: 'Live updates' }).waitFor();
  await page.getByRole('button', { name: 'Run demo batch', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.job-table tbody tr').length === 6);
  await poll(async () => {
    const data = await snapshot();
    return data.counts.completed === 5 && data.counts.dead === 1;
  });
  await poll(async () => (await page.locator('.job-table .status-completed').count()) === 5);
  await page
    .getByRole('button', { name: 'Inspect Retry demonstration · succeeds on attempt 3' })
    .click();
  await page
    .getByRole('heading', { name: 'Retry demonstration · succeeds on attempt 3', exact: true })
    .waitFor();
  await page.locator('.inspector .status-completed').waitFor();
  await page.getByRole('tab', { name: /Timeline/ }).click();
  await page.getByText('Retry in 2000 ms:', { exact: false }).waitFor();
  await mkdir('docs', { recursive: true });
  await page.screenshot({ path: 'docs/screenshot.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshot-mobile.png', fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile page must not overflow horizontally',
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: /Dead letters/ }).click();
  await page
    .getByRole('button', { name: 'Inspect Dead-letter demonstration · exhausted budget' })
    .click();
  await page
    .getByRole('heading', { name: 'Dead-letter demonstration · exhausted budget', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Retry job', exact: true }).click();
  await poll(async () => (await snapshot()).counts.completed === 6);
  await page.getByRole('button', { name: 'Job queue', exact: false }).click();
  await page.getByRole('button', { name: 'Pause queue', exact: true }).click();
  await page.getByRole('button', { name: 'Enqueue job', exact: true }).click();
  await page.getByLabel('Job name', { exact: true }).fill('Browser word report');
  await page
    .getByLabel('Text to analyze', { exact: true })
    .fill('Browser verified work. Durable work.');
  await page.getByRole('dialog').getByRole('button', { name: 'Enqueue job', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser word report' }).waitFor();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await page.getByRole('button', { name: 'Retry job', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry job', exact: true }).click();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await poll(async () => (await snapshot()).counts.completed === 7);
  await page.getByRole('tab', { name: 'output', exact: true }).click();
  await page.locator('.payload-panel pre').filter({ hasText: '"words": 5' }).waitFor();
  await page.getByRole('button', { name: 'Enqueue job', exact: true }).click();
  await page.getByRole('button', { name: 'Hash chain', exact: true }).click();
  await page.getByLabel('Job name', { exact: true }).fill('Browser running cancellation');
  await page.getByLabel('SHA-256 iterations', { exact: true }).fill('2000000');
  await page.getByRole('dialog').getByRole('button', { name: 'Enqueue job', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser running cancellation' }).waitFor();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await page.getByRole('button', { name: 'Retry job', exact: true }).waitFor();
  assert.equal(app.queue.snapshot().counts.cancelled, 1);
  assert.equal(errors.length, 0, `Browser errors: ${errors.join('; ')}`);
  console.log(
    'Browser smoke passed: demo output/retry timeline, dead-letter recovery, enqueue, pause/resume, pending and running cancellation, SSE updates, desktop/mobile layout; zero page errors.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
