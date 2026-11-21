import { useState } from 'react';
import { api, ApiError } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { useSession } from '../../stores/session';
import { Avatar, Dialog, Loading } from '../../components/ui';
import { toast } from '../../stores/toasts';
import type { UserDTO } from '../../types';

/** No public registration — the administrator creates family accounts here. */
export default function UsersPage() {
  const me = useSession((s) => s.user!);
  const list = useAsync(() => api.get<{ users: UserDTO[] }>('/api/users'), []);
  const [edit, setEdit] = useState<UserDTO | 'new' | null>(null);

  const toggle = async (u: UserDTO) => {
    try {
      await api.patch(`/api/users/${u.id}`, { active: !u.active });
      list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed', 'error');
    }
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Family members who can sign in to CardVault.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit('new')}>
          + Add user
        </button>
      </div>
      {!list.data ? (
        <Loading />
      ) : (
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th className="hide-mobile">Last sign-in</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.users.map((u) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <Avatar name={u.displayName} avatar={u.avatar} size={34} />
                      <div>
                        <strong>{u.displayName}</strong>
                        <div className="faint mono" style={{ fontSize: 12 }}>
                          {u.username}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${u.role === 'ADMIN' ? 'accent' : ''}`}>{u.role.toLowerCase()}</span>
                  </td>
                  <td className="hide-mobile faint">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                  <td>{u.active ? <span className="badge good">active</span> : <span className="badge">disabled</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button className="btn sm" onClick={() => setEdit(u)}>
                        Edit
                      </button>
                      {u.id !== me.id && (
                        <button className="btn sm ghost" onClick={() => void toggle(u)}>
                          {u.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={edit !== null} onClose={() => setEdit(null)} size="sm">
        {edit !== null && <UserForm user={edit === 'new' ? null : edit} onDone={() => (setEdit(null), list.reload())} />}
      </Dialog>
    </div>
  );
}

function UserForm({ user, onDone }: { user: UserDTO | null; onDone: () => void }) {
  const [f, setF] = useState({ username: user?.username ?? '', displayName: user?.displayName ?? '', password: '', role: user?.role ?? 'USER' });
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    try {
      if (user) await api.patch(`/api/users/${user.id}`, { displayName: f.displayName, role: f.role, ...(f.password ? { password: f.password } : {}) });
      else await api.post('/api/users', f);
      toast(user ? 'User updated' : 'User created', 'success');
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? (Array.isArray(e.body.details) ? (e.body.details as { message: string }[]).map((d) => d.message).join(', ') : e.message) : 'Failed');
    }
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>{user ? `Edit ${user.displayName}` : 'Add user'}</h2>
      {!user && (
        <label className="field">
          <span>Username</span>
          <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" />
        </label>
      )}
      <label className="field">
        <span>Display name</span>
        <input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
      </label>
      <label className="field">
        <span>{user ? 'Reset password (optional)' : 'Password (8+ chars)'}</span>
        <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
      </label>
      <label className="field">
        <span>Role</span>
        <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'ADMIN' | 'USER' })}>
          <option value="USER">User</option>
          <option value="ADMIN">Administrator</option>
        </select>
      </label>
      {err && <div className="error-text">{err}</div>}
      <button className="btn primary">{user ? 'Save' : 'Create user'}</button>
    </form>
  );
}
