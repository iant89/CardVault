import { useCallback, useEffect, useState } from 'react';
import type { LabQueue, LabTask } from '@cardvault/shared';
import { api, ApiError } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Dialog, Loading, Empty } from '../../components/ui';
import { toast } from '../../stores/toasts';
import { queueSummaryText } from './ocr/labFormat';
import {
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  DownloadIcon,
  ImportIcon,
  LayersIcon,
  PlayIcon,
  PulseIcon,
  RefreshIcon,
  ScanIcon,
  ShieldIcon,
  SparkIcon,
  TargetIcon,
  XIcon,
} from '../../components/icons';
import { QueuePanel } from './ocr/QueuePanel';
import { TrainingPanel, type TrainingRun } from './ocr/TrainingPanel';
import { TrainerPythonPanel, type TrainerPython } from './ocr/TrainerPythonPanel';

/* ------------------------------------------------------------------ types */

export interface Slice {
  slice: string;
  n: number;
  accuracy: number;
  accuracyWithDictionary?: number;
  cer: number;
  confidentAccuracy: number | null;
  confident: number;
  calibrationError: number;
}
export interface Summary {
  engine?: string;
  examVersion?: number;
  units?: number;
  exam?: number;
  missingCrops?: number;
  name?: Slice | null;
  number?: Slice | null;
  regression?: { name: Slice | null; number: Slice | null };
  msPerLine?: number | null;
  durationMs?: number;
  comparedTo?: { engine: string; name: Slice | null; number: Slice | null } | null;
}
export interface Evaluation {
  id: string;
  engine: string;
  examVersion: number | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: { done: number; total: number };
  summary: Summary;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  slices?: Slice[];
  misses?: { field: string; game: string; source: string; regression: boolean; predicted: string; raw: string; label: string; samples: string[] }[];
}
interface Gate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}
interface Trial {
  lines: number;
  liveAccuracy: number | null;
  shadowAccuracy: number | null;
  wins: number;
  losses: number;
  updatedAt?: string;
}
interface WatchSide {
  lines: number;
  correct: number;
  scans: number;
  reviewed: number;
}
interface Watch {
  after: WatchSide;
  before: WatchSide;
  previousEngine: string;
  rules: { minLines: number; minScans: number; maxAccuracyDrop: number; maxReviewRise: number };
  judged: string[];
  reasons: string[];
  updatedAt: string;
}
interface Model {
  id: string;
  status: 'candidate' | 'shadow' | 'active' | 'retired';
  trial: Trial | null;
  trialStartedAt: string | null;
  watch: Watch | null;
  previousEngine: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  activatedAt: string | null;
  dataset: { id: string; rows: number } | null;
  training: { epochs: number; minutes: number; parameters: number; synthetic: number } | null;
  dev: Record<string, { n: number; accuracy: number | null }> | null;
  evaluation: { id: string; examVersion: number; summary: Summary } | null;
  gates: Gate[];
  canPromote: boolean;
}
interface Models {
  examVersion: number | null;
  champion: { engine: string; evaluationId: string | null } | null;
  trialMinLines: number;
  models: Model[];
  events: { action: string; entityId: string; metadata: Record<string, unknown>; createdAt: string }[];
}
interface DatasetInfo {
  id: string;
  rows: number;
  counts: Record<string, number>;
  createdAt: string | null;
}
export interface Overview {
  counts: { source: string; field: string; split: string; n: number }[];
  totals: { samples: number; regression: number; cards: number; exam_groups: number; last7days: number };
  exam: { id: string; version: number; size: number; counts: Record<string, number>; note: string | null; createdAt: string } | null;
  newSinceExam: number;
  import: { status: string; done?: number; total?: number; added?: number; skipped?: number; error?: string; alreadyImported?: number } | null;
  dataset: { id: string; createdAt: string; rows: number; counts: Record<string, number>; dir: string; storage: string } | null;
  datasets: DatasetInfo[];
  training: TrainingRun | null;
  python: TrainerPython;
  evaluations: Evaluation[];
}
interface Sample {
  id: string;
  field: string;
  game: string;
  predicted: string;
  labelText: string | null;
  labelNorm: string | null;
  source: string;
  split: string | null;
  regression: boolean;
  era: string | null;
  engine: string;
}

/* ------------------------------------------------------------------ helpers */

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const ratioText = (a: number, b: number) => (b ? pct(a / b) : '—');
const crop = (id: string) => `/api/dev/ocr/samples/${id}/crop`;
const delta = (now?: number | null, before?: number | null) => {
  if (now == null || before == null) return null;
  const d = (now - before) * 100;
  if (Math.abs(d) < 0.05) return <span className="faint"> ±0</span>;
  return (
    <span style={{ color: d > 0 ? 'var(--good)' : 'var(--bad)' }}>
      {' '}
      {d > 0 ? '▲' : '▼'}
      {Math.abs(d).toFixed(1)}
    </span>
  );
};
const ago = (d: string | null | undefined) => {
  if (!d) return '';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(d).toLocaleDateString();
};

const EVENT_LABEL: Record<string, string> = {
  'ocr.promote': 'Promoted',
  'ocr.rollback': 'Rolled back by hand',
  'ocr.auto_rollback': 'Rolled back automatically',
  'ocr.trial_start': 'Live trial started',
};

