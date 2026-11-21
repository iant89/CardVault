import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CONDITIONS, GAME_SLUGS, VARIANT_TYPES } from '@cardvault/shared';
import { GAME_MODULES } from '@cardvault/card-model';
import { api, ApiError, qs } from '../../services/api';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useLive } from '../../stores/live';
import { toast } from '../../stores/toasts';
import { Empty, Loading } from '../../components/ui';
import type { CardDTO } from '../../types';

interface Candidate {
  card_id: string;
  confidence: number;
  name: string;
  collector_number: string;
  image_url: string | null;
  rarity: string | null;
  set_name: string | null;
  game: string;
}
interface Review {
  id: string;
  scanId: string;
  reason: string | null;
  ownerName: string;
  confidence: number | null;
  gameHint: string | null;
  image: string;
  thumbnail: string | null;
  original: { names?: string[]; numbers?: { raw: string }[]; gameGuess?: string | null } | null;
  candidates: Candidate[];
  createdAt: string;
}

const REASON: Record<string, string> = {
  VERIFY: 'Please verify — confidence 80–94%',
  LOW_CONFIDENCE: 'Low confidence match',
  NO_MATCH: 'No catalog match found',
};

export default function ReviewPage() {
  const revision = useLive((s) => s.revision);
  const list = useAsync(() => api.get<{ reviews: Review[] }>('/api/manual-review'), [revision]);
  const [selId, setSelId] = useState<string | null>(null);
  const [params] = useSearchParams();
  const reviews = list.data?.reviews ?? [];
  // ?scan=<id> (from the scanner's Edit button) preselects that scan's review
  const sel = reviews.find((r) => r.id === selId) ?? reviews.find((r) => r.scanId === params.get('scan')) ?? reviews[0] ?? null;

  if (list.loading && !list.data) return <Loading />;
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>Manual review</h1>
          <p>{reviews.length ? `${reviews.length} card${reviews.length > 1 ? 's need' : ' needs'} a human eye. Corrections teach the catalog.` : 'All caught up.'}</p>
        </div>
      </div>
      {!sel ? (
        <div className="panel">
          <Empty icon="✓" title="Nothing to review" />
        </div>
      ) : (
        <div className="review">
          <div className="panel tight review-list" style={{ alignContent: 'start', maxHeight: '75vh', overflow: 'auto' }}>
            {reviews.map((r) => (
              <button key={r.id} className={r.id === sel.id ? 'sel' : ''} onClick={() => setSelId(r.id)}>
                <img src={r.thumbnail ?? r.image} alt="" />
                <div style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 700, fontSize: 14 }}>
                    {r.candidates[0]?.name ?? r.original?.names?.[0] ?? 'Unknown card'}
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {r.ownerName} · {r.reason === 'VERIFY' ? 'verify' : r.reason === 'NO_MATCH' ? 'no match' : 'low confidence'}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <ReviewEditor key={sel.id} review={sel} onDone={() => (setSelId(null), list.reload())} />
        </div>
      )}
    </div>
  );
}

