import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../../services/api';
import { useLive, ACTIVE_STATES } from '../../stores/live';
import { useSession } from '../../stores/session';
import { StatusBadge, Empty } from '../../components/ui';
import { toast } from '../../stores/toasts';
import type { JobDTO } from '../../types';
import { useOfflineQueue } from '../scanner/offlineQueue';

const ago = (d: string | null) => {
  if (!d) return '';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(d).toLocaleDateString();
};

function JobRow({ j, onAction }: { j: JobDTO; onAction: (j: JobDTO, a: 'retry' | 'cancel') => void }) {
  const active = ACTIVE_STATES.includes(j.status);
  return (
    <div className="job">
      <div className="th">{j.thumbnail ? <img src={j.thumbnail} alt="" /> : j.queue === 'research' ? '⌕' : '◉'}</div>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          {active && <span className="dot good pulse" />}
          <strong className="truncate">{j.label ?? 'Scan'}</strong>
          <StatusBadge status={j.status} />
          <span className="badge hide-mobile">{j.queue}</span>
        </div>
        <div className="faint truncate" style={{ fontSize: 13 }}>
          {j.status === 'FAILED' ? <span className="down">{j.error}</span> : j.stage}
          {j.ownerName ? ` · ${j.ownerName}` : ''} · {ago(j.completedAt ?? j.startedAt ?? j.createdAt)}
          {j.attempts > 1 ? ` · attempt ${j.attempts}` : ''}
        </div>
        {active && (
          <div className="progress" style={{ marginTop: 6, maxWidth: 420 }}>
            <div style={{ width: `${j.progress}%` }} />
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {j.status === 'MANUAL_REVIEW' && (
          <Link className="btn sm" to="/review">
            Review
          </Link>
        )}
        {['FAILED', 'CANCELLED'].includes(j.status) && (
          <button className="btn sm" onClick={() => onAction(j, 'retry')}>
            Retry
          </button>
        )}
        {(active || j.status === 'QUEUED') && (
          <button className="btn sm ghost" onClick={() => onAction(j, 'cancel')}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default function QueuePage() {
  const { jobs, refresh, connected } = useLive();
  const admin = useSession((s) => s.user?.role === 'ADMIN');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [all, setAll] = useState<JobDTO[] | null>(null);
  const pending = useOfflineQueue((s) => s.items);
  const retryUpload = useOfflineQueue((s) => s.retry);
  const discardUpload = useOfflineQueue((s) => s.discard);

  useEffect(() => {
    if (scope === 'all') void api.get<{ jobs: JobDTO[] }>('/api/jobs?scope=all&limit=300').then((r) => setAll(r.jobs));
  }, [scope, jobs]);

  const list = scope === 'all' && all ? all : jobs;
  const groups = useMemo(
    () => ({
      processing: list.filter((j) => ACTIVE_STATES.includes(j.status)),
      queued: list.filter((j) => j.status === 'QUEUED'),
      review: list.filter((j) => j.status === 'MANUAL_REVIEW'),
      failed: list.filter((j) => j.status === 'FAILED'),
      done: list.filter((j) => j.status === 'COMPLETED' || j.status === 'CANCELLED'),
    }),
    [list],
  );

  const act = async (j: JobDTO, a: 'retry' | 'cancel') => {
    try {
      await api.post(`/api/jobs/${j.id}/${a}`);
      toast(a === 'retry' ? 'Retry queued' : 'Cancelled', 'info');
      void refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };

  const section = (title: string, items: JobDTO[], icon: string) =>
    items.length > 0 && (
      <div className="panel">
        <div className="panel-head">
          <h3>
            {icon} {title} <span className="faint">({items.length})</span>
          </h3>
        </div>
        {items.slice(0, 60).map((j) => (
          <JobRow key={j.id} j={j} onAction={act} />
        ))}
      </div>
    );

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <p>
            <span className={`dot ${connected ? 'good' : 'warn pulse'}`} /> {connected ? 'Live' : 'Reconnecting…'} — jobs keep running on the server even if you close this page.
          </p>
        </div>
        {admin && (
          <div className="tabs">
            <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>
              Mine
            </button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
              Everyone
            </button>
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>⇪ Waiting to upload ({pending.length})</h3>
          </div>
          <div className="faint" style={{ fontSize: 14 }}>
            These scans are stored on this device and will upload automatically when the server is reachable.
          </div>
          {pending.map((p) => (
            <div key={p.id} className="row between" style={{ gap: 8, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <div style={{ minWidth: 0 }}>
                <strong className="truncate">{new Date(p.capturedAt).toLocaleString()}</strong>
                <div className="faint" style={{ fontSize: 13 }}>
                  {p.status}
                  {p.error ? ` — ${p.error}` : ''}
                  {p.attempts ? ` (attempt ${p.attempts})` : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button className="btn sm" onClick={() => void retryUpload(p.id)}>Retry</button>
                <button className="btn sm ghost" onClick={() => void discardUpload(p.id)}>Discard</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {section('Processing', groups.processing, '●')}
      {section('Queued', groups.queued, '○')}
      {section('Manual review', groups.review, '!')}
      {section('Failed', groups.failed, '✕')}
      {section('Completed', groups.done, '✓')}
      {!list.length && !pending.length && (
        <div className="panel">
          <Empty icon="✓" title="Nothing in the queue">
            <Link to="/scan">Scan some cards</Link> and they'll appear here.
          </Empty>
        </div>
      )}
    </div>
  );
}
