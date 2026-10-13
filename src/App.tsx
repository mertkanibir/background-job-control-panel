import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Box,
  ChevronRight,
  CircleCheck,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Pause,
  Play,
  Plus,
  Search,
  ShieldAlert,
  Terminal,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { request } from './api';
import type { JobDetail, JobStatus, Snapshot } from './types';
import { duration, time } from './types';
import { JobTable } from './components/JobTable';
import { JobInspector } from './components/JobInspector';
import { EnqueueDialog } from './components/EnqueueDialog';

type View = 'jobs' | 'dead' | 'activity';
const filters: { value: 'all' | JobStatus; label: string }[] = [
  { value: 'all', label: 'All jobs' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'retrying', label: 'Retrying' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('jobs');
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeFetch = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    activeFetch.current?.abort();
    const controller = new AbortController();
    activeFetch.current = controller;
    try {
      setSnapshot(await request<Snapshot>('/snapshot', undefined, controller.signal));
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const stream = new EventSource('/api/events');
    let debounce: ReturnType<typeof setTimeout>;
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('update', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), 80);
    });
    return () => {
      stream.close();
      clearTimeout(debounce);
      activeFetch.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    request<JobDetail>(`/jobs/${selected}`, undefined, controller.signal)
      .then(setDetail)
      .catch((cause) => {
        if (cause.name !== 'AbortError') setError(cause.message);
      });
    return () => controller.abort();
  }, [selected, snapshot]);
  const mutate = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError('');
    try {
      await request(path, body);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const counts = snapshot?.counts;
  const jobs = useMemo(
    () =>
      (snapshot?.jobs ?? []).filter(
        (job) =>
          (view === 'dead' ? job.status === 'dead' : filter === 'all' || job.status === filter) &&
          `${job.name} ${job.id} ${job.type}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [snapshot, view, filter, search],
  );
  const changeView = (next: View) => {
    setView(next);
    setFilter('all');
    setSearch('');
  };
  const runDemo = async () => {
    setBusy(true);
    setError('');
    try {
      const { jobs: created } = await request<{ jobs: { id: string }[] }>('/demo', {});
      changeView('jobs');
      setSelected(created[0].id);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Relay home">
          <span className="brand-mark">
            <Workflow size={25} strokeWidth={2.4} />
          </span>
          <span>
            relay<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">MK</span>
          <div>
            <strong>Local workspace</strong>
            <span>Development environment</span>
          </div>
          <ChevronRight size={14} />
        </div>
        <span className="nav-label">OPERATIONS</span>
        <nav aria-label="Main navigation">
          <button
            onClick={() => changeView('jobs')}
            className={view === 'jobs' ? 'nav-active' : ''}
            aria-current={view === 'jobs' ? 'page' : undefined}
          >
            <Layers3 size={18} />
            Job queue<span className="nav-count">{snapshot?.metrics.total ?? 0}</span>
          </button>
          <button
            onClick={() => changeView('dead')}
            className={view === 'dead' ? 'nav-active' : ''}
            aria-current={view === 'dead' ? 'page' : undefined}
          >
            <ShieldAlert size={18} />
            Dead letters
            {counts?.dead ? <span className="nav-count alert-count">{counts.dead}</span> : null}
          </button>
          <button
            onClick={() => changeView('activity')}
            className={view === 'activity' ? 'nav-active' : ''}
            aria-current={view === 'activity' ? 'page' : undefined}
          >
            <Activity size={18} />
            Recent activity
          </button>
        </nav>
        <div className="sidebar-note">
          <Terminal size={19} />
          <h3>Real work. Full control.</h3>
          <p>Inspect payloads, recover failures and follow every attempt.</p>
          <button onClick={() => void runDemo()} disabled={busy}>
            Try a demo batch
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-footer">
          <span>
            <Database size={14} />
            SQLite · WAL mode
          </span>
          <small>Relay / v1.0.0</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <strong>
              {view === 'dead' ? 'Dead letters' : view === 'activity' ? 'Activity' : 'Job queue'}
            </strong>
          </div>
          <div className="connection">
            <span className={connected ? 'green-dot' : 'offline-dot'} />
            {connected ? 'Live updates' : 'Reconnecting…'}
            <span className="env-tag">LOCAL</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">BACKGROUND OPERATIONS</span>
              <h1>
                {view === 'dead'
                  ? 'Recover the exceptions.'
                  : view === 'activity'
                    ? 'Follow the work.'
                    : 'Keep the work moving.'}
              </h1>
              <p>
                {view === 'dead'
                  ? 'Inspect exhausted jobs and grant another attempt when you’re ready.'
                  : view === 'activity'
                    ? 'A durable record of what your workers have been doing.'
                    : 'One place to watch, inspect and orchestrate your background jobs.'}
              </p>
            </div>
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={17} />
              Enqueue job
            </button>
          </div>
          {error ? (
            <div className="page-error" role="alert">
              <ShieldAlert size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          ) : null}
          <section className="metric-grid" aria-label="Queue metrics">
            <Metric
              title="TOTAL JOBS"
              value={snapshot?.metrics.total.toString() ?? '—'}
              subtitle="Persisted in this workspace"
              icon={<Box size={18} />}
            />
            <Metric
              title="ACTIVE WORKERS"
              value={counts ? `${counts.running}` : '—'}
              suffix={snapshot ? `/ ${snapshot.settings.concurrency}` : ''}
              subtitle={
                snapshot?.settings.paused
                  ? 'Queue paused · running jobs continue'
                  : `${(counts?.queued ?? 0) + (counts?.retrying ?? 0)} jobs waiting`
              }
              icon={<Zap size={18} />}
              accent
            />
            <Metric
              title="RETRY ATTEMPTS"
              value={snapshot?.metrics.retries.toString() ?? '—'}
              subtitle={`${snapshot?.metrics.failedAttempts ?? 0} failed attempts recorded`}
              icon={<ArrowDownRight size={18} />}
            />
            <Metric
              title="SUCCESS RATE"
              value={
                snapshot?.metrics.successRate == null
                  ? '—'
                  : `${snapshot.metrics.successRate.toFixed(0)}%`
              }
              subtitle={`Completed / (completed + dead letters)`}
              icon={<CircleCheck size={18} />}
            />
          </section>
          <section className="engine-bar" aria-label="Queue controls">
            <div className="engine-status">
              <span className={snapshot?.settings.paused ? 'paused-indicator' : 'green-dot'} />
              <div>
                <strong>
                  {snapshot?.settings.paused ? 'Queue paused' : 'Queue is operational'}
                </strong>
                <span>
                  {snapshot?.settings.paused
                    ? 'New claims are on hold. Active work can finish.'
                    : 'Durable storage · atomic claims · isolated workers'}
                </span>
              </div>
            </div>
            <div className="engine-controls">
              <label>
                <Gauge size={15} />
                <span>Concurrency</span>
                <select
                  aria-label="Worker concurrency"
                  value={snapshot?.settings.concurrency ?? 3}
                  disabled={busy || !snapshot}
                  onChange={(event) =>
                    void mutate('/settings', { concurrency: Number(event.target.value) })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <span className="control-divider" />
              <button
                className="button subtle"
                disabled={busy || !snapshot}
                onClick={() => void mutate('/settings', { paused: !snapshot?.settings.paused })}
              >
                {snapshot?.settings.paused ? <Play size={15} /> : <Pause size={15} />}
                {snapshot?.settings.paused ? 'Resume queue' : 'Pause queue'}
              </button>
            </div>
          </section>
          {view === 'activity' ? (
            <section className="activity-card">
              <div className="card-heading">
                <h2>Recent activity</h2>
                <span>Last 8 durable events</span>
              </div>
              {snapshot?.recent.length ? (
                snapshot.recent.map((event) => (
                  <button
                    className="activity-entry"
                    key={event.id}
                    onClick={() => {
                      changeView('jobs');
                      setSelected(event.job_id);
                    }}
                  >
                    <span className={`activity-symbol symbol-${event.kind}`}>
                      <Activity size={17} />
                    </span>
                    <span>
                      <strong>{event.name}</strong>
                      <small>{event.message}</small>
                    </span>
                    <time className="mono">{time(event.at)}</time>
                    <ArrowUpRight size={15} />
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <Activity size={30} />
                  <h3>The timeline is clear.</h3>
                  <p>Enqueue a job to start building its durable history.</p>
                </div>
              )}
            </section>
          ) : (
            <div className={`work-grid ${detail ? 'has-selection' : ''}`}>
              <section className="queue-card" aria-label="Job queue">
                <div className="card-heading">
                  <div>
                    <h2>
                      {view === 'dead' ? 'Dead-letter queue' : 'Job queue'}
                      <span className="count-badge">{jobs.length}</span>
                    </h2>
                    <p>
                      {view === 'dead'
                        ? 'Jobs that exhausted their automatic retry budget.'
                        : 'Every task, from first claim to final result.'}
                    </p>
                  </div>
                  <button
                    className="button subtle demo-button"
                    onClick={() => void runDemo()}
                    disabled={busy}
                  >
                    <Play size={13} />
                    Run demo batch
                  </button>
                </div>
                <div className="queue-toolbar">
                  {view !== 'dead' ? (
                    <div className="filter-tabs" role="group" aria-label="Job status filter">
                      {filters.map((item) => (
                        <button
                          className={filter === item.value ? 'active' : ''}
                          aria-pressed={filter === item.value}
                          onClick={() => setFilter(item.value)}
                          key={item.value}
                        >
                          {item.label}
                          {item.value === 'running' && counts?.running ? (
                            <span>{counts.running}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">{counts?.dead ?? 0} jobs need attention</span>
                  )}
                  <div className="search-field">
                    <Search size={14} />
                    <input
                      aria-label="Search jobs"
                      placeholder="Search jobs…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                </div>
                {!snapshot ? (
                  <div className="empty-state">
                    <Clock3 size={26} />
                    <h3>Connecting to the queue…</h3>
                  </div>
                ) : (
                  <JobTable
                    jobs={jobs}
                    selected={selected}
                    onSelect={setSelected}
                    now={snapshot.now}
                    emptyMessage={
                      view === 'dead'
                        ? 'No dead letters.'
                        : search || filter !== 'all'
                          ? 'No matching jobs.'
                          : 'Your queue is ready.'
                    }
                  />
                )}
                <div className="table-footer">
                  <span>
                    {snapshot?.truncated
                      ? 'Showing latest 500 jobs. Metrics include all jobs.'
                      : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} shown`}
                    <span className="footer-separator">·</span>Average completed attempt:{' '}
                    <strong>{duration(snapshot?.metrics.averageDurationMs ?? null)}</strong>
                  </span>
                  <span className="mono">FIFO / DUE TIME</span>
                </div>
              </section>
              <JobInspector
                key={detail?.id ?? 'empty'}
                job={detail}
                busy={busy}
                onAction={(id, action) => void mutate(`/jobs/${id}/${action}`)}
                onClose={() => setSelected(null)}
              />
            </div>
          )}
          <footer className="main-footer">
            <span>
              <Database size={13} />
              Your data stays in this local workspace.
            </span>
            <span>Built for the work behind the work.</span>
          </footer>
        </main>
      </div>
      {creating ? (
        <EnqueueDialog
          onClose={() => setCreating(false)}
          onCreated={(job) => {
            changeView('jobs');
            setSelected(job.id);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function Metric({
  title,
  value,
  suffix,
  subtitle,
  icon,
  accent = false,
}: {
  title: string;
  value: string;
  suffix?: string;
  subtitle: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`metric-card ${accent ? 'metric-accent' : ''}`}>
      <div className="metric-top">
        <span>{title}</span>
        {icon}
      </div>
      <div className="metric-value">
        {value}
        {suffix ? <small>{suffix}</small> : null}
      </div>
      <p>{subtitle}</p>
    </div>
  );
}
