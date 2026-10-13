import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateJob } from './processors.mjs';

const mapJob = (row) =>
  row && {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    input: JSON.parse(row.input),
    output: row.output ? JSON.parse(row.output) : null,
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    failFirst: row.fail_first,
    backoffMs: row.backoff_ms,
    availableAt: row.available_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    progress: row.progress,
    idempotencyKey: row.idempotency_key,
  };

export class Queue extends EventEmitter {
  constructor(path = './data/relay.sqlite', { tickMs = 100, autoStart = true } = {}) {
    super();
    this.active = new Map();
    this.closing = false;
    this.token = randomUUID();
    if (path !== ':memory:') {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true });
      this.lockPath = `${path}.lock`;
      if (existsSync(this.lockPath)) {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        let alive = true;
        try {
          process.kill(lock.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
        }
        if (alive)
          throw new Error(
            `Queue database is already owned by process ${lock.pid}. Use a separate database for another server.`,
          );
        unlinkSync(this.lockPath);
      }
      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, token: this.token }), {
        flag: 'wx',
      });
    }
    try {
      this.db = new DatabaseSync(path, { timeout: 5_000 });
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','retrying','completed','dead','cancelled')),
          input TEXT NOT NULL, output TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL, fail_first INTEGER NOT NULL, backoff_ms INTEGER NOT NULL,
          available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
          progress INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, fingerprint TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, available_at, created_at);
        CREATE TABLE IF NOT EXISTS attempts (
          job_id TEXT NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL,
          started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, error TEXT,
          PRIMARY KEY(job_id, number)
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
          kind TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), concurrency INTEGER NOT NULL, paused INTEGER NOT NULL);
        INSERT OR IGNORE INTO settings VALUES(1, 3, 0);
        CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      `);
      // The transactional owner record is authoritative, even if a lock file is
      // accidentally removed or two processes race while cleaning up a stale file.
      this.transaction(() => {
        const owner = this.db.prepare('SELECT * FROM owner WHERE id=1').get();
        if (owner) {
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') alive = false;
          }
          if (alive) throw new Error(`Queue database is already owned by process ${owner.pid}.`);
        }
        this.db
          .prepare('INSERT OR REPLACE INTO owner(id,pid,token) VALUES(1,?,?)')
          .run(process.pid, this.token);
      });
      this.recover();
      if (autoStart) this.timer = setInterval(() => this.tick(), tickMs);
    } catch (error) {
      this.db?.close();
      this.releaseLock();
      throw error;
    }
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  event(id, kind, message, at = Date.now()) {
    this.db
      .prepare('INSERT INTO events(job_id, kind, message, at) VALUES(?,?,?,?)')
      .run(id, kind, message, at);
  }
  changed() {
    this.emit('change');
  }
  settings() {
    const row = this.db.prepare('SELECT * FROM settings WHERE id=1').get();
    return { concurrency: row.concurrency, paused: Boolean(row.paused) };
  }
  configure(body) {
    const current = this.settings();
    const concurrency = body.concurrency ?? current.concurrency;
    const paused = body.paused ?? current.paused;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('Concurrency must be an integer from 1 to 8.');
    if (typeof paused !== 'boolean') throw new Error('Paused must be a boolean.');
    this.db
      .prepare('UPDATE settings SET concurrency=?, paused=? WHERE id=1')
      .run(concurrency, Number(paused));
    this.changed();
    this.tick();
    return this.settings();
  }

  enqueue(body) {
    if (this.closing) throw new Error('Queue is shutting down.');
    const job = validateJob(body);
    const fingerprint = JSON.stringify({
      type: job.type,
      name: job.name,
      input: job.input,
      maxAttempts: job.maxAttempts,
      failFirst: job.failFirst,
      delayMs: job.delayMs,
      backoffMs: job.backoffMs,
    });
    const result = this.transaction(() => {
      if (job.idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM jobs WHERE idempotency_key=?')
          .get(job.idempotencyKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new Error('Idempotency key already exists with a different payload.');
          return { job: mapJob(existing), duplicate: true };
        }
      }
      const id = randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO jobs(id,name,type,status,input,max_attempts,fail_first,backoff_ms,available_at,created_at,idempotency_key,fingerprint)
        VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          job.name,
          job.type,
          JSON.stringify(job.input),
          job.maxAttempts,
          job.failFirst,
          job.backoffMs,
          now + job.delayMs,
          now,
          job.idempotencyKey,
          fingerprint,
        );
      this.event(
        id,
        'enqueued',
        job.delayMs ? `Scheduled in ${job.delayMs} ms.` : 'Job accepted into the durable queue.',
        now,
      );
      return { job: this.get(id), duplicate: false };
    });
    this.changed();
    this.tick();
    return result;
  }

  get(id) {
    return mapJob(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }
  detail(id) {
    const job = this.get(id);
    if (!job) return null;
    return {
      ...job,
      events: this.db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id DESC').all(id),
      history: this.db
        .prepare('SELECT * FROM attempts WHERE job_id=? ORDER BY number DESC')
        .all(id),
    };
  }

  claim() {
    return this.transaction(() => {
      const now = Date.now();
      const row = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','retrying') AND available_at<=? ORDER BY available_at,created_at,id LIMIT 1",
        )
        .get(now);
      if (!row) return null;
      const updated = this.db
        .prepare(
          "UPDATE jobs SET status='running',attempts=attempts+1,started_at=?,finished_at=NULL,progress=0,error=NULL WHERE id=? AND status IN ('queued','retrying')",
        )
        .run(now, row.id);
      if (updated.changes !== 1) return null;
      this.db
        .prepare("INSERT INTO attempts(job_id,number,started_at,status) VALUES(?,?,?,'running')")
        .run(row.id, row.attempts + 1, now);
      this.event(row.id, 'started', `Attempt ${row.attempts + 1} claimed by a worker.`, now);
      return this.get(row.id);
    });
  }

  tick() {
    if (this.closing || this.settings().paused) return;
    while (this.active.size < this.settings().concurrency) {
      const job = this.claim();
      if (!job) break;
      this.run(job);
    }
  }

  run(job) {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: {
        type: job.type,
        input: job.input,
        attempt: job.attempts,
        failFirst: job.failFirst,
      },
      execArgv: [],
    });
    this.active.set(job.id, worker);
    this.changed();
    let settled = false;
    const settle = (output, error) => {
      if (settled) return;
      settled = true;
      this.finish(job.id, job.attempts, output, error);
      if (this.active.get(job.id) === worker) this.active.delete(job.id);
      this.changed();
      this.tick();
    };
    worker.on('message', (message) => {
      if (message.kind === 'progress' && !settled) {
        const current = this.get(job.id);
        if (current.status === 'running' && message.progress >= current.progress + 5) {
          this.db
            .prepare("UPDATE jobs SET progress=? WHERE id=? AND status='running'")
            .run(message.progress, job.id);
          this.changed();
        }
      } else if (message.kind === 'result') settle(message.output, null);
      else if (message.kind === 'failure') settle(null, message.error);
    });
    worker.on('error', (error) => settle(null, error.message));
    worker.on('exit', (code) => {
      if (!settled && !this.closing)
        settle(null, `Worker exited before returning a result (code ${code}).`);
    });
  }

  finish(id, number, output, error) {
    if (this.closing) return;
    this.transaction(() => {
      const job = this.get(id);
      if (!job || job.status !== 'running' || job.attempts !== number) return;
      const now = Date.now();
      const dead = error && job.attempts >= job.maxAttempts;
      const status = error ? (dead ? 'dead' : 'retrying') : 'completed';
      const wait = job.backoffMs * 2 ** (job.attempts - 1);
      this.db
        .prepare(
          'UPDATE jobs SET status=?,output=?,error=?,finished_at=?,available_at=?,progress=? WHERE id=?',
        )
        .run(
          status,
          output == null ? null : JSON.stringify(output),
          error,
          status === 'retrying' ? null : now,
          error ? now + wait : now,
          error ? 0 : 100,
          id,
        );
      this.db
        .prepare('UPDATE attempts SET finished_at=?,status=?,error=? WHERE job_id=? AND number=?')
        .run(now, error ? 'failed' : 'completed', error, id, number);
      this.event(
        id,
        status,
        error
          ? dead
            ? `Dead letter: ${error}`
            : `Retry in ${wait} ms: ${error}`
          : 'Worker result persisted successfully.',
        now,
      );
    });
  }

  async cancel(id) {
    const job = this.get(id);
    if (!job) throw new Error('Job not found.');
    if (!['queued', 'retrying', 'running'].includes(job.status))
      throw new Error('Only active or pending jobs can be cancelled.');
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare("UPDATE jobs SET status='cancelled',finished_at=?,error=NULL WHERE id=?")
        .run(now, id);
      if (job.status === 'running')
        this.db
          .prepare(
            "UPDATE attempts SET status='cancelled',finished_at=? WHERE job_id=? AND number=?",
          )
          .run(now, id, job.attempts);
      this.event(
        id,
        'cancelled',
        job.status === 'running'
          ? 'Cancelled and worker termination requested.'
          : 'Removed from pending work.',
        now,
      );
    });
    this.changed();
    const worker = this.active.get(id);
    if (worker) await worker.terminate();
    if (this.active.get(id) === worker) this.active.delete(id);
    this.tick();
    return this.get(id);
  }

  retry(id) {
    const job = this.get(id);
    if (!job) throw new Error('Job not found.');
    if (!['dead', 'cancelled'].includes(job.status))
      throw new Error('Only dead-letter or cancelled jobs can be retried.');
    const now = Date.now();
    this.transaction(() => {
      // A manual retry grants one additional attempt while preserving the entire prior history.
      this.db
        .prepare(
          "UPDATE jobs SET status='queued',max_attempts=MAX(max_attempts,attempts+1),available_at=?,finished_at=NULL,output=NULL,error=NULL,progress=0 WHERE id=?",
        )
        .run(now, id);
      this.event(id, 'manual_retry', 'Operator granted one additional attempt.', now);
    });
    this.changed();
    this.tick();
    return this.get(id);
  }

  recover() {
    const running = this.db.prepare("SELECT * FROM jobs WHERE status='running'").all();
    this.transaction(() => {
      for (const row of running) {
        const now = Date.now();
        const exhausted = row.attempts >= row.max_attempts;
        this.db
          .prepare(
            'UPDATE jobs SET status=?,available_at=?,finished_at=?,progress=0,error=? WHERE id=?',
          )
          .run(
            exhausted ? 'dead' : 'queued',
            now,
            exhausted ? now : null,
            'Worker interrupted by process shutdown.',
            row.id,
          );
        this.db
          .prepare(
            "UPDATE attempts SET status='interrupted',finished_at=?,error=? WHERE job_id=? AND number=?",
          )
          .run(now, 'Worker interrupted by process shutdown.', row.id, row.attempts);
        this.event(
          row.id,
          'recovered',
          exhausted
            ? 'Restart recovered an interrupted attempt; retry budget exhausted.'
            : 'Restart recovered an interrupted attempt and requeued the job.',
          now,
        );
      }
    });
  }

  snapshot() {
    const counts = Object.fromEntries(
      ['queued', 'running', 'retrying', 'completed', 'dead', 'cancelled'].map((status) => [
        status,
        0,
      ]),
    );
    for (const row of this.db
      .prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status')
      .all())
      counts[row.status] = row.count;
    const timing = this.db
      .prepare(
        "SELECT COUNT(*) AS count,AVG(finished_at-started_at) AS avgMs FROM attempts WHERE status='completed'",
      )
      .get();
    const retries = this.db
      .prepare('SELECT COUNT(*) AS count FROM attempts WHERE number>1')
      .get().count;
    const failed = this.db
      .prepare("SELECT COUNT(*) AS count FROM attempts WHERE status='failed'")
      .get().count;
    const recent = this.db
      .prepare(
        'SELECT events.*,jobs.name,jobs.type FROM events JOIN jobs ON jobs.id=events.job_id ORDER BY events.id DESC LIMIT 8',
      )
      .all();
    const jobs = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC,id DESC LIMIT 500')
      .all()
      .map(mapJob)
      .map(({ input, output, ...rest }) => rest);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      settings: this.settings(),
      counts,
      metrics: {
        total,
        retries,
        failedAttempts: failed,
        averageDurationMs: timing.avgMs,
        successRate:
          counts.completed + counts.dead
            ? (counts.completed / (counts.completed + counts.dead)) * 100
            : null,
      },
      jobs,
      recent,
      truncated: total > 500,
      now: Date.now(),
    };
  }

  demo() {
    const jobs = [
      {
        name: 'Release notes · word frequency',
        type: 'text-analysis',
        input: {
          text: 'Relay makes background work visible. Durable jobs survive restarts. Workers process real data, retries handle failures, and operators recover dead letters with confidence. Background work deserves clear control.',
        },
      },
      {
        name: 'October orders · quality scan',
        type: 'csv-summary',
        input: {
          csv: 'order_id,region,revenue\nA100,North,120\nA101,South,85\nA102,North,\nA103,West,240\nA101,South,85',
        },
      },
      {
        name: 'Build fingerprint · SHA-256',
        type: 'hash-chain',
        input: { seed: 'release-2026.10', iterations: 750_000 },
      },
      {
        name: 'Retry demonstration · succeeds on attempt 3',
        type: 'text-analysis',
        input: { text: 'A real worker result appears after two intentionally injected failures.' },
        failFirst: 2,
        maxAttempts: 3,
      },
      {
        name: 'Dead-letter demonstration · exhausted budget',
        type: 'csv-summary',
        input: { csv: 'sku,stock\nR01,12\nR02,7' },
        failFirst: 2,
        maxAttempts: 2,
      },
      {
        name: 'Scheduled report · starts in 15 seconds',
        type: 'text-analysis',
        input: {
          text: 'Scheduled work is stored durably and becomes eligible after its due time.',
        },
        delayMs: 15_000,
      },
    ];
    return jobs.map((job) => this.enqueue(job).job);
  }

  releaseLock() {
    if (this.lockPath && existsSync(this.lockPath)) {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (lock.token === this.token) unlinkSync(this.lockPath);
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.active.values()].map((worker) => worker.terminate()));
    this.active.clear();
    this.recover();
    this.db.prepare('DELETE FROM owner WHERE token=?').run(this.token);
    this.db.close();
    this.releaseLock();
  }
}
