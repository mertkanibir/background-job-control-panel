import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Box,
  CircleCheck,
  Clock3,
  Cpu,
  Database,
  Layers3,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  ShieldAlert,
  Workflow,
  X,
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
  const title = view === 'dead' ? 'Dead letters' : view === 'activity' ? 'Activity' : 'Job queue';
  const running = counts?.running ?? 0;
  const capacity = snapshot?.settings.concurrency ?? 3;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Relay home">
          <span className="brand-mark">
            <Workflow size={27} strokeWidth={1.8} />
          </span>
          <span>Relay</span>
        </a>
        <span className="sidebar-label">OPERATIONS</span>
        <nav aria-label="Main navigation">
          <button
            onClick={() => changeView('jobs')}
            className={view === 'jobs' ? 'nav-active' : ''}
            aria-current={view === 'jobs' ? 'page' : undefined}
          >
            <Layers3 size={19} />
            Job queue<span className="nav-count">{snapshot?.metrics.total ?? 0}</span>
          </button>
          <button
            onClick={() => changeView('dead')}
            className={view === 'dead' ? 'nav-active' : ''}
            aria-current={view === 'dead' ? 'page' : undefined}
          >
            <ShieldAlert size={19} />
            Dead letters
            {counts?.dead ? <span className="nav-count nav-alert">{counts.dead}</span> : null}
          </button>
          <button
            onClick={() => changeView('activity')}
            className={view === 'activity' ? 'nav-active' : ''}
            aria-current={view === 'activity' ? 'page' : undefined}
          >
            <Activity size={19} />
            Activity
          </button>
        </nav>
        <div className="sidebar-engine">
          <Database size={18} />
          <div>
            <strong>SQLite</strong>
            <span>WAL persistence</span>
          </div>
          <span className="green-dot" />
        </div>
        <div className="sidebar-footer">
          <span>Local instance</span>
          <span className="mono">v1.0.0</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            Operations<span>/</span>
            <strong>{title}</strong>
          </span>
          <div className="connection">
            <span className={connected ? 'green-dot' : 'offline-dot'} />
            {connected ? 'Live updates' : 'Reconnecting…'}
            <Radio size={14} />
          </div>
        </header>
        <main>
          <div className="view-content" key={view}>
            <div className="page-heading">
              <div>
                <span className="eyebrow">EXECUTION CONTROL</span>
                <h1>{title}</h1>
                <p>
                  {view === 'dead'
                    ? 'Inspect failed work and recover exhausted attempts.'
                    : view === 'activity'
                      ? 'A live record of queue transitions and worker results.'
                      : 'Monitor execution, inspect results and control your queue.'}
                </p>
              </div>
              <div className="heading-actions">
                <button className="button subtle" onClick={() => void runDemo()} disabled={busy}>
                  <Play size={14} />
                  Run demo batch
                </button>
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={17} />
                  Enqueue job
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </div>
            {error ? (
              <div className="page-error" role="alert">
                <ShieldAlert size={16} />
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
                label="Total jobs"
                value={snapshot?.metrics.total ?? '—'}
                icon={<Box size={18} />}
                detail={`${counts?.completed ?? 0} completed · ${counts?.dead ?? 0} dead letters`}
              />
              <Metric
                label="Running jobs"
                value={running}
                suffix={`/ ${capacity}`}
                icon={<Cpu size={18} />}
                detail={`${counts ? counts.queued + counts.retrying : 0} waiting for execution`}
                accent
              />
              <Metric
                label="Success rate"
                value={
                  snapshot?.metrics.successRate == null
                    ? '—'
                    : `${snapshot.metrics.successRate.toFixed(0)}%`
                }
                icon={<CircleCheck size={18} />}
                detail="Completed / completed + dead"
                title="Completed / (completed + dead letters)"
              />
              <Metric
                label="Retry attempts"
                value={snapshot?.metrics.retries ?? '—'}
                icon={<RotateCcw size={18} />}
                detail={`${snapshot?.metrics.failedAttempts ?? 0} failed attempts recorded`}
              />
            </section>
            <section className="runtime-panel" aria-label="Queue controls">
              <div className="runtime-heading">
                <span className="runtime-icon">
                  <Cpu size={19} />
                </span>
                <div>
                  <h2>Worker capacity</h2>
                  <span>
                    {snapshot?.settings.paused
                      ? 'New claims paused · running work continues'
                      : 'One isolated worker per active attempt'}
                  </span>
                </div>
              </div>
              <div
                className="capacity-slots"
                aria-label={`${running} running jobs across ${capacity} configured capacity slots`}
                title="Logical concurrency slots; worker threads are created per attempt."
              >
                {Array.from({ length: Math.max(capacity, running) }, (_, index) => (
                  <span
                    key={index}
                    className={`capacity-slot ${index < running ? 'slot-running' : 'slot-idle'} ${index >= capacity ? 'slot-draining' : ''}`}
                    data-state={index < running ? 'running' : 'idle'}
                    aria-label={`Capacity slot ${index + 1}: ${index < running ? (index >= capacity ? 'draining' : 'active') : 'available'}`}
                  >
                    <span className="slot-light" />
                    <span className="mono">{String(index + 1).padStart(2, '0')}</span>
                  </span>
                ))}
              </div>
              <div className="runtime-controls">
                <label>
                  Concurrency
                  <select
                    aria-label="Worker concurrency"
                    value={capacity}
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
                <button
                  className="button subtle"
                  disabled={busy || !snapshot}
                  onClick={() => void mutate('/settings', { paused: !snapshot?.settings.paused })}
                >
                  {snapshot?.settings.paused ? <Play size={14} /> : <Pause size={14} />}
                  {snapshot?.settings.paused ? 'Resume queue' : 'Pause queue'}
                </button>
              </div>
            </section>
            {view === 'activity' ? (
              <section className="activity-card" aria-label="Recent activity">
                <div className="section-heading">
                  <div>
                    <Activity size={18} />
                    <h2>Recent activity</h2>
                  </div>
                  <span>Last 8 persisted events</span>
                </div>
                {snapshot?.recent.length ? (
                  snapshot.recent.map((event) => (
                    <button
                      className={`activity-entry event-${event.kind}`}
                      key={event.id}
                      onClick={() => {
                        changeView('jobs');
                        setSelected(event.job_id);
                      }}
                    >
                      <span className="activity-indicator">
                        <Activity size={17} />
                      </span>
                      <span className="event-content">
                        <strong>{event.name}</strong>
                        <small>{event.message}</small>
                      </span>
                      <span className="event-kind">{event.kind.replaceAll('_', ' ')}</span>
                      <time className="mono">{time(event.at)}</time>
                      <ArrowUpRight size={16} />
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <Activity size={26} />
                    <h3>No activity</h3>
                    <p>Enqueue a job to create an event history.</p>
                  </div>
                )}
              </section>
            ) : (
              <div className="work-grid">
                <section className="queue-card" aria-label="Job queue">
                  <div className="section-heading">
                    <div>
                      <Layers3 size={18} />
                      <h2>{view === 'dead' ? 'Dead-letter queue' : 'Execution queue'}</h2>
                      <span className="count-badge">{jobs.length}</span>
                    </div>
                    <span className="section-meta">
                      {snapshot?.settings.paused ? (
                        <>
                          <span className="paused-indicator" />
                          Paused
                        </>
                      ) : (
                        <>
                          <span className="green-dot" />
                          Accepting jobs
                        </>
                      )}
                    </span>
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
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">
                        {counts?.dead ?? 0} jobs with exhausted retry budgets
                      </span>
                    )}
                    <div className="search-field">
                      <Search size={14} />
                      <input
                        aria-label="Search jobs"
                        placeholder="Search jobs"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                  </div>
                  {!snapshot ? (
                    <div className="empty-state">
                      <Clock3 size={26} />
                      <h3>Connecting…</h3>
                    </div>
                  ) : (
                    <JobTable
                      jobs={jobs}
                      selected={selected}
                      onSelect={setSelected}
                      now={snapshot.now}
                      emptyMessage={
                        view === 'dead'
                          ? 'No dead letters'
                          : search || filter !== 'all'
                            ? 'No matching jobs'
                            : 'No jobs'
                      }
                    />
                  )}
                  <div className="table-footer">
                    <span>
                      {snapshot?.truncated
                        ? 'Latest 500 jobs; metrics include all jobs.'
                        : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} shown`}
                    </span>
                    <span>
                      Mean duration{' '}
                      <strong className="mono">
                        {duration(snapshot?.metrics.averageDurationMs ?? null)}
                      </strong>
                    </span>
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
                State and results persist locally
              </span>
              <span className="mono">ATOMIC CLAIMS / DURABLE HISTORY</span>
            </footer>
          </div>
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
  label,
  value,
  suffix,
  icon,
  detail,
  title,
  accent = false,
}: {
  label: string;
  value: number | string;
  suffix?: string;
  icon: React.ReactNode;
  detail: string;
  title?: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric-card ${accent ? 'metric-accent' : ''}`} title={title}>
      <div className="metric-label">
        <span>{label}</span>
        {icon}
      </div>
      <div className="metric-value">
        <span className="count-change" key={String(value)}>
          {value}
        </span>
        {suffix ? <small>{suffix}</small> : null}
      </div>
      <p>{detail}</p>
    </div>
  );
}
