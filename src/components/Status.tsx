import type { JobStatus } from '../types';
import { statusLabels } from '../types';

export function Status({ status }: { status: JobStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}
