import { useState } from 'react';
import { ProgressRing } from '../../../components/ProgressRing';
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  XIcon,
} from '../../../components/icons';
import { formatDuration, formatEta } from './labFormat';

export interface TrainSample {
  id: number;
  field: 'name' | 'number';
  truth: string;
  predicted: string;
  confidence: number;
  correct: boolean;
  crop: string | null;
  epoch: number;
}

export interface TrainingHistoryPoint {
  epoch: number;
  loss: number;
  devName: number | null;
  devNumber: number | null;
  minutes: number;
}

/** What OCR Lab reads from `ocr:train` while the trainer runs (see the API). */
export interface TrainingRun {
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
  requested?: string;
  dataset?: string;
  lines?: number;
  epochs?: number;
  epoch?: number;
  loss?: number;
  devName?: number | null;
  devNumber?: number | null;
  minutes?: number;
  synthetic?: number;
  modelId?: string;
  python?: string;
  error?: string;
  log?: string[];
  step?: number;
  steps?: number;
  batch?: number;
  batches?: number;
  etaSeconds?: number | null;
  secondsPerEpoch?: number | null;
  bestEpoch?: number;
  bestName?: number | null;
  bestNumber?: number | null;
  history?: TrainingHistoryPoint[];
  recent?: TrainSample[];
  startedAt?: string;
  finishedAt?: string;
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const cropUrl = (path: string) => `/api/dev/ocr/training/crop?path=${encodeURIComponent(path)}`;

/**
 * "Training", while it is happening: how far along, how long it has been, how
 * long it has left, and what it makes of the lines it is *not* trained on.
 *
 * The held-out check is the honest signal: every epoch the trainer re-reads a
 * slice of lines picked out by card, never trained on. A line it now reads
 * correctly, and with what confidence, is shown with its crop — the closest
 * thing to "is it learning the right thing" before the frozen exam.
 */
export function TrainingPanel({
  t,
  busy,
  onStop,
}: {
  t: TrainingRun | null | undefined;
  busy: boolean;
  onStop: () => void;
}) {
  if (!t) return null;
  const active = ['queued', 'starting', 'running'].includes(t.status);
  const history = t.history ?? [];
  const recent = t.recent ?? [];
  const steps = t.steps ?? 0;
  const step = t.step ?? 0;
  const progress = t.status === 'done' ? 100 : steps ? Math.min(99, Math.round((step / steps) * 100)) : 0;
  const runtime = t.startedAt ? new Date(t.finishedAt ?? Date.now()).getTime() - new Date(t.startedAt).getTime() : null;
  const right = recent.filter((s) => s.correct).length;
  // the checkpoint the trainer keeps: the epoch with the best mean held-out accuracy
  const epochScore = (h: TrainingHistoryPoint) => {
    const vals = [h.devName, h.devNumber].filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const best = [...history].sort((a, b) => epochScore(b) - epochScore(a))[0];

  return (
    <section className={`ocr-trainlive ${t.status}`} aria-label="Training a line reader">
      <div className="ocr-trainlive-head">
        <ProgressRing
          value={active ? progress : t.status === 'done' ? 100 : 0}
          size={54}
          stroke={4}
          color={t.status === 'failed' ? 'var(--bad)' : t.status === 'cancelled' ? 'var(--warn)' : 'var(--accent)'}
          colorTo={t.status === 'running' ? 'var(--accent-2)' : undefined}
          idle={!active}
        >
          {t.status === 'running' ? (
            <strong style={{ fontSize: 13 }}>{progress}%</strong>
          ) : t.status === 'done' ? (
            <CheckIcon size={18} />
          ) : t.status === 'failed' ? (
            <AlertIcon size={18} />
          ) : t.status === 'cancelled' ? (
            <StopIcon size={18} />
          ) : (
            <ClockIcon size={18} />
          )}
        </ProgressRing>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <strong>{t.status === 'done' ? 'Training finished' : t.status === 'failed' ? 'Training failed' : t.status === 'cancelled' ? 'Training stopped' : t.status === 'queued' ? 'Waiting for the worker' : 'Training a line reader'}</strong>
            {t.dataset && <span className="badge">{t.dataset}</span>}
            {t.lines != null && <span className="badge">{t.lines.toLocaleString()} lines</span>}
            {t.epochs != null && <span className="badge">{t.epochs} epochs</span>}
            {t.synthetic ? <span className="badge">{t.synthetic.toLocaleString()} synthetic/epoch</span> : null}
          </div>
          <div className="faint ocr-trainlive-line">
            {t.status === 'running' && (
              <>
                Epoch {t.epoch ?? 0} of {t.epochs ?? '?'}
                {t.loss != null ? ` · loss ${t.loss.toFixed(3)}` : ''}
                {t.secondsPerEpoch ? ` · ~${formatDuration(t.secondsPerEpoch * 1000)} per epoch` : ''}
              </>
            )}
            {t.status === 'queued' && 'Queued — it starts as soon as the worker is free.'}
            {t.status === 'done' && <>Wrote <code>{t.modelId}</code>{t.minutes ? ` in ${t.minutes} min` : ''} · held out: names {pct(t.devName ?? t.bestName)}, numbers {pct(t.devNumber ?? t.bestNumber)}</>}
            {t.status === 'cancelled' && 'Stopped on request; nothing was written.'}
            {t.status === 'failed' && <span style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>{t.error}</span>}
          </div>
        </div>
        {active && (
          <button className="btn sm ghost" onClick={onStop} disabled={!busy} title="Stop after the current step">
            <StopIcon size={14} /> Stop
          </button>
        )}
      </div>

      {active && (
        <>
          <div className="ocr-trainlive-times">
            <div>
              <span className="faint">Elapsed</span>
              <strong>{formatDuration(runtime)}</strong>
            </div>
            <div>
              <span className="faint">Time until finished</span>
              <strong>{t.etaSeconds != null ? formatEta(t.etaSeconds) : t.status === 'running' ? 'estimating after the first epoch…' : '—'}</strong>
            </div>
            <div>
              <span className="faint">Steps</span>
              <strong>{steps ? `${step.toLocaleString()} / ${steps.toLocaleString()}` : '—'}</strong>
            </div>
            <div>
              <span className="faint">Best epoch so far</span>
              <strong>{t.bestEpoch ? `#${t.bestEpoch} · ${pct(t.bestName ?? t.bestNumber)}` : '—'}</strong>
            </div>
          </div>
          <div className="progress ocr-trainlive-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${progress}%` }} />
          </div>
        </>
      )}

      {(history.length > 0 || recent.length > 0) && (
        <div className="ocr-trainlive-grid">
          <div>
            <div className="ocr-subhead">
              <span>Held-out accuracy</span>
              <span className="faint">never trained on · {history.length} epoch{history.length === 1 ? '' : 's'}</span>
            </div>
            <AccuracyChart history={history} bestEpoch={t.bestEpoch} />
            <div className="ocr-chart-legend faint">
              <span><i className="lg-name" /> names</span>
              <span><i className="lg-number" /> numbers</span>
              <span><i className="lg-best" /> best epoch</span>
            </div>
            {best && (
              <div className="faint" style={{ fontSize: 12 }}>
                Best: epoch {t.bestEpoch ?? best.epoch} — names {pct(best.devName)}, numbers {pct(best.devNumber)}. That checkpoint is what gets written.
              </div>
            )}
          </div>

          <div>
            <div className="ocr-subhead">
              <span>Recent held-out lines</span>
              <span className="faint">
                {recent.length ? `${right} of ${recent.length} right · epoch ${Math.max(...recent.map((s) => s.epoch))}` : 'waiting for the first epoch'}
              </span>
            </div>
            <div className="ocr-vision">
              {recent.map((s) => (
                <SampleCard key={`${s.id}-${s.epoch}`} s={s} />
              ))}
              {!recent.length && (
                <div className="ocr-vision-empty faint">
                  After the first epoch, the lines it did not train on appear here with what it read, whether that was right, and how sure it was.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {t.log?.length ? <TrainingLog log={t.log} /> : null}
    </section>
  );
}

/** One held-out line: the crop, the verdict, the reading and its confidence. */
function SampleCard({ s }: { s: TrainSample }) {
  const [broken, setBroken] = useState(false);
  const confidence = Math.round(s.confidence * 100);
  return (
    <figure className={`ocr-vision-card ${s.correct ? 'ok' : 'no'}`} title={`${s.field === 'name' ? 'Title' : 'Number'} line · epoch ${s.epoch}`}>
      <div className="ocr-vision-img">
        {s.crop && !broken ? (
          <img src={cropUrl(s.crop)} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="faint" style={{ fontSize: 11 }}>no crop</span>
        )}
        <span className="ocr-vision-badge" aria-label={s.correct ? 'read correctly' : 'misread'}>
          {s.correct ? <CheckIcon size={12} /> : <XIcon size={12} />}
        </span>
      </div>
      <figcaption>
        <div className="ocr-vision-read" title="what the model read">
          {s.correct ? s.predicted || '—' : s.predicted ? <s>{s.predicted}</s> : <em>nothing</em>}
        </div>
        <div className="ocr-vision-truth faint" title="what the line really says">→ {s.truth}</div>
        <div className="ocr-vision-conf">
          <div className="progress" style={{ height: 4 }}>
            <div style={{ width: `${confidence}%`, background: s.correct ? 'var(--good)' : 'var(--bad)' }} />
          </div>
          <span title="how sure the model was of what it read">{confidence}% sure</span>
        </div>
      </figcaption>
    </figure>
  );
}

/**
 * Held-out accuracy per epoch. A hand-drawn SVG line chart: two series, a
 * marker on the best epoch, and no dependency (the lab must work offline).
 */
export function AccuracyChart({ history, bestEpoch }: { history: TrainingHistoryPoint[]; bestEpoch?: number }) {
  if (history.length < 2) {
    return (
      <div className="ocr-chart-empty faint">
        {history.length === 1 ? `Epoch 1: names ${pct(history[0]!.devName)}, numbers ${pct(history[0]!.devNumber)}. The chart fills in as epochs finish.` : 'No epochs finished yet.'}
      </div>
    );
  }
  const W = 260;
  const H = 96;
  const pad = { left: 4, right: 6, top: 8, bottom: 14 };
  const n = history.length;
  const x = (i: number) => pad.left + (i / Math.max(1, n - 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * (H - pad.top - pad.bottom);
  const line = (pick: (h: TrainingHistoryPoint) => number | null) => {
    const pts = history.map((h, i) => ({ i, v: pick(h) })).filter((p): p is { i: number; v: number } => p.v != null);
    if (!pts.length) return '';
    // a moving average of two smooths the first few epochs, which jump wildly
    return pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  };
  const lastPoint = (pick: (h: TrainingHistoryPoint) => number | null) => {
    for (let i = history.length - 1; i >= 0; i--) {
      const v = pick(history[i]!);
      if (v != null) return { x: x(i), y: y(v), v };
    }
    return null;
  };
  const bestIdx = bestEpoch ? history.findIndex((h) => h.epoch === bestEpoch) : -1;
  const nameEnd = lastPoint((h) => h.devName);
  const numberEnd = lastPoint((h) => h.devNumber);
  return (
    <svg className="ocr-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Held-out accuracy per epoch">
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={pad.left} x2={W - pad.right} y1={y(g)} y2={y(g)} className="ocr-chart-grid" />
      ))}
      <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} className="ocr-chart-axis" />
      {bestIdx >= 0 && <line x1={x(bestIdx)} x2={x(bestIdx)} y1={pad.top} y2={H - pad.bottom} className="ocr-chart-bestline" />}
      <path d={line((h) => h.devName)} className="ocr-chart-name" />
      <path d={line((h) => h.devNumber)} className="ocr-chart-number" />
      {nameEnd && <circle cx={nameEnd.x} cy={nameEnd.y} r={2.4} className="ocr-chart-name-dot" />}
      {numberEnd && <circle cx={numberEnd.x} cy={numberEnd.y} r={2.4} className="ocr-chart-number-dot" />}
      <text x={pad.left} y={H - 3} className="ocr-chart-label">epoch 1</text>
      <text x={W - pad.right} y={H - 3} className="ocr-chart-label" textAnchor="end">epoch {history.at(-1)!.epoch}</text>
      <text x={pad.left + 2} y={y(1) + 3} className="ocr-chart-label">100%</text>
    </svg>
  );
}

function TrainingLog({ log }: { log: string[] }) {
  const [open, setOpen] = useState(false);
  const tail = open ? log.slice(-60) : log.slice(-4);
  return (
    <div className="ocr-trainlive-log">
      <button className="btn sm ghost" style={{ padding: '2px 6px', fontSize: 12 }} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon size={12} dir={open ? 'up' : 'down'} /> {open ? 'Hide the trainer log' : 'Show the trainer log'}
      </button>
      <pre className="ocr-log">{tail.join('\n')}</pre>
    </div>
  );
}
