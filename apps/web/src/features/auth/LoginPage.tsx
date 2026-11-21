import { useEffect, useRef, useState } from 'react';
import type { LoginTile } from '@cardvault/shared';
import { api, ApiError } from '../../services/api';
import { useSession } from '../../stores/session';
import { Avatar } from '../../components/ui';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="clock">
      <div className="t">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div className="d">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </div>
  );
}

/** Windows 11–inspired sign-in: pick your tile, then enter your password. */
export function LoginPage() {
  const login = useSession((s) => s.login);
  const [users, setUsers] = useState<LoginTile[]>([]);
  const [sel, setSel] = useState<LoginTile | null>(null);
  const [askPw, setAskPw] = useState(false);
  const [pw, setPw] = useState('');
  const [manual, setManual] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ users: LoginTile[] }>('/api/auth/users')
      .then((r) => {
        setUsers(r.users);
        const last = localStorage.getItem('cv:lastUser');
        setSel(r.users.find((u) => u.username === last) ?? r.users[0] ?? null);
      })
      .catch(() => setMsg('Cannot reach the CardVault server'));
  }, []);
  useEffect(() => {
    if (askPw) pwRef.current?.focus();
  }, [askPw, sel]);

  const submit = async () => {
    const username = sel?.username ?? manual.trim();
    if (!username || !pw) return;
    setBusy(true);
    setMsg('');
    try {
      await login(username, pw);
      try {
        localStorage.setItem('cv:lastUser', username);
      } catch {
        /* private mode */
      }
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Sign-in failed');
      setPw('');
    } finally {
      setBusy(false);
    }
  };

  const pick = (u: LoginTile) => {
    setSel(u);
    setAskPw(true);
    setPw('');
    setMsg('');
  };

  return (
    <div className="login">
      <div className="veil" />
      <Clock />
      <div className="center">
        <div className="brandline">CARDVAULT</div>
        <button className="link-btn tile-ring" onClick={() => sel && pick(sel)} aria-label={sel ? `Sign in as ${sel.displayName}` : 'Sign in'}>
          <Avatar name={sel?.displayName ?? '?'} avatar={sel?.avatar} size={180} />
        </button>
        <div className="name">{sel?.displayName ?? (users.length ? '' : 'Sign in')}</div>
        {!sel && (
          <input className="input" placeholder="Username" value={manual} onChange={(e) => setManual(e.target.value)} style={{ maxWidth: 280 }} autoComplete="username" />
        )}
        {askPw || !sel ? (
          <form
            className="pw"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input ref={pwRef} type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" disabled={busy} aria-label="Password" />
            <button type="submit" disabled={busy} aria-label="Sign in">
              {busy ? <span className="spinner" /> : '→'}
            </button>
          </form>
        ) : (
          <button className="btn" style={{ background: 'rgba(255,255,255,.15)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }} onClick={() => setAskPw(true)}>
            Sign in
          </button>
        )}
        <div className="msg" role="alert">
          {msg}
        </div>
      </div>
      {users.length > 1 && (
        <div className="users">
          {users.map((u) => (
            <button key={u.id} className={sel?.id === u.id ? 'sel' : ''} onClick={() => pick(u)}>
              <Avatar name={u.displayName} avatar={u.avatar} size={40} />
              {u.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
