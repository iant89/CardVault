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
  const [detail, setDetail] = useState<Evaluation | null>(null);
  const [filter, setFilter] = useState<{ source?: string; field?: string; regression?: string }>({});
  const samples = useAsync(() => api.get<{ samples: Sample[] }>(`/api/dev/ocr/samples?${new URLSearchParams(filter as Record<string, string>)}`), [JSON.stringify(filter)]);
  const busy = !!ov.data && (ov.data.evaluations.some((e) => e.status === 'queued' || e.status === 'running') || ov.data.import?.status === 'running' || ov.data.import?.status === 'queued');

  useEffect(() => {
    const t = setInterval(() => ov.reload(), busy ? 2500 : 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success');
      ov.reload();
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
