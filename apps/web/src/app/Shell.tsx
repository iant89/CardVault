import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useSession } from '../stores/session';
import { useLive, ACTIVE_STATES } from '../stores/live';
import { Avatar, Toasts } from '../components/ui';
import { JobMonitor } from '../features/queue/JobMonitor';
import { useOfflineQueue } from '../features/scanner/offlineQueue';

const NAV = [
  { to: '/', label: 'Home', ico: '⌂', end: true },
  { to: '/collection', label: 'Collection', ico: '▦' },
  { to: '/scan', label: 'Scan', ico: '◉', cls: 'scan' },
  { to: '/queue', label: 'Queue', ico: '≡' },
  { to: '/review', label: 'Manual Review', short: 'Review', ico: '!' },
  { to: '/search', label: 'Search', ico: '⌕' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const { connect, counts, jobs, connected } = useLive();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  const startUploader = useOfflineQueue((s) => s.start);

  useEffect(() => connect(), [connect]);
  useEffect(() => startUploader(), [startUploader]);
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const review = jobs.filter((j) => j.status === 'MANUAL_REVIEW').length || counts.MANUAL_REVIEW || 0;
  const active = jobs.filter((j) => ACTIVE_STATES.includes(j.status) || j.status === 'QUEUED').length;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" /> CARDVAULT
        </Link>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
              {n.to === '/review' && review > 0 && <span className="count">{review}</span>}
              {n.to === '/queue' && active > 0 && <span className="count" style={{ background: 'var(--accent)' }}>{active}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <span className="hide-mobile faint" title={connected ? 'Live updates connected' : 'Reconnecting…'}>
          <span className={`dot ${connected ? 'good' : 'warn pulse'}`} />
        </span>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button className="user-chip" onClick={() => setMenu((m) => !m)} aria-haspopup="menu">
            <Avatar name={user!.displayName} avatar={user!.avatar} size={28} />
            <span className="hide-mobile">{user!.displayName}</span>
          </button>
          {menu && (
            <div className="menu" role="menu">
              <Link to="/profile">Profile & password</Link>
              {user!.role === 'ADMIN' && (
                <>
                  <hr />
                  <Link to="/admin/users">Users</Link>
                  <Link to="/admin/system">Providers · Workers · System</Link>
                </>
              )}
              <hr />
              <button onClick={() => void logout()}>Sign out</button>
            </div>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
      {loc.pathname !== '/queue' && loc.pathname !== '/scan' && <JobMonitor />}
      <nav className="bottom-nav">
        {NAV.filter((n) => n.to !== '/search').map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={n.cls}>
            <span className="ico">{n.ico}</span>
            {n.short ?? n.label}
          </NavLink>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
