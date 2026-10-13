import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, X, FileText, Table2, Fingerprint } from 'lucide-react';
import { request } from '../api';
import type { JobDetail, JobType } from '../types';
import { typeLabels } from '../types';

const examples: Record<JobType, string> = {
  'text-analysis':
    'Background work deserves clear control. Relay processes durable jobs, handles retries and keeps the entire history visible.',
  'csv-summary': 'product,region,revenue\nRelay,North,120\nBeacon,South,85\nRelay,West,240',
  'hash-chain': 'release-2026.10',
};
export function EnqueueDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (job: JobDetail) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<JobType>('text-analysis');
  const [name, setName] = useState('Text analysis');
  const [input, setInput] = useState(examples['text-analysis']);
  const [iterations, setIterations] = useState(750000);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [failFirst, setFailFirst] = useState(0);
  const [delay, setDelay] = useState(0);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const chooseType = (next: JobType) => {
    setType(next);
    setInput(examples[next]);
    setName(typeLabels[next]);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const field = type === 'text-analysis' ? 'text' : type === 'csv-summary' ? 'csv' : 'seed';
      const { job } = await request<{ job: JobDetail }>('/jobs', {
        type,
        name,
        input: { [field]: input, ...(type === 'hash-chain' ? { iterations } : {}) },
        maxAttempts,
        failFirst,
        delayMs: delay * 1000,
        ...(key.trim() ? { idempotencyKey: key.trim() } : {}),
      });
      onCreated(job);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="enqueue-dialog"
      onCancel={onClose}
      aria-labelledby="enqueue-title"
    >
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div>
            <span className="eyebrow">NEW TASK</span>
            <h2 id="enqueue-title">Put a worker to work.</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close new job dialog"
          >
            <X size={20} />
          </button>
        </div>
        <p className="dialog-description">
          Choose a real processor. Relay persists the input before a worker claims it.
        </p>
        <div className="processor-options" role="group" aria-label="Processor type">
          {(
            [
              ['text-analysis', FileText],
              ['csv-summary', Table2],
              ['hash-chain', Fingerprint],
            ] as const
          ).map(([value, Icon]) => (
            <button
              type="button"
              key={value}
              className={type === value ? 'chosen' : ''}
              aria-pressed={type === value}
              onClick={() => chooseType(value)}
            >
              <Icon size={19} />
              <span>{typeLabels[value]}</span>
            </button>
          ))}
        </div>
        <label>
          Job name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            autoFocus
          />
        </label>
        <label>
          {type === 'text-analysis'
            ? 'Text to analyze'
            : type === 'csv-summary'
              ? 'CSV payload'
              : 'Hash seed'}
          <textarea
            aria-label={
              type === 'text-analysis'
                ? 'Text to analyze'
                : type === 'csv-summary'
                  ? 'CSV payload'
                  : 'Hash seed'
            }
            className="mono"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={type === 'hash-chain' ? 2 : 5}
            maxLength={500000}
            required
            spellCheck={false}
          />
        </label>
        {type === 'hash-chain' ? (
          <label>
            SHA-256 iterations
            <input
              type="number"
              min={1000}
              max={2000000}
              step={1000}
              value={iterations}
              onChange={(event) => setIterations(Number(event.target.value))}
              required
            />
          </label>
        ) : null}
        <div className="form-grid">
          <label>
            Max attempts
            <select
              value={maxAttempts}
              onChange={(event) => setMaxAttempts(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Start after (seconds)
            <input
              type="number"
              min={0}
              max={86400}
              value={delay}
              onChange={(event) => setDelay(Number(event.target.value))}
              required
            />
          </label>
        </div>
        <details className="advanced">
          <summary>Failure injection & idempotency</summary>
          <p>
            Fail the first N attempts before running the processor. Retries use a 1-second
            exponential backoff.
          </p>
          <div className="form-grid">
            <label>
              Fail first N attempts
              <select
                value={failFirst}
                onChange={(event) => setFailFirst(Number(event.target.value))}
              >
                {[0, 1, 2, 3, 4, 5].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Idempotency key
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                maxLength={128}
                placeholder="Optional"
              />
            </label>
          </div>
        </details>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-footer">
          <span>
            <span className="green-dot" />
            Stored in local SQLite
          </span>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? 'Enqueuing…' : 'Enqueue job'}
            <ArrowUpRight size={16} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
