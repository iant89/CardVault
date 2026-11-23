import { useState } from 'react';
import { api } from '../../../services/api';
import { toast } from '../../../stores/toasts';
import { AlertIcon, CheckIcon, TerminalIcon } from '../../../components/icons';
import { ProgressRing } from '../../../components/ProgressRing';

export interface TrainerPython {
  status: 'unknown' | 'missing' | 'ready' | 'installing' | 'failed';
  python?: string;
  error?: string;
  step?: number;
  steps: string[];
  venv: string;
  configured: boolean;
  manual: string;
  setupScript: string | null;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
}

/**
 * The interpreter the trainer runs on. One press installs a venv with CPU
 * PyTorch and the trainer's packages (scripts/ocr-python.sh, run by the
 * worker); a healthy one shows its path instead. The environment lives under
 * storage, so (in Docker, where it sits on the storage volume) it survives
 * image updates.
 */
export function TrainerPythonPanel({
  py,
  busy,
  trainActive,
  act,
}: {
  py: TrainerPython;
  busy: boolean;
  trainActive: boolean;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const installing = py.status === 'installing';
  const ready = py.status === 'ready';
  const missing = py.status === 'missing' || py.status === 'failed';
  const [showLog, setShowLog] = useState(false);
  const total = py.steps.length || 3;
  const step = py.step ?? 0;
  return (
    <div className={`ocr-python ${py.status}`}>
      <div className="row between wrap" style={{ width: '100%', gap: 8 }}>
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <span className={`ocr-python-mark ${py.status}`} aria-hidden="true">
            {ready ? <CheckIcon size={14} /> : missing ? <AlertIcon size={14} /> : installing ? <ProgressRing value={(step / total) * 100} size={20} stroke={2.5} /> : <TerminalIcon size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 13 }}>Trainer Python</strong>
            <div className="faint" style={{ fontSize: 12 }}>
              {installing ? (
                `Installing${py.step ? `: ${py.steps[py.step - 1] ?? ''}` : '…'}`
              ) : ready ? (
                <>
                  <code>{py.python}</code>
                  {py.configured ? ' (set in OCR_TRAIN_PYTHON)' : ''}
                </>
              ) : missing ? (
                'Not installed — the trainer cannot start yet.'
              ) : (
                'Not checked yet. Training checks it, or set it up now.'
              )}
            </div>
          </div>
        </div>
        {installing ? (
          <span className="faint" style={{ fontSize: 12 }}>
            Step {step} / {total} · a few minutes, once…
          </span>
        ) : (
          <button
            className="btn sm"
            disabled={busy || trainActive}
            title={trainActive ? 'Stop training first' : 'Install (or check) the Python the trainer runs on'}
            onClick={() => void act(() => api.post('/api/dev/ocr/train/python', {}), ready ? 'Checking the trainer’s Python' : 'Setting up the trainer’s Python')}
          >
            {ready ? 'Check again' : 'Set up the OCR trainer'}
          </button>
        )}
      </div>
      {installing && (
        <ul className="ocr-python-steps">
          {py.steps.map((label, i) => {
            const state = i + 1 < step ? 'done' : i + 1 === step ? 'now' : 'next';
            return (
              <li key={label} className={state}>
                {state === 'done' ? '✓' : state === 'now' ? '•' : '·'} {label}
              </li>
            );
          })}
        </ul>
      )}
      {ready && py.finishedAt && <div className="faint" style={{ fontSize: 11 }}>Last checked {new Date(py.finishedAt).toLocaleString()}</div>}
      {missing && !py.error && (
        <div className="faint" style={{ fontSize: 11 }}>
          One-time download of a few hundred MB; it stays in <code>{py.venv}</code>.
        </div>
      )}
      {py.error && (
        <div style={{ fontSize: 12, color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>
          {py.error}
          {!py.configured && (
            <details style={{ marginTop: 4 }}>
              <summary className="faint" style={{ cursor: 'pointer' }}>Run it yourself over SSH</summary>
              <div className="ocr-cmd" style={{ marginTop: 4 }}>
                <code>{py.manual}</code>
                <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(py.manual).then(() => toast('Copied', 'success'))}>
                  Copy
                </button>
              </div>
              <div className="faint" style={{ marginTop: 4 }}>
                Needs internet access to PyPI. The environment goes in <code>{py.venv}</code>; the worker finds it by itself.
              </div>
            </details>
          )}
        </div>
      )}
      {py.log?.length ? (
        <div style={{ width: '100%' }}>
          <button className="btn sm ghost" style={{ padding: '2px 6px', fontSize: 12 }} onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide setup log' : 'Show setup log'}
          </button>
          {showLog && <pre className="ocr-log">{py.log.slice(-40).join('\n')}</pre>}
        </div>
      ) : null}
    </div>
  );
}
