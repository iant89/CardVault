import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CONDITIONS, VARIANT_TYPES } from '@cardvault/shared';
import { api, money, qs } from '../../services/api';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useLive } from '../../stores/live';
import { useSession } from '../../stores/session';
import { ThemeScene } from '../../components/ThemeScene';
import { TiltCard } from '../../components/TiltCard';
import { Empty, Loading, Trend } from '../../components/ui';
import { CardDetailDialog } from '../cards/CardDetailDialog';
import type { CollectionItem, UserDTO } from '../../types';

const GAMES = [
  { slug: '', label: 'All' },
  { slug: 'pokemon', label: 'Pokémon' },
  { slug: 'magic', label: 'Magic' },
  { slug: 'yugioh', label: 'Yu-Gi-Oh!' },
  { slug: 'sports', label: 'Sports' },
  { slug: 'football', label: 'Football' },
  { slug: 'baseball', label: 'Baseball' },
  { slug: 'basketball', label: 'Basketball' },
  { slug: 'hockey', label: 'Hockey' },
];

interface ListResult {
  items: CollectionItem[];
  total: number;
  totalValue: number;
}

export default function CollectionPage() {
  const me = useSession((s) => s.user!);
  const [params, setParams] = useSearchParams();
  const game = params.get('game') ?? '';
  const userParam = params.get('user') ?? me.id;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [variant, setVariant] = useState('');
  const [condition, setCondition] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [open, setOpen] = useState<CollectionItem | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { revision, lastEvent } = useLive();

  const users = useAsync(() => api.get<{ users: UserDTO[] }>('/api/users'), []);
  const filters = { user: userParam, game, q: dq, sort, variant, condition, minPrice, favorite, page, pageSize: 60 };
  const list = useAsync(() => api.get<ListResult>(`/api/collection${qs(filters)}`), [JSON.stringify(filters)]);
  const items = useMemo(() => list.data?.items ?? [], [list.data]);

  // live updates: refetch and briefly highlight the card that changed
  useEffect(() => {
    if (!revision) return;
    list.reload();
    if (lastEvent?.cardId) {
      setFlash(lastEvent.cardId);
      const t = setTimeout(() => setFlash(null), 1300);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // deep link ?card=<id>
  useEffect(() => {
    const cid = params.get('card');
    if (cid && items.length) {
      const it = items.find((i) => i.card.id === cid);
      if (it) setOpen(it);
    }
  }, [params, items]);
  useEffect(() => setPage(1), [game, dq, sort, variant, condition, minPrice, favorite, userParam]);

  const setGame = (g: string) => {
    const p = new URLSearchParams(params);
    if (g) p.set('game', g);
    else p.delete('game');
    p.delete('card');
    setParams(p, { replace: true });
  };
  const setUser = (u: string) => {
    const p = new URLSearchParams(params);
    p.set('user', u);
    setParams(p, { replace: true });
  };
  const owner = users.data?.users.find((u) => u.id === userParam);
  const sceneGame = game === 'sports' ? 'football' : game;
  const pages = list.data ? Math.ceil(list.data.total / 60) : 1;

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>{owner && owner.id !== me.id ? `${owner.displayName}'s collection` : userParam === 'all' ? 'Family collection' : 'My collection'}</h1>
          <p>
            {list.data ? (
              <>
                {list.data.total} cards · <strong style={{ color: 'var(--text)' }}>{money(list.data.totalValue)}</strong>
              </>
            ) : (
              ' '
            )}
          </p>
        </div>
        <div className="row wrap">
          <select className="select" style={{ width: 'auto' }} value={userParam} onChange={(e) => setUser(e.target.value)} aria-label="Owner">
            {users.data?.users
              .filter((u) => u.active !== false)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === me.id ? 'Mine' : u.displayName}
                </option>
              ))}
            <option value="all">Everyone</option>
          </select>
          <Link to="/scan" className="btn primary">
            ◉ Scan cards
          </Link>
        </div>
      </div>

      <div className="chip-row">
        {GAMES.map((g) => (
          <button key={g.slug} className={`chip ${game === g.slug ? 'on' : ''}`} onClick={() => setGame(g.slug)}>
            {g.label}
          </button>
        ))}
      </div>

      <div className="filters">
        <input className="input search" placeholder="Search name, set, number, notes…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`chip show-mobile ${showFilters ? 'on' : ''}`} onClick={() => setShowFilters((v) => !v)}>
          ⚙ Filters
        </button>
        <div className={`filters-extra ${showFilters ? 'open' : ''}`}>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="recent">Recently added</option>
          <option value="value">Highest value</option>
          <option value="trend">Biggest gainers</option>
          <option value="name">Name</option>
          <option value="number">Set & number</option>
        </select>
        <select className="select" value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="Variant">
          <option value="">Any variant</option>
          {VARIANT_TYPES.map((v) => (
            <option key={v} value={v}>
              {v.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
        <select className="select" value={condition} onChange={(e) => setCondition(e.target.value)} aria-label="Condition">
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select className="select" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} aria-label="Minimum value">
          <option value="">Any value</option>
          {[5, 20, 50, 100, 500].map((p) => (
            <option key={p} value={p}>
              ≥ ${p}
            </option>
          ))}
        </select>
        <button className={`chip ${favorite ? 'on' : ''}`} onClick={() => setFavorite((f) => !f)}>
          ★ Favorites
        </button>
        </div>
      </div>

      <ThemeScene game={sceneGame}>
        {list.loading && !list.data ? (
          <Loading />
        ) : !items.length ? (
          <Empty icon="🃏" title="No cards here yet">
            <Link to="/scan">Scan your first card</Link>
          </Empty>
        ) : (
          <div className="card-grid">
            {items.map((it) => (
              <div key={it.id}>
                <TiltCard
                  image={it.card.imageUrl ?? it.scanThumbnail}
                  name={it.card.name}
                  subtitle={it.card.collectorNumber}
                  variant={it.variant?.type}
                  quantity={it.quantity}
                  game={it.card.game.slug}
                  flash={flash === it.card.id}
                  onOpen={() => setOpen(it)}
                />
                <div className="tcard-meta">
                  <span className="n truncate">
                    {it.favorite ? '★ ' : ''}
                    {it.card.name}
                  </span>
                  <span className="s truncate">
                    {it.card.set?.name ?? it.card.game.name} · {it.card.collectorNumber}
                    {userParam === 'all' ? ` · ${it.ownerName}` : ''}
                  </span>
                  <span className="p">
                    <span>{money(it.unitValue)}</span>
                    <span style={{ fontSize: 12 }}>
                      <Trend value={it.trend30d} />
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {pages > 1 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span className="faint">
              Page {page} / {pages}
            </span>
            <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </div>
        )}
      </ThemeScene>

      <CardDetailDialog
        cardId={open?.card.id ?? null}
        item={open}
        onClose={() => {
          setOpen(null);
          if (params.get('card')) {
            const p = new URLSearchParams(params);
            p.delete('card');
            setParams(p, { replace: true });
          }
        }}
        onChanged={() => list.reload()}
      />
    </div>
  );
}
