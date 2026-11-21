import { useState } from 'react';
import { VARIANT_TYPES } from '@cardvault/shared';
import { api, money, qs } from '../../services/api';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { TiltCard } from '../../components/TiltCard';
import { Empty, Loading, Trend } from '../../components/ui';
import { CardDetailDialog } from '../cards/CardDetailDialog';
import type { CardDTO, UserDTO } from '../../types';

const QUICK: { label: string; f: Record<string, string | boolean> }[] = [
  { label: 'Worth > $100', f: { minPrice: '100' } },
  { label: 'Up > 20% (30d)', f: { minTrend: '20' } },
  { label: 'Needs research', f: { needsResearch: true } },
];

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const users = useAsync(() => api.get<{ users: UserDTO[] }>('/api/users'), []);
  const sets = useAsync(() => api.get<{ sets: { id: string; name: string; game: string }[] }>(`/api/sets${qs({ game: f.game })}`), [f.game]);
  const params = { q: dq, ...f, pageSize: 60 };
  const res = useAsync(() => api.get<{ items: CardDTO[]; total: number }>(`/api/cards${qs(params)}`), [JSON.stringify(params)]);
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>Search</h1>
          <p>Every card in the catalog — Pikachu, Black Lotus, Tom Brady, Blue-Eyes…</p>
        </div>
      </div>
      <input className="input" style={{ height: 50, fontSize: 18 }} autoFocus placeholder="Search cards, sets, players…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="filters">
        <select className="select" value={String(f.game ?? '')} onChange={(e) => set('game', e.target.value)} aria-label="Game">
          <option value="">All games</option>
          {['pokemon', 'magic', 'yugioh', 'football', 'baseball', 'basketball', 'hockey', 'other'].map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select className="select" value={String(f.setId ?? '')} onChange={(e) => set('setId', e.target.value)} aria-label="Set">
          <option value="">Any set</option>
          {sets.data?.sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select" value={String(f.variant ?? '')} onChange={(e) => set('variant', e.target.value)} aria-label="Variant">
          <option value="">Any variant</option>
          {VARIANT_TYPES.map((v) => (
            <option key={v} value={v}>
              {v.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
        <input className="input" style={{ width: 110 }} placeholder="Rarity" value={String(f.rarity ?? '')} onChange={(e) => set('rarity', e.target.value)} />
        <input className="input" style={{ width: 100 }} type="number" placeholder="Min $" value={String(f.minPrice ?? '')} onChange={(e) => set('minPrice', e.target.value)} />
        <input className="input" style={{ width: 100 }} type="number" placeholder="Max $" value={String(f.maxPrice ?? '')} onChange={(e) => set('maxPrice', e.target.value)} />
        <input className="input" style={{ width: 90 }} type="number" placeholder="Year" value={String(f.year ?? '')} onChange={(e) => set('year', e.target.value)} />
        <select className="select" value={String(f.owner ?? '')} onChange={(e) => set('owner', e.target.value)} aria-label="Owner">
          <option value="">Any owner</option>
          {users.data?.users.map((u) => (
            <option key={u.id} value={u.id}>
              Owned by {u.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {QUICK.map((x) => (
          <button key={x.label} className="chip" onClick={() => setF((cur) => ({ ...cur, ...x.f }))}>
            {x.label}
          </button>
        ))}
        {Object.keys(f).length > 0 && (
          <button className="chip" onClick={() => setF({})}>
            ✕ Clear filters
          </button>
        )}
      </div>
      {res.loading && !res.data ? (
        <Loading />
      ) : !res.data?.items.length ? (
        <Empty icon="⌕" title="No cards found" />
      ) : (
        <>
          <div className="faint">{res.data.total} results</div>
          <div className="card-grid" style={{ ['--card-w' as string]: '160px' }}>
            {res.data.items.map((c) => (
              <div key={c.id}>
                <TiltCard image={c.imageUrl} name={c.name} subtitle={c.collectorNumber} game={c.game.slug} onOpen={() => setOpen(c.id)} />
                <div className="tcard-meta">
                  <span className="n truncate">{c.name}</span>
                  <span className="s truncate">
                    {c.set?.name ?? c.game.name} · {c.collectorNumber}
                  </span>
                  <span className="p">
                    <span>{money(c.price?.market)}</span>
                    <span style={{ fontSize: 12 }}>
                      <Trend value={c.price?.trend30d} />
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <CardDetailDialog cardId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
