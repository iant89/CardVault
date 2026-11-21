import { create } from 'zustand';
import type { SessionUser } from '@cardvault/shared';
import { api, setCsrf } from '../services/api';

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
  load: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: SessionUser) => void;
}

export const useSession = create<SessionState>((set) => ({
  user: null,
  loading: true,
  load: async () => {
    try {
      const r = await api.get<{ user: SessionUser | null; csrfToken: string | null }>('/api/auth/session');
      setCsrf(r.csrfToken);
      set({ user: r.user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },
  login: async (username, password) => {
    const r = await api.post<{ user: SessionUser; csrfToken: string }>('/api/auth/login', { username, password });
    setCsrf(r.csrfToken);
    set({ user: r.user });
  },
  logout: async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setCsrf(null);
    set({ user: null });
  },
  setUser: (u) => set({ user: u }),
}));