const SOURCES: { id: string; label: string; hint: string }[] = [
  { id: 'review', label: 'Confirmed by a person', hint: 'Fixed or confirmed in Manual Review. The most valuable labels.' },
  { id: 'corroborated', label: 'Auto, corroborated', hint: 'Identified automatically, and evidence independent of this line agreed.' },
  { id: 'harvest', label: 'TCGdex harvest', hint: 'Official images made to look like captures. Correct labels, not real photos.' },
  { id: 'self', label: 'Auto, self-confirmed', hint: 'Identified mainly from this line itself. Never used to train or test.' },
  { id: 'pending', label: 'Waiting for a label', hint: 'The scan has not been identified yet.' },
  { id: 'excluded', label: 'Excluded', hint: 'Unusable, e.g. cut with another game’s layout.' },
];

type Tab = 'overview' | 'models' | 'training' | 'data';

const TABS: { id: Tab; label: string; icon: (p: { size?: number }) => ReturnType<typeof LayersIcon> }[] = [
  { id: 'overview', label: 'Overview', icon: LayersIcon },
  { id: 'models', label: 'Models', icon: TargetIcon },
  { id: 'training', label: 'Training', icon: SparkIcon },
  { id: 'data', label: 'Collected data', icon: ScanIcon },
];

/** What is running, in one sentence, for the page header. */
function headerStatus(q: LabQueue | null, failed: number): { text: string; dot: string } {
  if (!q || !q.tasks.length) return { text: 'Idle — nothing queued', dot: '' };
  const running = q.tasks.find((t) => t.state === 'running');
  if (running) return { text: `${running.name} · ${running.progress}%`, dot: 'good pulse' };
  if (q.counts.queued) return { text: `${q.counts.queued} task${q.counts.queued === 1 ? '' : 's'} waiting for the worker`, dot: 'warn' };
  if (failed) return { text: `${failed} task${failed === 1 ? '' : 's'} failed`, dot: 'bad' };
  return { text: 'Idle — nothing queued', dot: '' };
}

/* ------------------------------------------------------------------ page */

