import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, money } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { useLive, ACTIVE_STATES } from '../../stores/live';
import { useSession } from '../../stores/session';
import { Empty, Loading, StatusBadge } from '../../components/ui';
import { TiltCard } from '../../components/TiltCard';
import { themeFor } from '../../themes';

interface Summary {
  totalValue: number;
  changeMonth: number | null;
  historical: { today: number; d7: number | null; d30: number | null; d90: number | null };
  byGame: { slug: string; name: string; items: number; copies: number; value: number }[];
  sets: { setId: string; name: string; game: string; ownedUnique: number; totalCards: number | null; completion: number | null; value: number }[];
  history: { day: string; value: number }[];
  jobs: Record<string, number>;
  recentScans: { id: string; status: string; cardId: string | null; name: string | null; image: string | null }[];
}

const SPORTS = ['football', 'baseball', 'basketball', 'hockey'];

export default function HomePage() {
  const user = useSession((s) => s.user!);
  const revision = useLive((s) => s.revision);
  const jobs = useLive((s) => s.jobs);
  const nav = useNavigate();
  const { data, loading, reload } = useAsync(() => api.get<Summary>('/api/collection/summary'), []);
  const family = useAsync(() => api.get<{ users: { userId: string; displayName: string; total: number }[] }>('/api/collection/value-by-user'), []);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (revision) {
      reload();
      family.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  useEffect(() => setTick((t) => t + 1), [jobs]);

  if (loading && !data) return <Loading />;
  if (!data) return null;

  // Game tiles: Pokémon / Magic / Sports (combined) / Yu-Gi-Oh
  const g = (slug: string) => data.byGame.find((x) => x.slug === slug);
  const sports = data.byGame.filter((x) => SPORTS.includes(x.slug));
  const tiles = [
    { key: 'pokemon', name: 'Pokémon', value: g('pokemon')?.value ?? 0, n: g('pokemon')?.copies ?? 0 },
    { key: 'magic', name: 'Magic', value: g('magic')?.value ?? 0, n: g('magic')?.copies ?? 0 },
    { key: 'sports', name: 'Sports', value: sports.reduce((a, s) => a + s.value, 0), n: sports.reduce((a, s) => a + s.copies, 0) },
    { key: 'yugioh', name: 'Yu-Gi-Oh!', value: g('yugioh')?.value ?? 0, n: g('yugioh')?.copies ?? 0 },
  ];
  const other = g('other');
  if (other?.copies) tiles.push({ key: 'other', name: 'Other', value: other.value, n: other.copies });

  // processing summary over the last 7 days
  const live = jobs.filter((j) => ACTIVE_STATES.includes(j.status) || j.status === 'QUEUED').length;
  const review = jobs.filter((j) => j.status === 'MANUAL_REVIEW').length;
  const complete = data.jobs.COMPLETED ?? 0;
  const totalJobs = live + review + complete + (data.jobs.FAILED ?? 0);
  const pctDone = totalJobs ? Math.round(((complete + review) / totalJobs) * 100) : 100;

  const changes = [
    { label: 'Today', v: data.historical.today },
    { label: '7 days', v: data.historical.d7 },
    { label: '30 days', v: data.historical.d30 },
    { label: '90 days', v: data.historical.d90 },
  ];

  return (
    <div className="stack lg">
      <div className="panel" style={{ padding: 26, overflow: 'hidden', position: 'relative' }}>
        <div className="grid-2" style={{ alignItems: 'center' }}>
          <div>
            <h3>Collection value · {user.displayName}</h3>
            <div className="hero-value" style={{ marginTop: 8 }}>
              {money(data.totalValue)}
            </div>
            <div style={{ marginTop: 8, fontWeight: 700 }}>
              {data.changeMonth == null ? (
                <span className="faint">Value history builds up as prices are researched daily.</span>
              ) : (
                <span className={data.changeMonth >= 0 ? 'up' : 'down'}>
                  {data.changeMonth >= 0 ? '▲' : '▼'} {money(Math.abs(data.changeMonth))} this month
                </span>
              )}
            </div>
            <div className="row wrap" style={{ marginTop: 14, gap: 18 }}>
              {changes.map((c) => (
                <div key={c.label}>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {c.label}
                  </div>
                  <div style={{ fontWeight: 700 }}>{money(c.v, 0)}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ height: 150 }}>
            {data.history.length > 1 ? (
              <ResponsiveContainer>
                <AreaChart data={data.history}>
                  <defs>
                    <linearGradient id="hv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#6ea8ff" stopOpacity={0.5} />
                      <stop offset="1" stopColor="#6ea8ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="day" hide />
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ background: '#161d2c', border: '1px solid #2a3550', borderRadius: 10 }} />
                  <Area type="monotone" dataKey="value" stroke="#6ea8ff" strokeWidth={2} fill="url(#hv)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty faint" style={{ padding: 20 }}>
                Chart appears after a couple of days of history.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="stats">
        {tiles.map((t) => (
          <div key={t.key} className="stat link" onClick={() => nav(`/collection?game=${t.key}`)}>
            <div className="glow" style={{ background: themeFor(t.key === 'sports' ? 'football' : t.key).accent }} />
            <div className="label">{t.name}</div>
            <div className="value">{money(t.value, 0)}</div>
            <div className="sub">{t.n} {t.n === 1 ? 'card' : 'cards'}</div>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h3>Recently scanned</h3>
            <Link to="/scan" className="btn sm primary">
              ◉ Scan
            </Link>
          </div>
          {data.recentScans.length ? (
            <div className="card-grid" style={{ ['--card-w' as string]: '110px', gap: 14 }}>
              {data.recentScans.slice(0, 10).map((s) => (
                <div key={s.id}>
                  <TiltCard image={s.image} name={s.name ?? 'Unidentified'} onOpen={() => nav(s.cardId ? `/collection?card=${s.cardId}` : '/review')} />
                  <div className="tcard-meta">
                    <span className="s truncate">{s.name ?? '—'}</span>
                    <StatusBadge status={s.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="◉" title="No scans yet">
              Point → Scan → Done. <Link to="/scan">Start scanning</Link>
            </Empty>
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>Processing</h3>
              <Link to="/queue" style={{ fontSize: 13 }}>
                Queue →
              </Link>
            </div>
            <div className="progress big">
              <div style={{ width: `${pctDone}%` }} />
            </div>
            <div className="row between" style={{ marginTop: 10, fontSize: 14 }}>
              <span>
                <strong>{live}</strong> <span className="muted">Processing</span>
              </span>
              <Link to="/review">
                <strong>{review}</strong> <span className="muted">Manual review</span>
              </Link>
              <span>
                <strong>{complete}</strong> <span className="muted">Complete</span>
              </span>
            </div>
          </div>

          {family.data && family.data.users.length > 1 && (
            <div className="panel">
              <div className="panel-head">
                <h3>Family collections</h3>
              </div>
              <table className="table">
                <tbody>
                  {family.data.users.map((u) => (
                    <tr key={u.userId}>
                      <td>
                        <Link to={`/collection?user=${u.userId}`}>{u.displayName}</Link>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(u.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.sets.length > 0 && (
            <div className="panel">
              <div className="panel-head">
                <h3>Set completion</h3>
              </div>
              <div className="stack" style={{ gap: 10 }}>
                {data.sets.slice(0, 6).map((s) => (
                  <div key={s.setId}>
                    <div className="row between" style={{ fontSize: 14 }}>
                      <span className="truncate">{s.name}</span>
                      <span className="faint">
                        {s.ownedUnique}
                        {s.totalCards ? ` / ${s.totalCards}` : ''} · {money(s.value, 0)}
                      </span>
                    </div>
                    {s.completion != null && (
                      <div className="progress" style={{ marginTop: 4 }}>
                        <div style={{ width: `${Math.min(100, s.completion)}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
