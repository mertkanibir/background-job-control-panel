export type JobStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'dead' | 'cancelled';
export type JobType = 'text-analysis' | 'csv-summary' | 'hash-chain';
export interface Job {
  id: string;
  name: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  failFirst: number;
  backoffMs: number;
  availableAt: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: number;
  error: string | null;
  idempotencyKey: string | null;
}
export interface QueueEvent {
  id: number;
  job_id: string;
  kind: string;
  message: string;
  at: number;
  name?: string;
  type?: JobType;
}
export interface Attempt {
  number: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  error: string | null;
}
export interface JobDetail extends Job {
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  events: QueueEvent[];
  history: Attempt[];
}
export interface Snapshot {
  settings: { concurrency: number; paused: boolean };
  counts: Record<JobStatus, number>;
  metrics: {
    total: number;
    retries: number;
    failedAttempts: number;
    averageDurationMs: number | null;
    successRate: number | null;
  };
  jobs: Job[];
  recent: QueueEvent[];
  truncated: boolean;
  now: number;
}
export const typeLabels: Record<JobType, string> = {
  'text-analysis': 'Text analysis',
  'csv-summary': 'CSV summary',
  'hash-chain': 'Hash chain',
};
export const statusLabels: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  retrying: 'Retry scheduled',
  completed: 'Completed',
  dead: 'Dead letter',
  cancelled: 'Cancelled',
};
export const duration = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const time = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
