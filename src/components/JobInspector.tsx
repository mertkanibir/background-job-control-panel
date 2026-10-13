import { useState } from 'react';
import {
  Copy,
  FileJson2,
  RotateCcw,
  X,
  Clock3,
  CircleCheck,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import type { JobDetail } from '../types';
import { duration, time, typeLabels } from '../types';
import { Status } from './Status';
import { TypeIcon } from './JobTable';

export function JobInspector({
  job,
  busy,
  onAction,
  onClose,
}: {
  job: JobDetail | null;
  busy: boolean;
  onAction: (id: string, action: 'cancel' | 'retry') => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('output');
  const [copied, setCopied] = useState(false);
  if (!job)
    return (
      <aside className="inspector inspector-empty">
        <span className="empty-icon">
          <FileJson2 size={26} />
        </span>
        <h3>Job details</h3>
        <p>Select a job to inspect input, output and attempt history.</p>
      </aside>
    );
  const canCancel = ['queued', 'running', 'retrying'].includes(job.status);
  const canRetry = ['dead', 'cancelled'].includes(job.status);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(tab === 'input' ? job.input : job.output, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const navigateTabs = (event: React.KeyboardEvent) => {
    const values = ['output', 'input', 'timeline'];
    const index = values.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? values[(index + 1) % 3]
        : event.key === 'ArrowLeft'
          ? values[(index + 2) % 3]
          : event.key === 'Home'
            ? values[0]
            : event.key === 'End'
              ? values[2]
              : null;
    if (next) {
      event.preventDefault();
      setTab(next);
      setCopied(false);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };
  return (
    <aside className="inspector" aria-label="Job inspector">
      <div className="inspector-label">
        <span>
          <FileJson2 size={15} />
          Job details
        </span>
        <button className="icon-button" aria-label="Close job inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="inspector-title">
        <TypeIcon type={job.type} />
        <h3>{job.name}</h3>
      </div>
      <p className="job-id mono">{job.id}</p>
      <div className="inspector-status">
        <Status status={job.status} />
        <span>{typeLabels[job.type]}</span>
      </div>
      <div className="detail-grid">
        <div>
          <small>Attempt</small>
          <strong>
            {job.attempts} <span>/ {job.maxAttempts}</span>
          </strong>
        </div>
        <div>
          <small>Last duration</small>
          <strong>
            {duration(job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null)}
          </strong>
        </div>
        <div>
          <small>Created</small>
          <strong>{time(job.createdAt)}</strong>
        </div>
        <div>
          <small>Backoff base</small>
          <strong>{duration(job.backoffMs)}</strong>
        </div>
      </div>
      {job.status === 'running' ? (
        <div className="worker-progress">
          <div>
            <span>Worker processing</span>
            <strong>{job.progress}%</strong>
          </div>
          <progress max={100} value={job.progress} aria-label="Worker progress" />
        </div>
      ) : null}
      {job.error ? (
        <div className="job-error">
          <AlertTriangle size={15} />
          <span>{job.error}</span>
        </div>
      ) : null}
      {canCancel || canRetry ? (
        <div className="inspector-actions">
          {canCancel ? (
            <button
              className="button danger"
              disabled={busy}
              onClick={() => onAction(job.id, 'cancel')}
            >
              <X size={15} />
              Cancel job
            </button>
          ) : (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => onAction(job.id, 'retry')}
            >
              <RotateCcw size={15} />
              Retry job
            </button>
          )}
          <small>
            {canRetry
              ? 'Grants one extra attempt; history stays intact.'
              : 'Running workers are terminated on cancellation.'}
          </small>
        </div>
      ) : null}
      <div className="inspector-tabs" role="tablist" aria-label="Job information">
        {['output', 'input', 'timeline'].map((value) => (
          <button
            id={`tab-${value}`}
            key={value}
            role="tab"
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={navigateTabs}
            aria-selected={tab === value}
            aria-controls="inspector-panel"
            onClick={() => {
              setTab(value);
              setCopied(false);
            }}
            className={tab === value ? 'active' : ''}
          >
            {value === 'timeline' ? `Timeline (${job.events.length})` : value}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="inspector-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'timeline' ? (
          <div className="timeline">
            {job.events.map((event) => (
              <div className={`timeline-event event-${event.kind}`} key={event.id}>
                <span className="timeline-icon">
                  {event.kind === 'completed' ? <CircleCheck size={14} /> : <Clock3 size={14} />}
                </span>
                <div>
                  <strong>{event.kind.replaceAll('_', ' ')}</strong>
                  <time>{time(event.at)}</time>
                  <p>{event.message}</p>
                </div>
              </div>
            ))}
            <h4>Attempt ledger</h4>
            {job.history.map((attempt) => (
              <div className="attempt-row" key={attempt.number}>
                <span className="mono">#{attempt.number}</span>
                <span>{attempt.status}</span>
                <small>
                  {duration(attempt.finished_at ? attempt.finished_at - attempt.started_at : null)}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <div className="payload-panel">
            <div className="payload-label">
              <span>
                <FileJson2 size={13} />
                {tab}.json
              </span>
              <button
                className="icon-button"
                aria-label={`Copy ${tab} JSON`}
                onClick={copy}
                disabled={tab === 'output' && !job.output}
              >
                {copied ? <CircleCheck size={14} /> : <Copy size={14} />}
              </button>
            </div>
            {tab === 'input' || job.output ? (
              <pre>{JSON.stringify(tab === 'input' ? job.input : job.output, null, 2)}</pre>
            ) : (
              <div className="no-output">
                <ChevronRight size={16} />
                <p>
                  {job.status === 'dead'
                    ? 'The retry budget is exhausted. Retry this job to grant another attempt.'
                    : job.status === 'cancelled'
                      ? 'This job was cancelled before a result was saved.'
                      : 'Output will appear here when the worker completes.'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