function ReviewEditor({ review, onDone }: { review: Review; onDone: () => void }) {
  const top = review.candidates[0];
  const [f, setF] = useState({
    game: top?.game ?? review.gameHint ?? review.original?.gameGuess ?? 'pokemon',
    name: top?.name ?? review.original?.names?.[0] ?? '',
    setName: top?.set_name ?? '',
    collectorNumber: top?.collector_number ?? review.original?.numbers?.[0]?.raw ?? '',
    variant: 'NORMAL',
    rarity: top?.rarity ?? '',
    condition: 'NM',
  });
  const [picked, setPicked] = useState<string | null>(review.reason === 'VERIFY' ? (top?.card_id ?? null) : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    if (k !== 'variant' && k !== 'condition') setPicked(null);
  };

  const dq = useDebounced(f.name, 350);
  const search = useAsync(
    () => (dq.length >= 2 ? api.get<{ items: CardDTO[] }>(`/api/cards${qs({ q: dq, game: f.game, pageSize: 8 })}`) : Promise.resolve({ items: [] })),
    [dq, f.game],
  );
  const sets = useAsync(() => api.get<{ sets: { id: string; name: string }[] }>(`/api/sets?game=${f.game}`), [f.game]);
  useEffect(() => setErr(''), [f]);

  const choose = (c: { id: string; name: string; set: string | null; number: string; rarity: string | null; game: string; variants?: string[] }) => {
    setF((x) => ({ ...x, game: c.game, name: c.name, setName: c.set ?? '', collectorNumber: c.number, rarity: c.rarity ?? '', variant: c.variants?.[0] ?? x.variant }));
    setPicked(c.id);
  };

  const resolve = async () => {
    setBusy(true);
    try {
      const body = picked
        ? { cardId: picked, variant: f.variant, condition: f.condition }
        : { game: f.game, name: f.name.trim(), setName: f.setName.trim() || undefined, collectorNumber: f.collectorNumber.trim(), variant: f.variant, rarity: f.rarity.trim() || undefined, condition: f.condition };
      await api.post(`/api/manual-review/${review.id}/resolve`, body);
      toast(`Saved — researching ${f.name}`, 'success');
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!confirm('Reject this scan? It will not be added to the collection.')) return;
    await api.post(`/api/manual-review/${review.id}/reject`, {});
    onDone();
  };

  return (
    <div className="panel">
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(200px, 300px) 1fr' }}>
        <div className="stack">
          <img className="review-img" src={review.image} alt="Scanned card" />
          <div className="faint" style={{ fontSize: 13 }}>
            Scanned by {review.ownerName} · {new Date(review.createdAt).toLocaleString()}
          </div>
          {review.original?.names?.length ? (
            <div className="faint" style={{ fontSize: 12 }}>
              OCR read: <span className="mono">{review.original.names.slice(0, 3).join(' · ')}</span>
              {review.original.numbers?.length ? <span className="mono"> · #{review.original.numbers.map((n) => n.raw).join(', ')}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="stack">
          <div>
            <span className={`badge ${review.reason === 'VERIFY' ? 'accent' : 'warn'}`}>{REASON[review.reason ?? ''] ?? 'Needs review'}</span>
            <div className="muted" style={{ marginTop: 6 }}>
              Detected game: <strong>{review.original?.gameGuess ?? review.gameHint ?? 'Unknown'}</strong>
              {review.confidence != null && review.confidence > 0 ? ` · best match ${(review.confidence * 100).toFixed(1)}%` : ''}
            </div>
          </div>

          {review.candidates.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Suggestions</h3>
              {review.candidates.slice(0, 4).map((c) => (
                <button
                  key={c.card_id}
                  className="cand"
                  style={picked === c.card_id ? { borderColor: 'var(--good)', background: 'rgba(61,220,151,.08)' } : undefined}
                  onClick={() => choose({ id: c.card_id, name: c.name, set: c.set_name, number: c.collector_number, rarity: c.rarity, game: c.game })}
                >
                  {c.image_url ? <img src={c.image_url} alt="" /> : <div style={{ width: 40, height: 56, background: '#222', borderRadius: 4 }} />}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong className="truncate">{c.name}</strong>
                    <div className="faint truncate" style={{ fontSize: 13 }}>
                      {c.set_name} · {c.collector_number}
                    </div>
                  </div>
                  <span className="badge">{(c.confidence * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}

          <div className="form-grid">
            <label className="field">
              <span>Game</span>
              <select className="select" value={f.game} onChange={(e) => set('game', e.target.value)}>
                {GAME_SLUGS.map((g) => (
                  <option key={g} value={g}>
                    {GAME_MODULES[g].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ gridColumn: 'span 2' }}>
              <span>{['football', 'baseball', 'basketball', 'hockey'].includes(f.game) ? 'Player / card name' : 'Name'}</span>
              <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label className="field">
              <span>Set</span>
              <input className="input" list="sets-dl" value={f.setName} onChange={(e) => set('setName', e.target.value)} />
              <datalist id="sets-dl">
                {sets.data?.sets.map((s) => (
                  <option key={s.id} value={s.name} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Number</span>
              <input className="input mono" value={f.collectorNumber} onChange={(e) => set('collectorNumber', e.target.value)} />
            </label>
            <label className="field">
              <span>Variant</span>
              <select className="select" value={f.variant} onChange={(e) => set('variant', e.target.value)}>
                {VARIANT_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/_/g, ' ').toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rarity</span>
              <input className="input" value={f.rarity} onChange={(e) => set('rarity', e.target.value)} />
            </label>
            <label className="field">
              <span>Condition</span>
              <select className="select" value={f.condition} onChange={(e) => set('condition', e.target.value)}>
                {CONDITIONS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>

          {!picked && (search.data?.items.length ?? 0) > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Catalog matches</h3>
              {search.data!.items.slice(0, 5).map((c) => (
                <button
                  key={c.id}
                  className="cand"
                  onClick={() => choose({ id: c.id, name: c.name, set: c.set?.name ?? null, number: c.collectorNumber, rarity: c.rarity, game: c.game.slug, variants: c.variants.map((v) => v.type) })}
                >
                  {c.imageUrl ? <img src={c.imageUrl} alt="" /> : <div style={{ width: 40, height: 56, background: '#222', borderRadius: 4 }} />}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong className="truncate">{c.name}</strong>
                    <div className="faint truncate" style={{ fontSize: 13 }}>
                      {c.set?.name} · {c.collectorNumber}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="faint" style={{ fontSize: 13 }}>
            {picked ? '✓ Linked to an existing catalog card.' : 'No catalog card selected — a new catalog entry will be created from these fields.'}
          </div>
          {err && <div className="error-text">{err}</div>}
          <div className="row between">
            <button className="btn danger" onClick={() => void reject()}>
              Reject scan
            </button>
            <button className="btn primary lg" disabled={busy || !f.name.trim()} onClick={() => void resolve()}>
              {review.reason === 'VERIFY' && picked ? 'Confirm & research' : 'Save & research'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