export default function OcrLabPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const ov = useAsync(() => api.get<Overview>('/api/dev/ocr'), []);
  const models = useAsync(() => api.get<Models>('/api/dev/ocr/models'), []);
  const queue = useAsync(() => api.get<LabQueue>('/api/dev/ocr/queue'), []);

  const q = queue.data;
  const fast = !!q?.counts.running || !!q?.counts.queued;
  // "busy" means the lab has work in flight — not that a poll is happening, so
  // buttons do not flicker disabled on every refresh
  const anyBusy = fast;

  const reloadAll = useCallback(() => {
    ov.reload();
    models.reload();
    queue.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      void queue.reload();
      void ov.reload();
      void models.reload();
    }, fast ? 2000 : 20000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fast]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, ok: string) => {
      try {
        await fn();
        toast(ok, 'success');
        // a queue action may finish an entry, so pull twice: at once, then after
        // the poll that would show it
        reloadAll();
        setTimeout(reloadAll, 900);
      } catch (e) {
        toast(e instanceof ApiError ? e.message : 'Failed', 'error');
      }
    },
    [reloadAll],
  );

  // queue controls
  const cancelTask = (t: LabTask) => void act(() => api.post(`/api/dev/ocr/queue/${encodeURIComponent(t.id)}/cancel`), `Stopping: ${t.name}`);
  const retryTask = (t: LabTask) => void act(() => api.post(`/api/dev/ocr/queue/${encodeURIComponent(t.id)}/retry`), `Queued again: ${t.name}`);
  const dismissTask = (t: LabTask) => void act(() => api.del(`/api/dev/ocr/queue/${encodeURIComponent(t.id)}`), 'Removed from the queue');
  const clearFinished = () => void act(() => api.post('/api/dev/ocr/queue/clear'), 'Cleared finished tasks');

  if (!ov.data) return <Loading label="Opening the lab…" />;
  const d = ov.data;
  const status = headerStatus(q, q?.counts.failed ?? 0);
  const trainActive = !!d.training && ['queued', 'starting', 'running'].includes(d.training.status);

  return (
    <div className="stack lg ocr-lab">
      {/* ---------- header: title, live status, and the queue (upper right) ---------- */}
      <header className="ocr-head">
        <div style={{ minWidth: 0 }}>
          <div className="ocr-eyebrow">
            <span className="ocr-chip">
              <ShieldIcon size={12} /> Admin · developer tools
            </span>
            <span className="faint">Local only · nothing leaves this server</span>
          </div>
          <h1>OCR Lab</h1>
          <p className="ocr-lede">
            The line reader behind every scan: the lines it learns from, the frozen exam it is judged on, and the scores that decide which model reads your cards.
          </p>
        </div>
        <div className="ocr-head-actions">
          <span className="ocr-status-line" title={queueSummaryText(q)}>
            <span className={`dot ${status.dot}`} /> {status.text}
          </span>
          <QueuePanel
            queue={q}
            onCancel={cancelTask}
            onRetry={retryTask}
            onDismiss={dismissTask}
            onClearFinished={clearFinished}
            onRefresh={() => void queue.reload()}
          />
        </div>
      </header>

      {/* ---------- KPI strip ---------- */}
      <KpiStrip d={d} m={models.data} />

      {/* ---------- tabs ---------- */}
      <div className="tabs ocr-tabs" role="tablist">
        {TABS.map((t) => {
          const Icon = t.icon;
          const badge = t.id === 'training' && trainActive ? 'live' : undefined;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              <Icon size={14} /> {t.label}
              {badge && <span className="ocr-tab-live">{badge}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && <OverviewTab d={d} m={models.data} act={act} onOpenModels={() => setTab('models')} busy={anyBusy} />}
      {tab === 'models' && <ModelsTab d={d} m={models.data} act={act} busy={anyBusy} trainActive={trainActive} onGoTraining={() => setTab('training')} />}
      {tab === 'training' && <TrainingTab d={d} act={act} busy={anyBusy} trainActive={trainActive} />}
      {tab === 'data' && <DataTab d={d} act={act} busy={anyBusy} />}
    </div>
  );
}

/* ------------------------------------------------------------------ KPI strip */

export function KpiStrip({ d, m }: { d: Overview; m: Models | null }) {
  const active = m?.models.find((x) => x.status === 'active');
  const shadow = m?.models.find((x) => x.status === 'shadow');
  const lastEval = d.evaluations.find((e) => e.status === 'done');
  return (
    <div className="ocr-kpis">
      <div className="ocr-kpi">
        <div className="ocr-kpi-top">
          <span>Lines collected</span>
          <LayersIcon size={14} />
        </div>
        <div className="ocr-kpi-value">{d.totals.samples.toLocaleString()}</div>
        <div className="ocr-kpi-sub">{d.totals.last7days.toLocaleString()} this week · {d.totals.cards.toLocaleString()} cards</div>
      </div>
      <div className="ocr-kpi">
        <div className="ocr-kpi-top">
          <span>Frozen exam</span>
          <TargetIcon size={14} />
        </div>
        <div className="ocr-kpi-value">{d.exam ? `v${d.exam.version}` : '—'}</div>
        <div className="ocr-kpi-sub">
          {d.exam ? `${d.exam.size.toLocaleString()} lines · ${d.newSinceExam.toLocaleString()} new since` : 'not frozen yet'}
        </div>
      </div>
      <div className="ocr-kpi">
        <div className="ocr-kpi-top">
          <span>Reading live scans</span>
          <PulseIcon size={14} />
        </div>
        <div className="ocr-kpi-value ocr-kpi-mono">{active ? active.id : 'Tesseract'}</div>
        <div className="ocr-kpi-sub">
          {shadow ? `on trial: ${shadow.id}` : active ? `names ${pct(active.evaluation?.summary.name?.accuracy)} on exam` : 'baseline engine'}
        </div>
      </div>
      <div className="ocr-kpi">
        <div className="ocr-kpi-top">
          <span>Last score</span>
          <CheckIcon size={14} />
        </div>
        <div className="ocr-kpi-value">
          {lastEval ? (
            <>
              {pct(lastEval.summary.name?.accuracy)} <span className="faint" style={{ fontSize: 13 }}>names</span>
            </>
          ) : (
            '—'
          )}
        </div>
        <div className="ocr-kpi-sub">
          {lastEval ? `${pct(lastEval.summary.number?.accuracy)} numbers · ${ago(lastEval.completedAt ?? lastEval.createdAt)}` : 'no scores yet'}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

export function OverviewTab({
  d,
  m,
  act,
  onOpenModels,
  busy,
}: {
  d: Overview;
  m: Models | null;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  onOpenModels: () => void;
  busy: boolean;
}) {
  const count = (source: string, field: string, split?: string) =>
    d.counts.filter((c) => c.source === source && c.field === field && (!split || c.split === split)).reduce((a, c) => a + c.n, 0);
  const active = m?.models.find((x) => x.status === 'active');
  return (
    <div className="stack lg">
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h3>
              <LayersIcon size={14} /> Where the labels come from
            </h3>
            <span className="faint" style={{ fontSize: 13 }}>train · exam</span>
          </div>
          <div className="table-wrap">
            <table className="table ocr-table">
              <thead>
                <tr>
                  <th>Label source</th>
                  <th>Names</th>
                  <th>Numbers</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.map((s) => (
                  <tr key={s.id} title={s.hint}>
                    <td>
                      <strong>{s.label}</strong>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {s.hint}
                      </div>
                    </td>
                    {(['name', 'number'] as const).map((f) => (
                      <td key={f} className="ocr-num">
                        {['review', 'corroborated', 'harvest'].includes(s.id)
                          ? `${count(s.id, f, 'train').toLocaleString()} · ${count(s.id, f, 'exam').toLocaleString()}`
                          : count(s.id, f).toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ocr-note">
            A line is only ever trained on or examined, never both: the split is fixed by the card, so a rescan cannot leak the exam into training.
          </p>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>
                <TargetIcon size={14} /> The exam
              </h3>
              {d.exam && (
                <span className="faint" style={{ fontSize: 13 }}>
                  v{d.exam.version} · {new Date(d.exam.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {d.exam ? (
              <>
                <p style={{ margin: '0 0 8px' }}>
                  <strong>{d.exam.size.toLocaleString()}</strong> lines, frozen. Every engine is scored on exactly these until a new version is frozen.
                </p>
                <div className="row wrap faint" style={{ gap: 10, fontSize: 12 }}>
                  {Object.entries(d.exam.counts).map(([k, v]) => (
                    <span key={k}>
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="faint" style={{ margin: 0 }}>
                No exam yet. Freeze one once there are labelled lines (scan and confirm cards, or import harvested cards).
              </p>
            )}
            <div className="row between" style={{ marginTop: 14 }}>
              <span className="faint" style={{ fontSize: 13 }}>
                {d.exam ? `${d.newSinceExam.toLocaleString()} new exam-side groups since v${d.exam.version}` : `${d.totals.exam_groups.toLocaleString()} groups available`}
              </span>
              <button className="btn sm" disabled={!d.totals.exam_groups || busy} onClick={() => void act(() => api.post('/api/dev/ocr/exams', {}), 'New exam version frozen')}>
                <TargetIcon size={13} /> Freeze exam v{(d.exam?.version ?? 0) + 1}
              </button>
            </div>
            <p className="ocr-note">Freeze a new version occasionally, not between comparing two engines: scores are only comparable on the same version.</p>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>
                <ImportIcon size={14} /> TCGdex harvest
              </h3>
            </div>
            <p className="faint" style={{ margin: '0 0 10px', fontSize: 13 }}>
              Turns cards downloaded with the TCGdex Harvester into labelled lines, made to look like captures. A separate slice in every score, so it never hides how real photos do.
            </p>
            {d.import && (
              <div style={{ marginBottom: 10, fontSize: 13 }}>
                {d.import.status === 'failed' ? (
                  <span style={{ color: 'var(--bad)' }}>{d.import.error}</span>
                ) : (
                  <>
                    <div className="row between">
                      <span>{d.import.status === 'done' ? 'Finished' : d.import.status === 'queued' ? 'Queued…' : 'Importing…'}</span>
                      <span className="faint">
                        {(d.import.done ?? 0).toLocaleString()} / {(d.import.total ?? 0).toLocaleString()} cards · {(d.import.added ?? 0).toLocaleString()} added
                        {d.import.skipped ? ` · ${d.import.skipped} skipped` : ''}
                      </span>
                    </div>
                    {d.import.total ? (
                      <div className="ocr-bar">
                        <i style={{ width: `${((d.import.done ?? 0) / d.import.total) * 100}%` }} />
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/import-harvest', { limit: 500 }), 'Importing 500 cards')}>
                Import 500
              </button>
              <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/import-harvest', {}), 'Importing all harvested cards')}>
                <ImportIcon size={13} /> Import all
              </button>
            </div>
          </div>
        </div>
      </div>

      <EvaluationsPanel d={d} act={act} busy={busy} onOpenModels={onOpenModels} />

      {active && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <PulseIcon size={14} /> Live watch · {active.id}
            </h3>
          </div>
          {active.watch ? <WatchView w={active.watch} /> : <p className="faint" style={{ margin: 0 }}>Starts with the next check (every 15 minutes).</p>}
        </div>
      )}
    </div>
  );
}

export function EvaluationsPanel({ d, act, busy, onOpenModels }: { d: Overview; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean; onOpenModels: () => void }) {
  const [detail, setDetail] = useState<Evaluation | null>(null);
  const open = async (id: string) => {
    try {
      setDetail(await api.get<Evaluation>(`/api/dev/ocr/evaluations/${id}`));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <TargetIcon size={14} /> Scores on the exam
        </h3>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={onOpenModels}>
            All models
          </button>
          <button className="btn sm primary" disabled={!d.exam || busy} onClick={() => void act(() => api.post('/api/dev/ocr/evaluations', {}), 'Scoring the current engine')}>
            <PlayIcon size={12} /> Score current engine
          </button>
        </div>
      </div>
      {d.evaluations.length ? (
        <div className="table-wrap">
          <table className="table ocr-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Engine</th>
                <th>Exam</th>
                <th>Names</th>
                <th>Names + dictionary</th>
                <th>Numbers</th>
                <th>Regression</th>
                <th>Speed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.evaluations.map((e) => {
                const s = e.summary;
                const prev = s.comparedTo;
                return (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</td>
                    <td>
                      <code>{s.engine ?? e.engine}</code>
                    </td>
                    <td>{e.examVersion ? `v${e.examVersion}` : '—'}</td>
                    {e.status === 'done' ? (
                      <>
                        <td className="ocr-num">
                          {pct(s.name?.accuracy)}
                          {delta(s.name?.accuracy, prev?.name?.accuracy)}
                          <div className="faint" style={{ fontSize: 12 }}>
                            CER {pct(s.name?.cer)} · n {s.name?.n ?? 0}
                          </div>
                        </td>
                        <td className="ocr-num">
                          {pct(s.name?.accuracyWithDictionary)}
                          {delta(s.name?.accuracyWithDictionary, prev?.name?.accuracyWithDictionary)}
                        </td>
                        <td className="ocr-num">
                          {pct(s.number?.accuracy)}
                          {delta(s.number?.accuracy, prev?.number?.accuracy)}
                          <div className="faint" style={{ fontSize: 12 }}>n {s.number?.n ?? 0}</div>
                        </td>
                        <td className="ocr-num">{s.regression?.name || s.regression?.number ? `${pct(s.regression?.name?.accuracy)} · ${pct(s.regression?.number?.accuracy)}` : <span className="faint">none yet</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{s.msPerLine ?? '—'} ms/line</td>
                        <td>
                          <button className="btn sm ghost" onClick={() => void open(e.id)}>
                            Details
                          </button>
                        </td>
                      </>
                    ) : e.status === 'failed' ? (
                      <td colSpan={6} style={{ color: 'var(--bad)' }}>{e.error}</td>
                    ) : (
                      <td colSpan={6}>
                        <div className="row" style={{ gap: 10 }}>
                          <span>{e.status === 'queued' ? 'Queued…' : `Reading ${e.progress.done.toLocaleString()} / ${e.progress.total.toLocaleString()}`}</span>
                          <div className="ocr-bar" style={{ flex: 1 }}>
                            <i style={{ width: `${e.progress.total ? (e.progress.done / e.progress.total) * 100 : 0}%` }} />
                          </div>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="◎" title="No scores yet">
          Freeze an exam, then score the current engine: that's the baseline every future engine has to beat.
        </Empty>
      )}
      <Dialog open={!!detail} onClose={() => setDetail(null)}>
        {detail && <EvaluationDetail detail={detail} />}
      </Dialog>
    </div>
  );
}

export function EvaluationDetail({ detail }: { detail: Evaluation }) {
  return (
    <div className="stack">
      <div>
        <h2 style={{ margin: 0 }}>Score details · exam v{detail.examVersion}</h2>
        <p className="faint" style={{ margin: 0 }}>
          {detail.summary.units?.toLocaleString()} items · {Math.round((detail.summary.durationMs ?? 0) / 1000)}s
          {detail.summary.missingCrops ? ` · ${detail.summary.missingCrops} crops missing on disk` : ''}
        </p>
      </div>
      <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
        <table className="table ocr-table">
          <thead>
            <tr>
              <th>Slice</th>
              <th>n</th>
              <th>Accuracy</th>
              <th>+ dictionary</th>
              <th>CER</th>
              <th>When ≥90% sure</th>
              <th>Calibration error</th>
            </tr>
          </thead>
          <tbody>
            {detail.slices?.map((s) => (
              <tr key={s.slice}>
                <td>{s.slice}</td>
                <td>{s.n}</td>
                <td>{pct(s.accuracy)}</td>
                <td>{pct(s.accuracyWithDictionary)}</td>
                <td>{pct(s.cer)}</td>
                <td>{s.confidentAccuracy == null ? '—' : `${pct(s.confidentAccuracy)} of ${s.confident}`}</td>
                <td>{pct(s.calibrationError)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: '6px 0 0' }}>Misreads</h3>
      <div className="ocr-samples" style={{ maxHeight: 360, overflow: 'auto' }}>
        {detail.misses?.map((m, i) => (
          <div key={i} className="ocr-sample">
            {m.samples.map((id) => (
              <img key={id} src={crop(id)} alt="" loading="lazy" />
            ))}
            <div className="ocr-sample-text">
              <span className="bad">{m.predicted || <em>nothing</em>}</span>
              <span className="faint">→ {m.label}</span>
            </div>
            <div className="ocr-sample-tags faint">
              {m.field} · {m.game} · {m.source}
              {m.regression ? ' · regression' : ''}
            </div>
          </div>
        ))}
        {!detail.misses?.length && <p className="faint">No misreads.</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ models */

export function ModelsTab({
  d,
  m,
  act,
  busy,
  trainActive,
  onGoTraining,
}: {
  d: Overview;
  m: Models | null;
  act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  busy: boolean;
  trainActive: boolean;
  onGoTraining: () => void;
}) {
  const [detail, setDetail] = useState<Evaluation | null>(null);
  const openDetail = async (id: string) => {
    try {
      setDetail(await api.get<Evaluation>(`/api/dev/ocr/evaluations/${id}`));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };
  const active = m?.models.find((x) => x.status === 'active');
  return (
    <div className="stack lg">
      <div className="panel">
        <div className="panel-head">
          <h3>
            <TargetIcon size={14} /> Models
          </h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="faint" style={{ fontSize: 13 }}>
              Reading scans now: <strong style={{ color: 'var(--text)' }}>{active ? active.id : 'Tesseract'}</strong>
              {m?.models.some((x) => x.status === 'shadow') && (
                <>
                  {' '}
                  · on trial: <strong style={{ color: 'var(--text)' }}>{m.models.find((x) => x.status === 'shadow')!.id}</strong>
                </>
              )}
              {active && ' (Tesseract for lines it isn’t sure of)'}
            </span>
            <button className="btn sm ghost" onClick={() => void act(() => api.post('/api/dev/ocr/models/watch', {}), 'Refreshing trial and watch')}>
              <RefreshIcon size={13} /> Refresh
            </button>
            {active && (
              <button className="btn sm danger" onClick={() => void act(() => api.post('/api/dev/ocr/models/rollback', {}), 'Rolled back')}>
                <XIcon size={13} /> Roll back to {active.previousEngine?.startsWith('model:') ? active.previousEngine.slice(6) : 'Tesseract'}
              </button>
            )}
          </div>
        </div>

        <div className="ocr-pipeline">
          <div className="ocr-step">
            <span className="ocr-step-n">1</span>
            <div>
              <strong>Export training data</strong>
              <p className="faint">Training-side lines only, never the exam and never self-confirmed labels.</p>
              {d.dataset && (
                <p className="faint" style={{ fontSize: 12 }}>
                  Last: <code>{d.dataset.id}</code> · {d.dataset.rows.toLocaleString()} lines
                  {Object.entries(d.dataset.counts).length ? ` · ${Object.entries(d.dataset.counts).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
                </p>
              )}
              <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/export', {}), 'Export queued')}>
                <DownloadIcon size={13} /> Export training data
              </button>
            </div>
          </div>
          <div className="ocr-step-arrow" aria-hidden="true">
            <ChevronIcon size={16} dir="right" />
          </div>
          <div className="ocr-step">
            <span className="ocr-step-n">2</span>
            <div>
              <strong>Train</strong>
              <p className="faint">Runs on this server (CPU is enough). Needs a Python with PyTorch; CardVault can install one here.</p>
              <button className="btn sm" onClick={onGoTraining}>
                <SparkIcon size={13} /> Open training
              </button>
            </div>
          </div>
          <div className="ocr-step-arrow" aria-hidden="true">
            <ChevronIcon size={16} dir="right" />
          </div>
          <div className="ocr-step">
            <span className="ocr-step-n">3</span>
            <div>
              <strong>Score, trial, promote</strong>
              <p className="faint">Score on the exam, then a live trial: it reads real scans alongside the current engine without affecting them. Promotion needs every gate.</p>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/models/rescan', {}), 'Looking for new models')}>
                <ScanIcon size={13} /> Look for new models
              </button>
            </div>
          </div>
        </div>
      </div>

      {m?.models.length ? (
        <div className="stack">
          {m.models.map((x) => {
            const s = x.evaluation?.summary;
            return (
              <div key={x.id} className={`ocr-model ${x.status}`}>
                <div className="row between wrap">
                  <div style={{ minWidth: 0 }}>
                    <strong>
                      <code>{x.id}</code>
                    </strong>{' '}
                    <span className={`ocr-status ${x.status}`}>{x.status}</span>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {new Date(x.createdAt).toLocaleString()}
                      {x.dataset && ` · trained on ${x.dataset.rows?.toLocaleString()} lines (${x.dataset.id})`}
                      {x.training && ` · ${x.training.epochs} epochs, ${x.training.minutes} min, ${(x.training.parameters / 1e6).toFixed(1)}M params`}
                      {x.dev && ` · held-out: names ${pct(x.dev.name?.accuracy)}, numbers ${pct(x.dev.number?.accuracy)}`}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" disabled={busy || m.examVersion == null} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/evaluate`, {}), 'Scoring queued')}>
                      <TargetIcon size={13} /> {x.evaluation ? 'Score again' : `Score on exam v${m.examVersion ?? '?'}`}
                    </button>
                    {x.status === 'shadow' ? (
                      <button className="btn sm ghost" onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/trial/stop`, {}), 'Live trial stopped')}>
                        Stop trial
                      </button>
                    ) : x.status !== 'active' && m.trialMinLines > 0 && x.evaluation ? (
                      <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/trial`, {}), 'Live trial started')}>
                        <PulseIcon size={13} /> Start live trial
                      </button>
                    ) : null}
                    {x.status !== 'active' && (
                      <button className="btn sm primary" disabled={!x.canPromote} title={x.canPromote ? 'Use this model for live scans' : 'Every gate must pass'} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/promote`, {}), 'Promoted: live scans use this model within 30 seconds')}>
                        <CheckIcon size={13} /> Promote
                      </button>
                    )}
                  </div>
                </div>
                {x.status === 'retired' && x.retiredReason && <div className="ocr-retired">Retired {x.retiredAt ? new Date(x.retiredAt).toLocaleString() : ''}: {x.retiredReason}</div>}
                {x.status === 'shadow' && (
                  <div className="ocr-trial">
                    <strong>On live trial</strong> since {x.trialStartedAt ? new Date(x.trialStartedAt).toLocaleString() : '—'}
                    {x.trial ? (
                      <span>
                        {' · '}
                        {x.trial.lines} confirmed lines{m.trialMinLines ? ` of ${m.trialMinLines} needed` : ''} · this model {pct(x.trial.shadowAccuracy)} vs live {pct(x.trial.liveAccuracy)} · {x.trial.wins} better, {x.trial.losses} worse
                      </span>
                    ) : (
                      <span className="faint"> · waiting for scans to be confirmed</span>
                    )}
                    {m.trialMinLines > 0 && (
                      <div className="ocr-bar">
                        <i style={{ width: `${Math.min(100, ((x.trial?.lines ?? 0) / m.trialMinLines) * 100)}%` }} />
                      </div>
                    )}
                  </div>
                )}
                {x.status === 'active' && x.watch && <WatchView w={x.watch} />}
                {x.status === 'active' && !x.watch && <p className="faint" style={{ fontSize: 13, margin: '8px 0 0' }}>Live watch starts with the next check (every 15 minutes).</p>}
                {s && (
                  <div className="row wrap" style={{ gap: 18, marginTop: 8, fontSize: 13 }}>
                    <span>
                      Exam v{x.evaluation!.examVersion}: names <strong>{pct(s.name?.accuracy)}</strong>, numbers <strong>{pct(s.number?.accuracy)}</strong>, {s.msPerLine} ms/line
                    </span>
                    <button className="btn sm ghost" onClick={() => void openDetail(x.evaluation!.id)}>
                      Details
                    </button>
                  </div>
                )}
                {x.gates.length > 0 && (
                  <ul className="ocr-gates">
                    {x.gates.map((g) => (
                      <li key={g.id} className={g.pass ? 'ok' : 'no'}>
                        <span>{g.pass ? <CheckIcon size={13} /> : <XIcon size={13} />}</span> {g.label} <em className="faint">{g.detail}</em>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <Empty icon="◔" title="No models yet">
            Export training data in Models, train on the server, then press Look for new models.
          </Empty>
        </div>
      )}
      {m?.events.length ? (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <ClockIcon size={14} /> History
            </h3>
          </div>
          <ul className="ocr-events">
            {m.events.map((e, i) => (
              <li key={i} className={e.action === 'ocr.auto_rollback' ? 'bad' : ''}>
                <span className="faint">{new Date(e.createdAt).toLocaleString()}</span> {EVENT_LABEL[e.action] ?? e.action} <code>{e.entityId}</code>
                {typeof e.metadata.reason === 'string' && <em className="faint"> · {e.metadata.reason}</em>}
                {typeof e.metadata.restored === 'string' && <em className="faint"> · back to {e.metadata.restored}</em>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Dialog open={!!detail} onClose={() => setDetail(null)}>
        {detail && <EvaluationDetail detail={detail} />}
      </Dialog>
    </div>
  );
}

export function WatchView({ w }: { w: Watch }) {
  const enoughLines = w.after.lines >= w.rules.minLines && w.before.lines >= w.rules.minLines;
  const enoughScans = w.after.scans >= w.rules.minScans && w.before.scans >= w.rules.minScans;
  return (
    <div className="ocr-watch">
      <strong>Live watch</strong>{' '}
      <span className="faint">
        vs {w.previousEngine.startsWith('model:') ? w.previousEngine.slice(6) : 'Tesseract'} before the switch · updated {new Date(w.updatedAt).toLocaleTimeString()}
      </span>
      <div className="ocr-watch-grid">
        <span>Reading accuracy on confirmed lines</span>
        <span>
          <strong>{ratioText(w.after.correct, w.after.lines)}</strong> <em className="faint">of {w.after.lines}</em>
        </span>
        <span className="faint">before: {ratioText(w.before.correct, w.before.lines)} of {w.before.lines}</span>
        <span>{enoughLines ? w.reasons.some((x) => x.includes('accuracy')) ? '✗' : '✓' : <em className="faint">needs {w.rules.minLines} each side</em>}</span>
        <span>Scans needing manual review</span>
        <span>
          <strong>{ratioText(w.after.reviewed, w.after.scans)}</strong> <em className="faint">of {w.after.scans}</em>
        </span>
        <span className="faint">before: {ratioText(w.before.reviewed, w.before.scans)} of {w.before.scans}</span>
        <span>{enoughScans ? w.reasons.some((x) => x.includes('review')) ? '✗' : '✓' : <em className="faint">needs {w.rules.minScans} each side</em>}</span>
      </div>
      <p className="faint" style={{ margin: '6px 0 0', fontSize: 12 }}>
        Rolled back automatically if accuracy drops by more than {pct(w.rules.maxAccuracyDrop)} or manual reviews rise by more than {pct(w.rules.maxReviewRise)}. Checked every 15 minutes.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ training */

export function TrainingTab({ d, act, busy, trainActive }: { d: Overview; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean; trainActive: boolean }) {
  const [form, setForm] = useState({ dataset: 'latest', epochs: 30, synthetic: 20000, maxMinutes: 0 });
  const py = d.python;
  const pyInstalling = py.status === 'installing';
  const pyReady = py.status === 'ready';
  const pyMissing = py.status === 'missing' || py.status === 'failed';
  const cmd = `python tools/ocr-trainer/train.py --storage ${d.dataset?.storage ?? '<STORAGE_DIR>'}`;
  return (
    <div className="stack lg">
      <div className="panel">
        <div className="panel-head">
          <h3>
            <SparkIcon size={14} /> Train a line reader
          </h3>
          {d.training && <span className="badge">{d.training.status}</span>}
        </div>
        <p className="faint" style={{ margin: '0 0 14px' }}>
          A small CRNN learns from the training-side lines — the review-confirmed ones, the corroborated ones, and harvested card images — rendered and augmented to look like phone
          captures. A slice is held back by card, never trained on, and scored after every epoch: that is the curve below. The real verdict, though, is the frozen exam.
        </p>

        {d.training ? (
          <TrainingPanel t={d.training} busy={busy} onStop={() => void act(() => api.post('/api/dev/ocr/train/cancel', {}), 'Stopping after the current step')} />
        ) : (
          <div className="ocr-trainlive idle">
            <div className="row" style={{ gap: 12 }}>
              <span className="ocr-python-mark unknown">
                <SparkIcon size={16} />
              </span>
              <div>
                <strong>Nothing trained yet</strong>
                <div className="faint" style={{ fontSize: 13 }}>
                  Export training data in Models first, then start a run here. Progress, a time until finished and the held-out lines appear live.
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="ocr-train-cols">
          <div>
            <TrainerPythonPanel py={py} busy={busy} trainActive={trainActive} act={act} />
          </div>
          <div>
            {!trainActive && (
              <div className="ocr-form ocr-form-card">
                <div className="ocr-form-title">New run</div>
                <label>
                  Dataset
                  <select className="select" value={form.dataset} onChange={(e) => setForm({ ...form, dataset: e.target.value })}>
                    <option value="latest">Newest export{d.datasets.length ? ` (${d.datasets.at(-1)?.id})` : ''}</option>
                    {[...d.datasets].reverse().map((ds) => (
                      <option key={ds.id} value={ds.id}>
                        {ds.id} · {ds.rows.toLocaleString()} lines
                      </option>
                    ))}
                  </select>
                </label>
                <div className="ocr-form-row">
                  <label>
                    Epochs
                    <input className="input" type="number" min={1} max={500} value={form.epochs} onChange={(e) => setForm({ ...form, epochs: +e.target.value })} />
                  </label>
                  <label>
                    Synthetic lines / epoch
                    <input className="input" type="number" min={0} max={200000} step={1000} value={form.synthetic} onChange={(e) => setForm({ ...form, synthetic: +e.target.value })} />
                  </label>
                </div>
                <label>
                  Stop after minutes (0 = no limit)
                  <input className="input" type="number" min={0} max={10080} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: +e.target.value })} />
                </label>
                {!pyReady && (
                  <p className="faint" style={{ fontSize: 12, margin: 0 }}>
                    {pyMissing
                      ? 'The trainer needs its Python first: press “Set up the OCR trainer” on the left.'
                      : pyInstalling
                        ? 'Setting up the trainer’s Python — training unlocks when it finishes.'
                        : 'If training reports a missing Python, set it up on the left (takes a few minutes once).'}
                  </p>
                )}
                <button
                  className="btn primary"
                  disabled={busy || !d.datasets.length || pyInstalling}
                  title={pyInstalling ? 'Wait for the Python setup to finish' : undefined}
                  onClick={() => void act(() => api.post('/api/dev/ocr/train', form), 'Training queued — follow it in the queue')}
                >
                  <PlayIcon size={14} /> Start training
                </button>
                {!d.datasets.length && <span className="faint">Export training data first (Models tab).</span>}
              </div>
            )}
            <details className="ocr-cmd-details">
              <summary>…or run the trainer yourself (SSH)</summary>
              <div className="ocr-cmd" style={{ marginTop: 6 }}>
                <code>{cmd}</code>
                <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => toast('Copied', 'success'))}>
                  Copy
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ data */

export function DataTab({ d, act, busy }: { d: Overview; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean }) {
  const [filter, setFilter] = useState<{ source?: string; field?: string; regression?: string }>({});
  const samples = useAsync(() => api.get<{ samples: Sample[] }>(`/api/dev/ocr/samples?${new URLSearchParams(filter as Record<string, string>)}`), [JSON.stringify(filter)]);
  return (
    <div className="stack lg">
      <div className="panel">
        <div className="panel-head">
          <h3>
            <ScanIcon size={14} /> Collected lines
          </h3>
          <span className="faint" style={{ fontSize: 13 }}>
            {d.totals.samples.toLocaleString()} lines · {d.totals.exam_groups.toLocaleString()} exam-side groups · {d.totals.regression.toLocaleString()} regression
          </span>
        </div>
        <div className="chip-row" style={{ marginBottom: 12 }}>
          <button className={`chip${!filter.source && !filter.regression ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field })}>
            All
          </button>
          {['review', 'corroborated', 'harvest', 'self', 'pending'].map((s) => (
            <button key={s} className={`chip${filter.source === s ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field, source: s })}>
              {SOURCES.find((x) => x.id === s)!.label}
            </button>
          ))}
          <button className={`chip${filter.regression === 'true' ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field, regression: 'true' })}>
            Regression
          </button>
          <span style={{ width: 8 }} />
          {(['name', 'number'] as const).map((f) => (
            <button key={f} className={`chip${filter.field === f ? ' on' : ''}`} onClick={() => setFilter({ ...filter, field: filter.field === f ? undefined : f })}>
              {f === 'name' ? 'Names' : 'Numbers'}
            </button>
          ))}
        </div>
        {samples.data?.samples.length ? (
          <div className="ocr-samples">
            {samples.data.samples.map((s) => {
              const ok = s.labelNorm == null || s.engine === 'none' ? null : s.field === 'name' ? s.predicted.toLowerCase().includes((s.labelText ?? '').toLowerCase()) : s.predicted.includes(s.labelNorm);
              return (
                <div key={s.id} className="ocr-sample">
                  <img src={crop(s.id)} alt="" loading="lazy" />
                  <div className="ocr-sample-text">
                    <span title="what the engine read" className={ok === false ? 'bad' : ''}>
                      {s.engine === 'none' ? <em className="faint">imported · read during scoring</em> : s.predicted ? s.predicted.split('\n')[0] : <em className="faint">nothing read</em>}
                    </span>
                    <span className="faint">→ {s.labelText ?? s.labelNorm ?? '?'}</span>
                  </div>
                  <div className="ocr-sample-tags faint">
                    {s.field} · {s.source}
                    {s.split ? ` · ${s.split}` : ''}
                    {s.regression ? ' · regression' : ''}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>
            {samples.loading ? 'Loading…' : 'Nothing collected yet. Every scan adds its title and number lines here.'}
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <DownloadIcon size={14} /> Dataset exports
          </h3>
          <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/export', {}), 'Export queued')}>
            <DownloadIcon size={13} /> Export now
          </button>
        </div>
        {d.datasets.length ? (
          <div className="table-wrap">
            <table className="table ocr-table">
              <thead>
                <tr>
                  <th>Export</th>
                  <th>Lines</th>
                  <th>Breakdown</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {[...d.datasets].reverse().map((ds) => (
                  <tr key={ds.id}>
                    <td>
                      <code>{ds.id}</code>
                    </td>
                    <td className="ocr-num">{ds.rows.toLocaleString()}</td>
                    <td className="faint">{Object.entries(ds.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
                    <td className="faint">{ds.createdAt ? new Date(ds.createdAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>No exports yet. Press Export training data, then train on it.</p>
        )}
      </div>
    </div>
  );
}
