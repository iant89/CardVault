import { useState } from 'react';
import { api, ApiError } from '../../services/api';
import { useSession } from '../../stores/session';
import { Avatar } from '../../components/ui';
import { toast } from '../../stores/toasts';
import type { UserDTO } from '../../types';

const EMOJI = ['🦊', '🐉', '⚡', '🔥', '🌊', '🌿', '🏈', '⚾', '🏀', '🏒', '🃏', '⭐', '🐱', '🐶', '🦄', '🤖'];

export default function ProfilePage() {
  const { user, setUser } = useSession();
  const [displayName, setName] = useState(user!.displayName);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');

  const save = async (patch: Record<string, unknown>) => {
    setErr('');
    try {
      const r = await api.patch<{ user: UserDTO }>(`/api/users/${user!.id}`, patch);
      setUser({ ...user!, displayName: r.user.displayName, avatar: r.user.avatar });
      toast('Saved', 'success');
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed');
      return false;
    }
  };

  const upload = async (f: File) => {
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await api.upload<{ user: UserDTO }>(`/api/users/${user!.id}/avatar`, fd);
      setUser({ ...user!, avatar: r.user.avatar });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed');
    }
  };

  return (
    <div className="stack lg" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>How you appear on the sign-in screen.</p>
        </div>
      </div>
      <div className="panel stack">
        <div className="row">
          <Avatar name={user!.displayName} avatar={user!.avatar} size={72} />
          <div className="stack" style={{ gap: 6 }}>
            <div className="row wrap" style={{ gap: 4 }}>
              {EMOJI.map((e) => (
                <button key={e} className="btn ghost icon sm" onClick={() => void save({ avatar: e })} aria-label={`Use ${e}`}>
                  {e}
                </button>
              ))}
            </div>
            <label className="btn sm" style={{ width: 'fit-content' }}>
              Upload photo
              <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            </label>
          </div>
        </div>
        <label className="field">
          <span>Display name</span>
          <div className="row">
            <input className="input" value={displayName} onChange={(e) => setName(e.target.value)} maxLength={64} />
            <button className="btn" onClick={() => void save({ displayName })} disabled={!displayName.trim()}>
              Save
            </button>
          </div>
        </label>
      </div>
      <form
        className="panel stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== pw2) return setErr('Passwords do not match');
          if (await save({ password: pw, currentPassword: cur })) {
            setCur('');
            setPw('');
            setPw2('');
          }
        }}
      >
        <h2>Change password</h2>
        <div className="form-grid">
          <label className="field">
            <span>Current</span>
            <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="field">
            <span>New (8+ chars)</span>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>Confirm</span>
            <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {err && <div className="error-text">{err}</div>}
        <div>
          <button className="btn primary" disabled={!cur || pw.length < 8}>
            Update password
          </button>
        </div>
      </form>
    </div>
  );
}
