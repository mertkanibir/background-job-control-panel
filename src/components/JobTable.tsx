import { ArrowUpRight, FileText, Fingerprint, Table2 } from 'lucide-react';
import type { Job, JobType } from '../types';
import { duration, time, typeLabels } from '../types';
import { Status } from './Status';

const icons = { 'text-analysis': FileText, 'csv-summary': Table2, 'hash-chain': Fingerprint };
export function TypeIcon({ type }: { type: JobType }) {
  const Icon = icons[type];
  return (
    <span className={`type-icon type-${type}`}>
      <Icon size={17} />
    </span>
  );
}

export function JobTable({
  jobs,
  selected,
  onSelect,
  now,
  emptyMessage,
}: {
  jobs: Job[];
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
  emptyMessage: string;
}) {
  if (!jobs.length)
    return (
      <div className="empty-state">
        <span className="empty-mark">
          <Table2 size={26} />
        </span>
        <h3>{emptyMessage}</h3>
        <p>Enqueue a task, or run the demo batch to see actual workers in action.</p>
      </div>
    );
  return (
    <div className="table-scroll">
      <table className="job-table">
        <thead>
          <tr>
            <th scope="col">Job / processor</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Duration</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className={selected === job.id ? 'selected' : ''}>
              <td>
                <button
                  className="job-select"
                  onClick={() => onSelect(job.id)}
                  aria-label={`Inspect ${job.name}`}
                  aria-pressed={selected === job.id}
                >
                  <TypeIcon type={job.type} />
                  <span>
                    <strong>{job.name}</strong>
                    <small>
                      {typeLabels[job.type]} <span>· {job.id.slice(0, 8)}</span>
                    </small>
                  </span>
                  <ArrowUpRight className="row-arrow" size={15} />
                </button>
              </td>
              <td>
                <Status status={job.status} />
                {job.status === 'running' ? (
                  <div className="progress">
                    <span style={{ width: `${job.progress}%` }} />
                    <small>{job.progress}%</small>
                  </div>
                ) : job.status === 'retrying' ||
                  (job.status === 'queued' && job.availableAt > now) ? (
                  <small className="due">Due {time(job.availableAt)}</small>
                ) : null}
              </td>
              <td>
                <span className="mono">
                  {job.attempts}
                  <span className="muted"> / {job.maxAttempts}</span>
                </span>
              </td>
              <td className="mono">
                {duration(job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null)}
              </td>
              <td className="mono muted">{time(job.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
