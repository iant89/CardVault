import { useEffect } from 'react';
import { api, ApiError } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Loading } from '../../components/ui';
import { toast } from '../../stores/toasts';

interface System {
  api: { ok: boolean; uptimeSec: number; version: string };
  database: { ok: boolean; latencyMs: number; error?: string; stats?: { cards: number; items: number; observations: number; scans: number; bytes: string } };
  redis: { ok: boolean; latencyMs: number; error?: string };
  workers: { id: string; hostname: string; pid: number; version: string; lastHeartbeat: string; jobsProcessed: number; jobsFailed: number; online: boolean; startedAt: string }[];
  queues: Record<string, Record<string, number>>;
  manualReviewOpen: number;
  storage: { totalBytes: number; freeBytes: number } | null;
}
interface Provider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  configured: boolean;
  circuitState: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  requestCount: number;
  errorCount: number;
  rateLimit: string | null;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const Status = ({ ok, label, extra }: { ok: boolean; label: string; extra?: string }) => (
  <div className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
    <strong style={{ letterSpacing: '.06em' }}>{label}</strong>
    <span className="row" style={{ gap: 8 }}>
      <span className="faint" style={{ fontSize: 13 }}>
        {extra}
      </span>
      <span className={`dot ${ok ? 'good' : 'bad'}`} /> {ok ? 'ONLINE' : 'OFFLINE'}
    </span>
  </div>
);

export default function SystemPage() {
  const sys = useAsync(() => api.get<System>('/api/admin/system'), []);
  const prov = useAsync(() => api.get<{ providers: Provider[] }>('/api/admin/providers'), []);
  useEffect(() => {
    const t = setInterval(() => {
      sys.reload();
      prov.reload();
    }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success');
      sys.reload();
      prov.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };

  if (!sys.data) return <Loading />;
  const s = sys.data;
  const anyWorker = s.workers.some((w) => w.online);
  const qLabel: Record<string, string> = { identification: 'Identification', research: 'Research', pricing: 'Pricing', image: 'Images', maintenance: 'Maintenance' };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>System</h1>
          <p>Health, queues, workers and data providers.</p>
        </div>
        <button className="btn" onClick={() => void act(() => api.post('/api/admin/research/refresh', { limit: 500 }), 'Research refresh queued')}>
          ↻ Refresh all prices
        </button>
      </div>
      <div className="grid-2">
        <div className="panel">
          <h3 style={{ marginBottom: 6 }}>System status</h3>
          <Status ok label="API" extra={`up ${Math.round(s.api.uptimeSec / 60)} min`} />
          <Status ok={s.database.ok} label="DATABASE" extra={s.database.ok ? `${s.database.latencyMs} ms` : s.database.error} />
          <Status ok={s.redis.ok} label="REDIS" extra={s.redis.ok ? `${s.redis.latencyMs} ms` : s.redis.error} />
          <Status ok={anyWorker} label="WORKER" extra={`${s.workers.filter((w) => w.online).length} online`} />
          {s.database.stats && (
            <div className="row wrap faint" style={{ marginTop: 12, fontSize: 13, gap: 16 }}>
              <span>{s.database.stats.cards} catalog cards</span>
              <span>{s.database.stats.items} collection items</span>
              <span>{s.database.stats.observations} price observations</span>
              <span>{s.database.stats.scans} scans</span>
              <span>DB {gb(Number(s.database.stats.bytes))}</span>
              {s.storage && <span>Storage free {gb(s.storage.freeBytes)}</span>}
            </div>
          )}
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 6 }}>Queues</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Waiting</th>
                <th>Active</th>
                <th>Failed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.queues).map(([name, c]) => (
                <tr key={name}>
                  <td>{qLabel[name] ?? name}</td>
                  <td>{(c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0)}</td>
                  <td>{c.active ?? 0}</td>
                  <td className={c.failed ? 'down' : ''}>{c.failed ?? 0}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(c.failed ?? 0) > 0 && (
                      <button className="btn sm" onClick={() => void act(() => api.post(`/api/admin/queues/${name}/retry-failed`), 'Retrying failed jobs')}>
                        Retry failed
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Manual review</td>
                <td>{s.manualReviewOpen}</td>
                <td />
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginBottom: 10 }}>Workers</h3>
        {!s.workers.length ? (
          <div className="faint">No worker has checked in yet. Start one with `pnpm dev:worker` or the cardvault-worker container.</div>
        ) : (
          <div className="stats">
            {s.workers.map((w) => (
              <div className="stat" key={w.id}>
                <div className="label">
                  <span className={`dot ${w.online ? 'good' : 'bad'}`} /> {w.hostname}
                </div>
                <div className="value" style={{ fontSize: 18 }}>
                  {w.online ? 'Online' : 'Offline'}
                </div>
                <div className="sub">
                  {w.jobsProcessed} jobs processed · {w.jobsFailed} failed
                </div>
                <div className="sub faint">
                  pid {w.pid} · v{w.version} · seen {new Date(w.lastHeartbeat).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel table-wrap">
        <h3 style={{ marginBottom: 10 }}>Providers</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="hide-mobile">Type</th>
              <th className="hide-mobile">Rate limit</th>
              <th>Health</th>
              <th className="hide-mobile">Requests</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {prov.data?.providers.map((p) => {
              const healthy = p.configured && p.enabled && p.circuitState === 'CLOSED';
              return (
                <tr key={p.id}>
                  <td>
                    <span className={`dot ${healthy ? 'good' : p.configured && p.enabled ? 'warn' : ''}`} /> <strong>{p.name}</strong>
                    {p.lastError && (
                      <div className="faint truncate" style={{ fontSize: 12, maxWidth: 360 }} title={p.lastError}>
                        {p.lastError}
                      </div>
                    )}
                  </td>
                  <td className="hide-mobile faint">{p.type.toLowerCase().replace(/_/g, ' ')}</td>
                  <td className="hide-mobile mono faint">{p.rateLimit}</td>
                  <td>
                    {!p.configured ? <span className="badge">not configured</span> : p.circuitState === 'CLOSED' ? <span className="badge good">ok</span> : <span className="badge warn">{p.circuitState.toLowerCase()}</span>}
                  </td>
                  <td className="hide-mobile faint">
                    {p.requestCount} / {p.errorCount} err
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {p.configured && (
                      <button className="btn sm" onClick={() => void act(() => api.patch(`/api/admin/providers/${p.id}`, { enabled: !p.enabled }), p.enabled ? 'Disabled' : 'Enabled')}>
                        {p.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="faint" style={{ fontSize: 13, marginTop: 10 }}>
          eBay requires EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. TCGplayer's API is closed to new developers, so CardVault doesn't depend on it.
        </div>
      </div>
    </div>
  );
}
