import { useEffect, useState } from 'react';
import { api, ApiError } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Dialog, Loading } from '../../components/ui';
import { toast } from '../../stores/toasts';

interface Slice {
  slice: string;
  n: number;
  accuracy: number;
  accuracyWithDictionary?: number;
  cer: number;
  confidentAccuracy: number | null;
  confident: number;
  calibrationError: number;
}
interface Summary {
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
interface Evaluation {
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
interface Overview {
  counts: { source: string; field: string; split: string; n: number }[];
  totals: { samples: number; regression: number; cards: number; exam_groups: number; last7days: number };
  exam: { id: string; version: number; size: number; counts: Record<string, number>; note: string | null; createdAt: string } | null;
  newSinceExam: number;
  import: { status: string; done?: number; total?: number; added?: number; skipped?: number; error?: string; alreadyImported?: number } | null;
  dataset: { id: string; createdAt: string; rows: number; counts: Record<string, number>; dir: string; storage: string } | null;
  datasets: DatasetInfo[];
  training: Training | null;
  python: TrainerPython;
  evaluations: Evaluation[];
}
interface TrainerPython {
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
interface Training {
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
  dev?: Record<string, { n: number; accuracy: number | null }> | null;
  python?: string;
  error?: string;
  log?: string[];
  updatedAt?: string;
}
interface DatasetInfo {
  id: string;
  rows: number;
  counts: Record<string, number>;
  createdAt: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  'ocr.promote': 'Promoted',
  'ocr.rollback': 'Rolled back by hand',
  'ocr.auto_rollback': 'Rolled back automatically',
  'ocr.trial_start': 'Live trial started',
};
const ratioText = (a: number, b: number) => (b ? pct(a / b) : '—');

function WatchView({ w }: { w: Watch }) {
  const enoughLines = w.after.lines >= w.rules.minLines && w.before.lines >= w.rules.minLines;
  const enoughScans = w.after.scans >= w.rules.minScans && w.before.scans >= w.rules.minScans;
  return (
    <div className="ocr-watch">
      <strong>Live watch</strong> <span className="faint">vs {w.previousEngine.startsWith('model:') ? w.previousEngine.slice(6) : 'Tesseract'} before the switch · updated {new Date(w.updatedAt).toLocaleTimeString()}</span>
      <div className="ocr-watch-grid">
        <span>Reading accuracy on confirmed lines</span>
        <span><strong>{ratioText(w.after.correct, w.after.lines)}</strong> <em className="faint">of {w.after.lines}</em></span>
        <span className="faint">before: {ratioText(w.before.correct, w.before.lines)} of {w.before.lines}</span>
        <span>{enoughLines ? (w.reasons.some((x) => x.includes('accuracy')) ? '✗' : '✓') : <em className="faint">needs {w.rules.minLines} each side</em>}</span>
        <span>Scans needing manual review</span>
        <span><strong>{ratioText(w.after.reviewed, w.after.scans)}</strong> <em className="faint">of {w.after.scans}</em></span>
        <span className="faint">before: {ratioText(w.before.reviewed, w.before.scans)} of {w.before.scans}</span>
        <span>{enoughScans ? (w.reasons.some((x) => x.includes('review')) ? '✗' : '✓') : <em className="faint">needs {w.rules.minScans} each side</em>}</span>
      </div>
      <p className="faint" style={{ margin: '6px 0 0', fontSize: 12 }}>
        Rolled back automatically if accuracy drops by more than {pct(w.rules.maxAccuracyDrop)} or manual reviews rise by more than {pct(w.rules.maxReviewRise)}. Checked every 15 minutes.
      </p>
    </div>
  );
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

const SOURCES: { id: string; label: string; hint: string }[] = [
  { id: 'review', label: 'Confirmed by a person', hint: 'Fixed or confirmed in Manual Review. The most valuable labels.' },
  { id: 'corroborated', label: 'Auto, corroborated', hint: 'Identified automatically, and evidence independent of this line agreed.' },
  { id: 'harvest', label: 'TCGdex harvest', hint: 'Official images made to look like captures. Correct labels, not real photos.' },
  { id: 'self', label: 'Auto, self-confirmed', hint: 'Identified mainly from this line itself. Never used to train or test.' },
  { id: 'pending', label: 'Waiting for a label', hint: 'The scan has not been identified yet.' },
  { id: 'excluded', label: 'Excluded', hint: 'Unusable, e.g. cut with another game’s layout.' },
];

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const delta = (now?: number | null, before?: number | null) => {
  if (now == null || before == null) return null;
  const d = (now - before) * 100;
  if (Math.abs(d) < 0.05) return <span className="faint"> ±0</span>;
  return <span style={{ color: d > 0 ? 'var(--good)' : 'var(--bad)' }}> {d > 0 ? '▲' : '▼'}{Math.abs(d).toFixed(1)}</span>;
};
const crop = (id: string) => `/api/dev/ocr/samples/${id}/crop`;

export default function OcrLabPage() {
  const ov = useAsync(() => api.get<Overview>('/api/dev/ocr'), []);
  const models = useAsync(() => api.get<Models>('/api/dev/ocr/models'), []);
  const [detail, setDetail] = useState<Evaluation | null>(null);
  const [filter, setFilter] = useState<{ source?: string; field?: string; regression?: string }>({});
  const samples = useAsync(() => api.get<{ samples: Sample[] }>(`/api/dev/ocr/samples?${new URLSearchParams(filter as Record<string, string>)}`), [JSON.stringify(filter)]);
  const busy = !!ov.data && (ov.data.evaluations.some((e) => e.status === 'queued' || e.status === 'running') || ov.data.import?.status === 'running' || ov.data.import?.status === 'queued' || ['queued', 'starting', 'running', 'installing'].includes(ov.data.training?.status ?? '') || ov.data.python?.status === 'installing');

  useEffect(() => {
    const t = setInterval(() => {
      ov.reload();
      models.reload();
    }, busy ? 2500 : 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success');
      ov.reload();
      models.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };
  const open = async (id: string) => {
    try {
      setDetail(await api.get<Evaluation>(`/api/dev/ocr/evaluations/${id}`));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };

  if (!ov.data) return <Loading />;
  const d = ov.data;
  const count = (source: string, field: string, split?: string) => d.counts.filter((c) => c.source === source && c.field === field && (!split || c.split === split)).reduce((a, c) => a + c.n, 0);
  const imp = d.import;

  return (
    <div className="stack lg ocr-lab">
      <div className="page-head">
        <div>
          <h1>OCR Lab</h1>
          <p>Lines collected from every scan, the frozen exam every reader is scored on, and the scores.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Lines collected</div><div className="value">{d.totals.samples.toLocaleString()}</div><div className="sub">{d.totals.last7days.toLocaleString()} this week</div></div>
        <div className="stat"><div className="label">Cards covered</div><div className="value">{d.totals.cards.toLocaleString()}</div><div className="sub">distinct cards with labels</div></div>
        <div className="stat"><div className="label">Exam-side groups</div><div className="value">{d.totals.exam_groups.toLocaleString()}</div><div className="sub">trusted, never trained on</div></div>
        <div className="stat"><div className="label">Regression set</div><div className="value">{d.totals.regression.toLocaleString()}</div><div className="sub">misreads a person fixed</div></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h3>Collected data</h3><span className="faint" style={{ fontSize: 13 }}>train · exam</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Label source</th><th>Names</th><th>Numbers</th></tr></thead>
              <tbody>
                {SOURCES.map((s) => (
                  <tr key={s.id} title={s.hint}>
                    <td><strong>{s.label}</strong><div className="faint" style={{ fontSize: 12 }}>{s.hint}</div></td>
                    {(['name', 'number'] as const).map((f) => (
                      <td key={f} style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {['review', 'corroborated', 'harvest'].includes(s.id) ? `${count(s.id, f, 'train').toLocaleString()} · ${count(s.id, f, 'exam').toLocaleString()}` : count(s.id, f).toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Exam</h3>{d.exam && <span className="faint" style={{ fontSize: 13 }}>v{d.exam.version} · {new Date(d.exam.createdAt).toLocaleDateString()}</span>}</div>
            {d.exam ? (
              <>
                <p style={{ margin: '0 0 8px' }}><strong>{d.exam.size.toLocaleString()}</strong> lines, frozen. Every engine is scored on exactly these until a new version is frozen.</p>
                <div className="row wrap faint" style={{ gap: 10, fontSize: 12 }}>{Object.entries(d.exam.counts).map(([k, v]) => <span key={k}>{k}: {v}</span>)}</div>
              </>
            ) : (
              <p className="faint" style={{ margin: 0 }}>No exam yet. Freeze one once there are labelled lines (scan and confirm cards, or import harvested cards).</p>
            )}
            <div className="row between" style={{ marginTop: 14 }}>
              <span className="faint" style={{ fontSize: 13 }}>{d.exam ? `${d.newSinceExam.toLocaleString()} new exam-side groups since v${d.exam.version}` : `${d.totals.exam_groups.toLocaleString()} groups available`}</span>
              <button className="btn sm" disabled={!d.totals.exam_groups} onClick={() => void act(() => api.post('/api/dev/ocr/exams', {}), 'New exam version frozen')}>
                Freeze exam v{(d.exam?.version ?? 0) + 1}
              </button>
            </div>
            <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>Freeze a new version occasionally, not between comparing two engines: scores are only comparable on the same version.</p>
          </div>

          <div className="panel">
            <div className="panel-head"><h3>TCGdex harvest</h3></div>
            <p className="faint" style={{ margin: '0 0 10px', fontSize: 13 }}>Turns cards downloaded with the TCGdex Harvester into labelled lines, made to look like captures. A separate slice in every score, so it never hides how real photos do.</p>
            {imp && (
              <div style={{ marginBottom: 10, fontSize: 13 }}>
                {imp.status === 'failed' ? (
                  <span style={{ color: 'var(--bad)' }}>{imp.error}</span>
                ) : (
                  <>
                    <div className="row between"><span>{imp.status === 'done' ? 'Finished' : imp.status === 'queued' ? 'Queued…' : 'Importing…'}</span><span className="faint">{(imp.done ?? 0).toLocaleString()} / {(imp.total ?? 0).toLocaleString()} cards · {(imp.added ?? 0).toLocaleString()} added{imp.skipped ? ` · ${imp.skipped} skipped` : ''}</span></div>
                    {imp.total ? <div className="ocr-bar"><i style={{ width: `${((imp.done ?? 0) / imp.total) * 100}%` }} /></div> : null}
                  </>
                )}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/import-harvest', { limit: 500 }), 'Importing 500 cards')}>Import 500</button>
              <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/import-harvest', {}), 'Importing all harvested cards')}>Import all</button>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Evaluations</h3>
          <button className="btn sm primary" disabled={!d.exam || busy} onClick={() => void act(() => api.post('/api/dev/ocr/evaluations', {}), 'Evaluation started')}>
            ▶ Score current engine
          </button>
        </div>
        {d.evaluations.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>When</th><th>Engine</th><th>Exam</th><th>Names</th><th>Names + dictionary</th><th>Numbers</th><th>Regression</th><th>Speed</th><th /></tr>
              </thead>
              <tbody>
                {d.evaluations.map((e) => {
                  const s = e.summary;
                  const prev = s.comparedTo;
                  return (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</td>
                      <td><code>{s.engine ?? e.engine}</code></td>
                      <td>{e.examVersion ? `v${e.examVersion}` : '—'}</td>
                      {e.status === 'done' ? (
                        <>
                          <td>{pct(s.name?.accuracy)}{delta(s.name?.accuracy, prev?.name?.accuracy)}<div className="faint" style={{ fontSize: 12 }}>CER {pct(s.name?.cer)} · n {s.name?.n ?? 0}</div></td>
                          <td>{pct(s.name?.accuracyWithDictionary)}{delta(s.name?.accuracyWithDictionary, prev?.name?.accuracyWithDictionary)}</td>
                          <td>{pct(s.number?.accuracy)}{delta(s.number?.accuracy, prev?.number?.accuracy)}<div className="faint" style={{ fontSize: 12 }}>n {s.number?.n ?? 0}</div></td>
                          <td>{s.regression?.name || s.regression?.number ? `${pct(s.regression?.name?.accuracy)} · ${pct(s.regression?.number?.accuracy)}` : <span className="faint">none yet</span>}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{s.msPerLine ?? '—'} ms/line</td>
                          <td><button className="btn sm ghost" onClick={() => void open(e.id)}>Details</button></td>
                        </>
                      ) : e.status === 'failed' ? (
                        <td colSpan={6} style={{ color: 'var(--bad)' }}>{e.error}</td>
                      ) : (
                        <td colSpan={6}>
                          <div className="row" style={{ gap: 10 }}>
                            <span>{e.status === 'queued' ? 'Queued…' : `Reading ${e.progress.done.toLocaleString()} / ${e.progress.total.toLocaleString()}`}</span>
                            <div className="ocr-bar" style={{ flex: 1 }}><i style={{ width: `${e.progress.total ? (e.progress.done / e.progress.total) * 100 : 0}%` }} /></div>
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
          <p className="faint" style={{ margin: 0 }}>No scores yet. Freeze an exam, then score the current engine: that's the baseline every future engine has to beat.</p>
        )}
      </div>

      <ModelsPanel d={d} m={models.data} busy={busy} act={act} onDetails={(id) => void open(id)} />

      <div className="panel">
        <div className="panel-head">
          <h3>Collected lines</h3>
          <div className="chip-row">
            <button className={`chip${!filter.source && !filter.regression ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field })}>All</button>
            {['review', 'corroborated', 'harvest', 'self', 'pending'].map((s) => (
              <button key={s} className={`chip${filter.source === s ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field, source: s })}>{SOURCES.find((x) => x.id === s)!.label}</button>
            ))}
            <button className={`chip${filter.regression === 'true' ? ' on' : ''}`} onClick={() => setFilter({ field: filter.field, regression: 'true' })}>Regression</button>
            <span style={{ width: 8 }} />
            {(['name', 'number'] as const).map((f) => (
              <button key={f} className={`chip${filter.field === f ? ' on' : ''}`} onClick={() => setFilter({ ...filter, field: filter.field === f ? undefined : f })}>{f === 'name' ? 'Names' : 'Numbers'}</button>
            ))}
          </div>
        </div>
        {samples.data?.samples.length ? (
          <div className="ocr-samples">
            {samples.data.samples.map((s) => {
              const ok = s.labelNorm == null || s.engine === 'none' ? null : s.field === 'name' ? s.predicted.toLowerCase().includes((s.labelText ?? '').toLowerCase()) : s.predicted.includes(s.labelNorm);
              return (
                <div key={s.id} className="ocr-sample">
                  <img src={crop(s.id)} alt="" loading="lazy" />
                  <div className="ocr-sample-text">
                    <span title="what the engine read" className={ok === false ? 'bad' : ''}>{s.engine === 'none' ? <em className="faint">imported · read during scoring</em> : s.predicted ? s.predicted.split('\n')[0] : <em className="faint">nothing read</em>}</span>
                    <span className="faint">→ {s.labelText ?? s.labelNorm ?? '?'}</span>
                  </div>
                  <div className="ocr-sample-tags faint">{s.field} · {s.source}{s.split ? ` · ${s.split}` : ''}{s.regression ? ' · regression' : ''}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>{samples.loading ? 'Loading…' : 'Nothing collected yet. Every scan adds its title and number lines here.'}</p>
        )}
      </div>

      <Dialog open={!!detail} onClose={() => setDetail(null)}>
        {detail && (
          <div className="stack">
            <h2 style={{ margin: 0 }}>Score details · exam v{detail.examVersion}</h2>
            <p className="faint" style={{ margin: 0 }}>
              {detail.summary.units?.toLocaleString()} items · {Math.round((detail.summary.durationMs ?? 0) / 1000)}s
              {detail.summary.missingCrops ? ` · ${detail.summary.missingCrops} crops missing on disk` : ''}
            </p>
            <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="table">
                <thead><tr><th>Slice</th><th>n</th><th>Accuracy</th><th>+ dictionary</th><th>CER</th><th>When ≥90% sure</th><th>Calibration error</th></tr></thead>
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
                  {m.samples.map((id) => <img key={id} src={crop(id)} alt="" loading="lazy" />)}
                  <div className="ocr-sample-text">
                    <span className="bad">{m.predicted || <em>nothing</em>}</span>
                    <span className="faint">→ {m.label}</span>
                  </div>
                  <div className="ocr-sample-tags faint">{m.field} · {m.game} · {m.source}{m.regression ? ' · regression' : ''}</div>
                </div>
              ))}
              {!detail.misses?.length && <p className="faint">No misreads.</p>}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/**
 * The interpreter the trainer runs on. One press installs a venv with CPU
 * PyTorch and the trainer's packages (scripts/ocr-python.sh, run by the
 * worker); a healthy one shows its path instead. The environment lives under
 * storage, so (in Docker, where it sits on the storage volume) it survives
 * image updates.
 */
export function TrainerPythonPanel({ py, busy, trainActive, act }: { py: TrainerPython; busy: boolean; trainActive: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const installing = py.status === 'installing';
  const ready = py.status === 'ready';
  const missing = py.status === 'missing' || py.status === 'failed';
  const [showLog, setShowLog] = useState(false);
  return (
    <div className={`ocr-python ${py.status}`}>
      <div className="row between wrap" style={{ width: '100%', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 13 }}>Trainer Python</strong>
          <div className="faint" style={{ fontSize: 12 }}>
            {installing
              ? `Installing${py.step ? `: ${py.steps[py.step - 1] ?? ''}` : '…'}`
              : ready
                ? <><code>{py.python}</code>{py.configured ? ' (set in OCR_TRAIN_PYTHON)' : ''}</>
                : missing
                  ? 'Not installed — the trainer cannot start yet.'
                  : 'Not checked yet. Training checks it, or set it up now.'}
          </div>
        </div>
        {installing ? (
          <span className="faint" style={{ fontSize: 12 }}>A few minutes, once…</span>
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
            const step = py.step ?? 0;
            const state = i + 1 < step ? 'done' : i + 1 === step ? 'now' : 'next';
            return <li key={label} className={state}>{state === 'done' ? '✓' : state === 'now' ? '•' : '·'} {label}</li>;
          })}
        </ul>
      )}
      {ready && py.finishedAt && <div className="faint" style={{ fontSize: 11 }}>Last checked {new Date(py.finishedAt).toLocaleString()}</div>}
      {missing && !py.error && <div className="faint" style={{ fontSize: 11 }}>One-time download of a few hundred MB; it stays in <code>{py.venv}</code>.</div>}
      {py.error && (
        <div style={{ fontSize: 12, color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>
          {py.error}
          {!py.configured && (
            <details style={{ marginTop: 4 }}>
              <summary className="faint" style={{ cursor: 'pointer' }}>Run it yourself over SSH</summary>
              <div className="ocr-cmd" style={{ marginTop: 4 }}>
                <code>{py.manual}</code>
                <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(py.manual).then(() => toast('Copied', 'success'))}>Copy</button>
              </div>
              <div className="faint" style={{ marginTop: 4 }}>Needs internet access to PyPI. The environment goes in <code>{py.venv}</code>; the worker finds it by itself.</div>
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

function ModelsPanel({ d, m, busy, act, onDetails }: { d: Overview; m: Models | null; busy: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; onDetails: (id: string) => void }) {
  const active = m?.models.find((x) => x.status === 'active');
  const storage = d.dataset?.storage ?? '<STORAGE_DIR>';
  const cmd = `python tools/ocr-trainer/train.py --storage ${storage}`;
  const [form, setForm] = useState({ dataset: 'latest', epochs: 30, synthetic: 20000, maxMinutes: 0 });
  const t = d.training;
  const trainActive = !!t && ['queued', 'starting', 'running'].includes(t.status);
  const py = d.python;
  const pyInstalling = py.status === 'installing';
  const pyReady = py.status === 'ready';
  const pyMissing = py.status === 'missing' || py.status === 'failed';
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Models</h3>
        <div className="row" style={{ gap: 8 }}>
          <span className="faint" style={{ fontSize: 13 }}>
            Reading scans now: <strong style={{ color: 'var(--text)' }}>{active ? active.id : 'Tesseract'}</strong>
            {m?.models.some((x) => x.status === 'shadow') && <> · on trial: <strong style={{ color: 'var(--text)' }}>{m.models.find((x) => x.status === 'shadow')!.id}</strong></>}
            {active && ' (Tesseract for lines it isn’t sure of)'}
          </span>
          <button className="btn sm ghost" onClick={() => void act(() => api.post('/api/dev/ocr/models/watch', {}), 'Refreshing trial and watch')}>
            Refresh
          </button>
          {active && (
            <button className="btn sm danger" onClick={() => void act(() => api.post('/api/dev/ocr/models/rollback', {}), 'Rolled back')}>
              Roll back to {active.previousEngine?.startsWith('model:') ? active.previousEngine.slice(6) : 'Tesseract'}
            </button>
          )}
        </div>
      </div>

      <div className="ocr-train">
        <div>
          <strong>1. Export training data</strong>
          <p className="faint">Training-side lines only, never the exam and never self-confirmed labels.</p>
          {d.dataset ? (
            <p className="faint" style={{ fontSize: 12 }}>
              Last: <code>{d.dataset.id}</code> · {d.dataset.rows.toLocaleString()} lines · {Object.entries(d.dataset.counts).map(([k, v]) => `${k} ${v}`).join(', ')}
            </p>
          ) : null}
          <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post('/api/dev/ocr/export', {}), 'Export started')}>
            Export training data
          </button>
        </div>
        <div>
          <strong>2. Train</strong>
          <p className="faint">Runs on this server (CPU is enough). Needs a Python with PyTorch; CardVault can install one here.</p>
          <TrainerPythonPanel py={py} busy={busy} trainActive={trainActive} act={act} />
          {t && (
            <div className="ocr-training">
              {t.status === 'failed' ? (
                <span style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>{t.error}</span>
              ) : t.status === 'cancelled' ? (
                <span className="faint">Training stopped.</span>
              ) : t.status === 'done' ? (
                <>
                  <span>Finished <code>{t.modelId}</code> · {t.minutes ?? 0} min{t.epochs ? ` · ${t.epochs} epochs` : ''}</span>
                  <span className="faint">Held-out check: names {pct(t.dev?.name?.accuracy)} · numbers {pct(t.dev?.number?.accuracy)}</span>
                  <span className="faint">Registered below — score it on the exam next.</span>
                </>
              ) : (
                <>
                  <div className="row between" style={{ width: '100%' }}>
                    <span>{t.status === 'queued' ? 'Queued…' : t.status === 'starting' ? `Starting${t.python ? ` · ${t.python}` : ''}…` : `Epoch ${t.epoch ?? '…'} / ${t.epochs ?? '…'} · loss ${t.loss ?? '…'}`}</span>
                    <span className="faint">{t.dataset ?? t.requested}{t.lines != null ? ` · ${t.lines.toLocaleString()} lines` : ''}{t.minutes ? ` · ${t.minutes} min` : ''}</span>
                  </div>
                  {t.status !== 'queued' && <div className="ocr-bar" style={{ width: '100%' }}><i style={{ width: `${t.epochs ? Math.min(100, ((t.epoch ?? 0) / t.epochs) * 100) : 0}%` }} /></div>}
                  <div className="row between" style={{ width: '100%' }}>
                    <span className="faint">Held out: names {pct(t.devName)} · numbers {pct(t.devNumber)}</span>
                    <button className="btn sm ghost" onClick={() => void act(() => api.post('/api/dev/ocr/train/cancel', {}), 'Stopping after the current step')}>Stop</button>
                  </div>
                </>
              )}
              {t.log?.length ? <pre className="ocr-log">{t.log.slice(-6).join('\n')}</pre> : null}
            </div>
          )}
          {!trainActive && (
            <div className="ocr-form">
              {!pyReady && (
                <p className="faint" style={{ fontSize: 12, margin: 0 }}>
                  {pyMissing
                    ? 'The trainer needs its Python first: press “Set up the OCR trainer” above.'
                    : pyInstalling
                      ? 'Setting up the trainer’s Python — training unlocks when it finishes.'
                      : 'If training reports a missing Python, set it up above (takes a few minutes once).'}
                </p>
              )}
              <label>
                Dataset
                <select className="select" value={form.dataset} onChange={(e) => setForm({ ...form, dataset: e.target.value })}>
                  <option value="latest">Newest export{d.datasets.length ? ` (${d.datasets.at(-1)?.id})` : ''}</option>
                  {[...d.datasets].reverse().map((ds) => (
                    <option key={ds.id} value={ds.id}>{ds.id} · {ds.rows.toLocaleString()} lines</option>
                  ))}
                </select>
              </label>
              <label>
                Epochs
                <input className="input" type="number" min={1} max={500} value={form.epochs} onChange={(e) => setForm({ ...form, epochs: +e.target.value })} />
              </label>
              <label>
                Synthetic lines per epoch
                <input className="input" type="number" min={0} max={200000} step={1000} value={form.synthetic} onChange={(e) => setForm({ ...form, synthetic: +e.target.value })} />
              </label>
              <label>
                Stop after minutes (0 = no limit)
                <input className="input" type="number" min={0} max={10080} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: +e.target.value })} />
              </label>
              <button className="btn sm primary" disabled={busy || !d.datasets.length || pyInstalling} title={pyInstalling ? 'Wait for the Python setup to finish' : undefined} onClick={() => void act(() => api.post('/api/dev/ocr/train', form), 'Training started')}>
                Start training
              </button>
              {!d.datasets.length && <span className="faint">Export training data first.</span>}
            </div>
          )}
          <details>
            <summary>…or run the trainer yourself (SSH)</summary>
            <div className="ocr-cmd" style={{ marginTop: 6 }}>
              <code>{cmd}</code>
              <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => toast('Copied', 'success'))}>Copy</button>
            </div>
          </details>
        </div>
        <div>
          <strong>3. Score, trial, promote</strong>
          <p className="faint">Score it on the exam, then run a live trial: it reads real scans alongside the current engine without affecting them. It can only be promoted when every gate passes, and is watched afterwards.</p>
          <button className="btn sm ghost" onClick={() => void act(() => api.post('/api/dev/ocr/models/rescan', {}), 'Looking for new models')}>
            Look for new models
          </button>
        </div>
      </div>

      {m?.models.length ? (
        <div className="stack" style={{ marginTop: 14 }}>
          {m.models.map((x) => {
            const s = x.evaluation?.summary;
            return (
              <div key={x.id} className={`ocr-model ${x.status}`}>
                <div className="row between wrap">
                  <div>
                    <strong><code>{x.id}</code></strong> <span className={`ocr-status ${x.status}`}>{x.status}</span>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {new Date(x.createdAt).toLocaleString()}
                      {x.dataset && ` · trained on ${x.dataset.rows?.toLocaleString()} lines (${x.dataset.id})`}
                      {x.training && ` · ${x.training.epochs} epochs, ${x.training.minutes} min, ${(x.training.parameters / 1e6).toFixed(1)}M params`}
                      {x.dev && ` · held-out check: names ${pct(x.dev.name?.accuracy)}, numbers ${pct(x.dev.number?.accuracy)}`}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" disabled={busy || m.examVersion == null} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/evaluate`, {}), 'Scoring started')}>
                      {x.evaluation ? 'Score again' : `Score on exam v${m.examVersion ?? '?'}`}
                    </button>
                    {x.status === 'shadow' ? (
                      <button className="btn sm ghost" onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/trial/stop`, {}), 'Live trial stopped')}>Stop trial</button>
                    ) : x.status !== 'active' && m.trialMinLines > 0 && x.evaluation ? (
                      <button className="btn sm" disabled={busy} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/trial`, {}), 'Live trial started: new scans are read by this model too')}>Start live trial</button>
                    ) : null}
                    {x.status !== 'active' && (
                      <button className="btn sm primary" disabled={!x.canPromote} title={x.canPromote ? 'Use this model for live scans' : 'Every gate must pass'} onClick={() => void act(() => api.post(`/api/dev/ocr/models/${x.id}/promote`, {}), 'Promoted: live scans use this model within 30 seconds')}>
                        Promote
                      </button>
                    )}
                  </div>
                </div>
                {x.status === 'retired' && x.retiredReason && (
                  <div className="ocr-retired">Retired {x.retiredAt ? new Date(x.retiredAt).toLocaleString() : ''}: {x.retiredReason}</div>
                )}
                {x.status === 'shadow' && (
                  <div className="ocr-trial">
                    <strong>On live trial</strong> since {x.trialStartedAt ? new Date(x.trialStartedAt).toLocaleString() : '—'}
                    {x.trial ? (
                      <span>
                        {' · '}{x.trial.lines} confirmed lines{m.trialMinLines ? ` of ${m.trialMinLines} needed` : ''} · this model {pct(x.trial.shadowAccuracy)} vs live {pct(x.trial.liveAccuracy)} · {x.trial.wins} better, {x.trial.losses} worse
                      </span>
                    ) : (
                      <span className="faint"> · waiting for scans to be confirmed</span>
                    )}
                    {m.trialMinLines > 0 && <div className="ocr-bar"><i style={{ width: `${Math.min(100, ((x.trial?.lines ?? 0) / m.trialMinLines) * 100)}%` }} /></div>}
                  </div>
                )}
                {x.status === 'active' && x.watch && <WatchView w={x.watch} />}
                {x.status === 'active' && !x.watch && <p className="faint" style={{ fontSize: 13, margin: '8px 0 0' }}>Live watch starts with the next check (every 15 minutes).</p>}
                {s && (
                  <div className="row wrap" style={{ gap: 18, marginTop: 8, fontSize: 13 }}>
                    <span>Exam v{x.evaluation!.examVersion}: names <strong>{pct(s.name?.accuracy)}</strong>, numbers <strong>{pct(s.number?.accuracy)}</strong>, {s.msPerLine} ms/line</span>
                    <button className="btn sm ghost" onClick={() => onDetails(x.evaluation!.id)}>Details</button>
                  </div>
                )}
                {x.gates.length > 0 && (
                  <ul className="ocr-gates">
                    {x.gates.map((g) => (
                      <li key={g.id} className={g.pass ? 'ok' : 'no'}>
                        <span>{g.pass ? '✓' : '✗'}</span> {g.label} <em className="faint">{g.detail}</em>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="faint" style={{ margin: '14px 0 0' }}>No models yet. Export training data, train on the server, then press Look for new models.</p>
      )}
      {m?.events.length ? (
        <div style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 13 }}>History</strong>
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
    </div>
  );
}
