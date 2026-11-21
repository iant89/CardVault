import { useEffect, useState } from 'react';
import { CONDITIONS, VARIANT_TYPES } from '@cardvault/shared';
import { api, ApiError, money } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { useSession } from '../../stores/session';
import { useLive } from '../../stores/live';
import { toast } from '../../stores/toasts';
import { Dialog, Trend } from '../../components/ui';
import { TiltCard } from '../../components/TiltCard';
import { PriceHistoryChart, type HistoryPoint } from '../pricing/PriceHistoryChart';
import { GameFields } from './GameFields';
import type { CardDTO, CollectionItem, MarketSummary } from '../../types';

interface Props {
  cardId: string | null;
  item?: CollectionItem | null;
  onClose: () => void;
  onChanged?: () => void;
  /** tab to show when opened (e.g. 'copy' to jump straight to editing) */
  initialTab?: 'price' | 'details' | 'sales' | 'copy';
}

interface Sale {
  id: string;
  source: string;
  price: number;
  shipping: number | null;
  sale_type: string;
  title: string | null;
  url: string | null;
  observed_at: string;
  variant: string | null;
  condition: string | null;
}

export function CardDetailDialog({ cardId, item, onClose, onChanged, initialTab }: Props) {
  const me = useSession((s) => s.user!);
  const revision = useLive((s) => s.revision);
  const [variantId, setVariantId] = useState<string | undefined>(item?.variant?.id);
  const [tab, setTab] = useState<'price' | 'details' | 'sales' | 'copy'>('price');
  useEffect(() => {
    setVariantId(item?.variant?.id);
    setTab(initialTab ?? 'price');
  }, [cardId, item, initialTab]);

  const card = useAsync(() => (cardId ? api.get<{ card: CardDTO; owners: { display_name: string; quantity: number; variant: string | null; condition: string }[] }>(`/api/cards/${cardId}`) : Promise.resolve(null)), [cardId, revision]);
  const v = variantId ? `&variantId=${variantId}` : '';
  const prices = useAsync(() => (cardId ? api.get<{ summary: MarketSummary; sources: string[]; observationCount: number }>(`/api/cards/${cardId}/prices?days=365${v}`) : Promise.resolve(null)), [cardId, variantId, revision]);
  const history = useAsync(() => (cardId ? api.get<{ history: HistoryPoint[] }>(`/api/cards/${cardId}/history?days=365${v}`) : Promise.resolve(null)), [cardId, variantId, revision]);
  const sales = useAsync(() => (cardId && tab === 'sales' ? api.get<{ sales: Sale[] }>(`/api/cards/${cardId}/sales?limit=60${v}`) : Promise.resolve(null)), [cardId, variantId, tab, revision]);

  const c = card.data?.card;
  const s = prices.data?.summary;
  const canEdit = item && (item.userId === me.id || me.role === 'ADMIN');

  const research = async () => {
    try {
      await api.post(`/api/cards/${cardId}/research`);
      toast('Research queued — results arrive live', 'info');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };

  return (
    <Dialog open={!!cardId} onClose={onClose}>
      {!c ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : (
        <div className="detail">
          <div className="stack">
            <TiltCard image={c.imageUrl ?? item?.scanThumbnail ?? null} name={c.name} subtitle={c.collectorNumber} variant={item?.variant?.type} size="large" game={c.game.slug} />
            {item?.scanThumbnail && c.imageUrl && (
              <details>
                <summary className="faint" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Show my scan
                </summary>
                <img src={item.scanThumbnail} alt="Your scan" style={{ borderRadius: 10, marginTop: 8 }} />
              </details>
            )}
            {card.data!.owners.length > 0 && (
              <div className="panel tight">
                <h3 style={{ marginBottom: 6 }}>Owned by</h3>
                {card.data!.owners.map((o, i) => (
                  <div key={i} className="row between" style={{ fontSize: 14 }}>
                    <span>{o.display_name}</span>
                    <span className="faint">
                      ×{o.quantity} {o.variant?.toLowerCase().replace(/_/g, ' ')} · {o.condition}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="stack lg" style={{ minWidth: 0 }}>
            <div>
              <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
                <span className="badge accent">{c.game.name}</span>
                {c.rarity && <span className="badge">{c.rarity}</span>}
                {item?.variant && <span className="badge">{item.variant.type.replace(/_/g, ' ')}</span>}
                {item?.grading?.status === 'GRADED' && (
                  <span className="badge good">
                    {item.grading.company} {item.grading.grade}
                  </span>
                )}
              </div>
              <div className="detail-title">{c.name}</div>
              <div className="muted">
                {c.set?.name ?? 'Unknown set'} · <span className="mono">{c.collectorNumber || '—'}</span>
                {c.set?.releaseDate ? ` · ${c.set.releaseDate.slice(0, 4)}` : ''}
              </div>
            </div>

            <div className="market">
              <h3>Market value</h3>
              <div className="big">{money(s?.marketPrice ?? c.price?.market)}</div>
              <div style={{ fontWeight: 700 }}>
                <Trend value={s?.trend30d ?? c.price?.trend30d} /> <span className="faint">/ 30 days</span>
              </div>
              {c.variants.length > 1 && (
                <div className="row wrap" style={{ justifyContent: 'center', marginTop: 10, gap: 6 }}>
                  <button className={`chip ${!variantId ? 'on' : ''}`} onClick={() => setVariantId(undefined)}>
                    All
                  </button>
                  {c.variants.map((vv) => (
                    <button key={vv.id} className={`chip ${variantId === vv.id ? 'on' : ''}`} onClick={() => setVariantId(vv.id)}>
                      {vv.type.replace(/_/g, ' ').toLowerCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="tabs">
              {(['price', 'details', 'sales', ...(canEdit ? (['copy'] as const) : [])] as const).map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                  {{ price: 'Price history', details: 'Card details', sales: 'Recent sales', copy: 'My copy' }[t]}
                </button>
              ))}
            </div>

            {tab === 'price' && (
              <div className="stack">
                <PriceHistoryChart data={history.data?.history ?? []} />
                {s && (
                  <dl className="kv" style={{ margin: 0 }}>
                    <div>
                      <dt>Recent sold median</dt>
                      <dd>{money(s.recentSoldMedian)}</dd>
                    </div>
                    <div>
                      <dt>Recent sold avg</dt>
                      <dd>{money(s.recentSoldAverage)}</dd>
                    </div>
                    <div>
                      <dt>Listed median</dt>
                      <dd>{money(s.listed.median)}</dd>
                    </div>
                    <div>
                      <dt>30 / 90 day avg</dt>
                      <dd>
                        {money(s.avg30d, 0)} / {money(s.avg90d, 0)}
                      </dd>
                    </div>
                    <div>
                      <dt>1-year avg</dt>
                      <dd>{money(s.avg1y)}</dd>
                    </div>
                    <div>
                      <dt>Range (sold)</dt>
                      <dd>
                        {money(s.sold.min, 0)} – {money(s.sold.max, 0)}
                      </dd>
                    </div>
                    <div>
                      <dt>Volatility</dt>
                      <dd>{s.volatility == null ? '—' : `${(s.volatility * 100).toFixed(0)}%`}</dd>
                    </div>
                    <div>
                      <dt>Observations</dt>
                      <dd>
                        {prices.data!.observationCount} <span className="faint" style={{ fontSize: 12 }}>({prices.data!.sources.join(', ') || 'none'})</span>
                      </dd>
                    </div>
                  </dl>
                )}
                <div className="row between">
                  <span className="faint" style={{ fontSize: 13 }}>
                    {c.lastResearchedAt ? `Researched ${new Date(c.lastResearchedAt).toLocaleString()}` : 'Not researched yet'}
                  </span>
                  <button className="btn sm" onClick={() => void research()}>
                    ↻ Research now
                  </button>
                </div>
              </div>
            )}

            {tab === 'details' && (
              <div className="stack">
                <GameFields game={c.game.slug} metadata={c.metadata} />
                <dl className="kv" style={{ margin: 0 }}>
                  {c.artist && (
                    <div>
                      <dt>Artist</dt>
                      <dd>{c.artist}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Variants</dt>
                    <dd>{c.variants.map((x) => x.type.replace(/_/g, ' ').toLowerCase()).join(', ') || '—'}</dd>
                  </div>
                  {Object.keys(c.externalIds).length > 0 && (
                    <div className="wide">
                      <dt>Sources</dt>
                      <dd className="mono" style={{ fontSize: 12 }}>
                        {Object.entries(c.externalIds)
                          .map(([k, val]) => `${k}:${val}`)
                          .join('  ')}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {tab === 'sales' && (
              <div className="table-wrap">
                {!sales.data?.sales.length ? (
                  <div className="empty faint">No individual sales or listings recorded yet.</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Source</th>
                        <th style={{ textAlign: 'right' }}>Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sales.data.sales.map((x) => (
                        <tr key={x.id}>
                          <td className="faint">{new Date(x.observed_at).toLocaleDateString()}</td>
                          <td>
                            <span className={`badge ${x.sale_type === 'SOLD' || x.sale_type === 'AUCTION' ? 'good' : ''}`}>{x.sale_type.toLowerCase().replace(/_/g, ' ')}</span>
                          </td>
                          <td className="truncate" style={{ maxWidth: 280 }}>
                            {x.url ? (
                              <a href={x.url} target="_blank" rel="noreferrer noopener">
                                {x.title ?? x.source}
                              </a>
                            ) : (
                              (x.title ?? x.source)
                            )}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }}>
                            {money(x.price)}
                            {x.shipping ? <div className="faint" style={{ fontSize: 11 }}>+{money(x.shipping)} ship</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {tab === 'copy' && item && <CopyEditor item={item} card={c} onSaved={() => onChanged?.()} onDeleted={() => (onChanged?.(), onClose())} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function CopyEditor({ item, card, onSaved, onDeleted }: { item: CollectionItem; card: CardDTO; onSaved: () => void; onDeleted: () => void }) {
  const [f, setF] = useState({
    variantType: item.variant?.type ?? card.variants[0]?.type ?? 'NORMAL',
    condition: item.condition,
    quantity: item.quantity,
    purchasePrice: item.purchasePrice ?? '',
    purchaseDate: item.purchaseDate ?? '',
    notes: item.notes ?? '',
    favorite: item.favorite,
    graded: item.grading?.status === 'GRADED',
    company: item.grading?.company ?? 'PSA',
    grade: item.grading?.grade ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/collection/${item.id}`, {
        variantType: f.variantType,
        condition: f.condition,
        quantity: Number(f.quantity),
        purchasePrice: f.purchasePrice === '' ? null : Number(f.purchasePrice),
        purchaseDate: f.purchaseDate || null,
        notes: f.notes || null,
        favorite: f.favorite,
        grading: f.graded ? { status: 'GRADED', company: f.company, grade: f.grade } : { status: 'RAW' },
      });
      toast('Saved', 'success');
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove this copy of ${card.name} from your collection?`)) return;
    await api.del(`/api/collection/${item.id}`);
    toast('Removed', 'info');
    onDeleted();
  };
  const variants = [...new Set([...card.variants.map((v) => v.type), ...VARIANT_TYPES])];
  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field">
          <span>Variant</span>
          <select className="select" value={f.variantType} onChange={(e) => set('variantType', e.target.value)}>
            {variants.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Condition</span>
          <select className="select" value={f.condition} onChange={(e) => set('condition', e.target.value)}>
            {CONDITIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Quantity</span>
          <input className="input" type="number" min={1} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} />
        </label>
        <label className="field">
          <span>Purchase price</span>
          <input className="input" type="number" min={0} step="0.01" value={f.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} />
        </label>
        <label className="field">
          <span>Purchase date</span>
          <input className="input" type="date" value={f.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        <label className="checkbox">
          <input type="checkbox" checked={f.graded} onChange={(e) => set('graded', e.target.checked)} /> Graded
        </label>
        {f.graded && (
          <>
            <select className="select" style={{ width: 110 }} value={f.company} onChange={(e) => set('company', e.target.value)}>
              {['PSA', 'BGS', 'CGC', 'SGC', 'OTHER'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input className="input" style={{ width: 90 }} placeholder="Grade" value={f.grade} onChange={(e) => set('grade', e.target.value)} />
          </>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={f.favorite} onChange={(e) => set('favorite', e.target.checked)} /> ★ Favorite
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
      </label>
      <div className="row between">
        <button className="btn danger" onClick={() => void remove()}>
          Remove copy
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}
