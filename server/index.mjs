import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from './queue.mjs';

const json = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};
async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('Use application/json for requests.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request exceeds 1 MB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error('Request must be valid JSON.');
  }
}

export function createApp({
  database = process.env.RELAY_DB ?? './data/relay.sqlite',
  queue: providedQueue,
  staticDir = resolve('dist'),
} = {}) {
  const queue = providedQueue ?? new Queue(database);
  const streams = new Set();
  let version = 0;
  const publish = () => {
    version++;
    for (const res of streams) res.write(`event: update\ndata: ${JSON.stringify({ version })}\n\n`);
  };
  queue.on('change', publish);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = req.headers.host ?? '';
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return json(res, 400, { error: 'Invalid URL.' });
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return json(res, 403, { error: 'Relay only accepts localhost requests.' });
    if (req.method !== 'GET' && req.headers.origin) {
      let allowed = false;
      try {
        const origin = new URL(req.headers.origin);
        allowed =
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
          ['5175', String(server.address()?.port)].includes(origin.port);
      } catch {
        /* Invalid origins are rejected. */
      }
      if (!allowed) return json(res, 403, { error: 'Cross-origin queue mutations are blocked.' });
    }
    try {
      if (url.pathname === '/api/health' && req.method === 'GET')
        return json(res, 200, { ok: true });
      if (url.pathname === '/api/snapshot' && req.method === 'GET')
        return json(res, 200, queue.snapshot());
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: update\ndata: ${JSON.stringify({ version })}\n\n`);
        streams.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
        req.on('close', () => {
          streams.delete(res);
          clearInterval(heartbeat);
        });
        return;
      }
      if (url.pathname === '/api/jobs' && req.method === 'POST') {
        const result = queue.enqueue(await readBody(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === '/api/settings' && req.method === 'POST')
        return json(res, 200, queue.configure(await readBody(req)));
      if (url.pathname === '/api/demo' && req.method === 'POST') {
        await readBody(req);
        return json(res, 201, { jobs: queue.demo() });
      }
      const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(cancel|retry))?$/);
      if (match) {
        if (!queue.get(match[1])) return json(res, 404, { error: 'Job not found.' });
        if (req.method === 'GET' && !match[2]) return json(res, 200, queue.detail(match[1]));
        if (req.method === 'POST' && match[2]) {
          await readBody(req);
          return json(
            res,
            200,
            match[2] === 'cancel' ? await queue.cancel(match[1]) : queue.retry(match[1]),
          );
        }
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint not found.' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      let path = resolve(staticDir, '.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(staticDir + '/') && path !== staticDir)
        return json(res, 403, { error: 'Invalid path.' });
      if (url.pathname === '/' || !extname(path)) path = join(staticDir, 'index.html');
      const content = await readFile(path);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, {
        'Content-Type': types[extname(path)] ?? 'application/octet-stream',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.code === 'ENOENT' ? 404 : 400;
      json(res, status, {
        error:
          error.code === 'ENOENT' ? 'Build the frontend first with npm run build.' : error.message,
      });
    }
  });
  const close = async () => {
    queue.off('change', publish);
    for (const res of streams) res.end();
    await new Promise((resolveClose) => server.close(resolveClose));
    await queue.close();
  };
  return { server, queue, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 4175);
  app.server.listen(port, '127.0.0.1', () =>
    console.log(`Relay API and production UI: http://127.0.0.1:${port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
