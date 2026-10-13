import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Clock3, Pause, Play, Plus, Search, ShieldAlert, X } from 'lucide-react';
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
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Relay home">
          Relay
        </a>
        <nav aria-label="Main navigation">
          <button
            onClick={() => changeView('jobs')}
            className={view === 'jobs' ? 'nav-active' : ''}
            aria-current={view === 'jobs' ? 'page' : undefined}
          >
            Job queue
          </button>
          <button
            onClick={() => changeView('dead')}
            className={view === 'dead' ? 'nav-active' : ''}
            aria-current={view === 'dead' ? 'page' : undefined}
          >
            Dead letters{counts?.dead ? <span className="nav-count">{counts.dead}</span> : null}
          </button>
          <button
            onClick={() => changeView('activity')}
            className={view === 'activity' ? 'nav-active' : ''}
            aria-current={view === 'activity' ? 'page' : undefined}
          >
            Activity
          </button>
        </nav>
        <div className="connection">
          <span className={connected ? 'green-dot' : 'offline-dot'} />
          {connected ? 'Live updates' : 'Reconnecting…'}
          <span className="local-label">Local</span>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <h1>{title}</h1>
          <span className="muted">SQLite / WAL</span>
        </div>
        {error ? (
          <div className="page-error" role="alert">
            <ShieldAlert size={16} />
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        ) : null}
        <section className="command-toolbar" aria-label="Queue controls">
          <span className="engine-status">
            <span className={snapshot?.settings.paused ? 'paused-indicator' : 'green-dot'} />
            {snapshot?.settings.paused ? 'Paused' : 'Accepting jobs'}
          </span>
          <label className="concurrency-control">
            Concurrency
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
          <button
            className="button subtle"
            disabled={busy || !snapshot}
            onClick={() => void mutate('/settings', { paused: !snapshot?.settings.paused })}
          >
            {snapshot?.settings.paused ? <Play size={14} /> : <Pause size={14} />}
            {snapshot?.settings.paused ? 'Resume queue' : 'Pause queue'}
          </button>
          <div className="command-actions">
            <button className="button subtle" onClick={() => void runDemo()} disabled={busy}>
              Run demo batch
            </button>
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              Enqueue job
            </button>
          </div>
        </section>
        <dl className="counter-strip" aria-label="Queue metrics">
          <Counter label="Total" value={snapshot?.metrics.total ?? '—'} />
          <Counter label="Running" value={counts?.running ?? '—'} />
          <Counter label="Waiting" value={counts ? counts.queued + counts.retrying : '—'} />
          <Counter label="Completed" value={counts?.completed ?? '—'} />
          <Counter label="Dead" value={counts?.dead ?? '—'} />
          <Counter label="Retries" value={snapshot?.metrics.retries ?? '—'} />
          <Counter
            label="Success"
            value={
              snapshot?.metrics.successRate == null
                ? '—'
                : `${snapshot.metrics.successRate.toFixed(0)}%`
            }
            title="Completed / (completed + dead letters)"
          />
          <Counter
            label="Mean duration"
            value={duration(snapshot?.metrics.averageDurationMs ?? null)}
          />
        </dl>
        {view === 'activity' ? (
          <section className="activity-card" aria-label="Recent activity">
            <div className="section-label">Last 8 events</div>
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
                  <span className="event-kind">{event.kind.replaceAll('_', ' ')}</span>
                  <span>
                    <strong>{event.name}</strong>
                    <small>{event.message}</small>
                  </span>
                  <time className="mono">{time(event.at)}</time>
                </button>
              ))
            ) : (
              <div className="empty-state">
                <Activity size={20} />
                <h3>No activity</h3>
                <p>Enqueue a job to create an event history.</p>
              </div>
            )}
          </section>
        ) : (
          <div className="work-grid">
            <section className="queue-card" aria-label="Job queue">
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
                    placeholder="Search name or ID"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              </div>
              {!snapshot ? (
                <div className="empty-state">
                  <Clock3 size={20} />
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
                    : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`}
                </span>
                <span>Claim order: due time, then creation</span>
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
      </main>
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

function Counter({
  label,
  value,
  title,
}: {
  label: string;
  value: number | string;
  title?: string;
}) {
  return (
    <div title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
