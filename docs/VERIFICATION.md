# Verification record

Verified locally on November 15, 2026, with Node v24.22.3 on macOS arm64 (Apple M4). The frontend refresh preserves the existing local queue engine. All captures use generated demonstration inputs and a temporary database.

## Engine and HTTP API

`npm test`: **19 passed, 0 failed**.

- Real text, CSV and SHA-256 worker outputs persisted in SQLite.
- Quoted CSV fields and 130,000 rows without argument-stack overflow.
- Exponential retry timing, dead-letter exhaustion and successful manual recovery.
- Durable idempotency and explicit conflicting-payload rejection.
- Paused/scheduled claims, pending cancellation without execution and actual running-worker termination.
- Concurrent cancellation/manual retry retains the correct active worker.
- Eight CPU jobs obey concurrency 2; terminal jobs are not reclaimed.
- A child process receives SIGKILL while working. The next scheduler records interruption and completes the unfinished job. A previously completed job keeps one attempt.
- A second owner is rejected even when the filesystem lock is removed; settings persist across restart.
- HTTP commands expose stored results, SSE invalidations/reconnects work, and foreign origins/non-local hostnames are rejected.

## Production build and browser

`npm run build`: TypeScript validation and Vite production build passed.

`npm run test:browser -- --record-motion`: Chromium smoke passed with **zero page errors**. It launches the built frontend and local API together against an ephemeral on-disk database and verifies this complete path:

`React form → HTTP API → SQLite claim → worker thread → persisted result → SSE → inspector`

The run checks:

1. Six real demo jobs reach five completed records and one dead letter. The retry timeline retains the intentional failures and two-second second backoff.
2. `/` focuses search. A term with no matching records exposes the empty result state; clearing it restores the records. Escape outside an input clears selection.
3. Switching to another record while its detail request is delayed hides the previous record immediately. The inspector shows a loading state until the matching detail arrives.
4. A dead letter is retried and completes with its history preserved.
5. The browser pauses the queue, enqueues text, cancels the pending record, grants another attempt, resumes, and reads the actual output (`words: 5`).
6. A live two-million-iteration hash job occupies capacity. Cancelling terminates it and records cancellation.
7. SSE snapshots keep the same mounted view, so refreshes do not replay the introduction.
8. At 390px, the document does not overflow horizontally. Execution records expose state, attempts and duration without sideways table scrolling. The selected inspector is above the queue.
9. A real running worker produces the capacity pulse. Reduced motion disables that pulse and the view/inspector animations.

The same run writes [desktop](screenshot.png) (1600 × 1337) and [mobile](screenshot-mobile.png) (390 × 2199) full-page screenshots. Capture disables in-flight animations. The [interaction recording](motion-demo.webm) shows navigation, inspection, the enqueue dialog and cancellation of a live hash chain in the refreshed interface.

## Measured queue run

`npm run benchmark`: 100 text jobs, 13,700 characters each, concurrency 3. The run completed in 728.12 ms including enqueue, observed at most 3 workers, and verified 100 persisted outputs. Successful attempt p50/p95/max were 18/29/40 ms. See the [raw record](benchmark-2026-11-15.json).

This is one local run with worker startup and durable writes. Other machines and concurrent workloads can differ; it does not establish production capacity.

## Scope

These checks establish local queue behavior and the browser/API/data path. Distributed execution, multi-user authorization and exactly-once external side effects are outside the implemented scope. The server remains bound to localhost; the repository documents this limit and the at-least-once recovery model.
