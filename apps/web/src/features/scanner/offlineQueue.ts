import { create } from 'zustand';
import { api, ApiError } from '../../services/api';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

/**
 * Local browser queue: Camera → IndexedDB → server. Captures survive a
 * backend outage, a flaky Wi-Fi connection or a page reload. Each capture
 * carries a client id, so a retried upload never creates a second scan.
 */
export interface PendingScan {
  id: string;
  userId: string;
  blob: Blob;
  gameHint?: string;
  capturedAt: string;
  quality?: Record<string, unknown>;
  status: 'pending' | 'uploading' | 'duplicate' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  allowDuplicate?: boolean;
  duplicate?: { scanId: string; cardId: string | null; cardName: string | null; createdAt: string };
}
export type PendingView = Omit<PendingScan, 'blob'> & { url: string };

const DB = 'cardvault';
const STORE = 'pending-scans';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const all = () => tx<PendingScan[]>('readonly', (s) => s.getAll() as IDBRequest<PendingScan[]>);
const put = (p: PendingScan) => tx('readwrite', (s) => s.put(p));
const remove = (id: string) => tx('readwrite', (s) => s.delete(id));

const urls = new Map<string, string>();
const view = (p: PendingScan): PendingView => {
  if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob));
  const { blob: _b, ...rest } = p;
  void _b;
  return { ...rest, url: urls.get(p.id)! };
};

interface QueueState {
  items: PendingView[];
  uploaded: number;
  /** local capture id → server scan id, filled in as uploads succeed */
  uploadedIds: Record<string, string>;
  online: boolean;
  add: (blob: Blob, meta: { gameHint?: string; quality?: Record<string, unknown> }) => Promise<string | null>;
  /** returns the new local id when re-queued as an extra copy */
  resolveDuplicate: (id: string, action: 'add' | 'cancel') => Promise<string | null>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  start: () => () => void;
}

let running = false;

export const useOfflineQueue = create<QueueState>((set, get) => {
  const reload = async () => {
    const uid = useSession.getState().user?.id;
    const rows = (await all().catch(() => [])).filter((r) => r.userId === uid).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    set({ items: rows.map(view) });
    return rows;
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await reload();
      for (const p of rows) {
        if (p.status === 'duplicate' || p.status === 'failed' || p.nextAttemptAt > Date.now()) continue;
        await put({ ...p, status: 'uploading' });
        await reload();
        const fd = new FormData();
        fd.append('clientScanId', p.id);
        fd.append('capturedAt', p.capturedAt);
        if (p.gameHint) fd.append('gameHint', p.gameHint);
        if (p.quality) fd.append('quality', JSON.stringify(p.quality).slice(0, 1900));
        if (p.allowDuplicate) fd.append('allowDuplicate', 'true');
        fd.append('image', p.blob, `${p.id}.jpg`); // file last so fields are read first
        try {
          const r = await api.upload<{ scanId: string }>('/api/scans', fd);
          await remove(p.id);
          URL.revokeObjectURL(urls.get(p.id) ?? '');
          urls.delete(p.id);
          set((s) => ({ uploaded: s.uploaded + 1, online: true, uploadedIds: { ...s.uploadedIds, [p.id]: r.scanId } }));
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.body.error === 'DUPLICATE_SCAN') {
            await put({ ...p, status: 'duplicate', duplicate: e.body.duplicate as PendingScan['duplicate'] });
          } else if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && e.status !== 401) {
            await put({ ...p, status: 'failed', error: e.message });
            toast(`Scan rejected: ${e.message}`, 'error');
          } else {
            // offline / server down: exponential backoff, keep forever
            const attempts = p.attempts + 1;
            await put({ ...p, status: 'pending', attempts, nextAttemptAt: Date.now() + Math.min(60_000, 2000 * 2 ** attempts), error: e instanceof Error ? e.message : 'offline' });
            set({ online: false });
            break;
          }
        }
      }
    } finally {
      running = false;
      await reload();
    }
  };

  return {
    items: [],
    uploaded: 0,
    uploadedIds: {},
    online: true,
    add: async (blob, meta) => {
      const uid = useSession.getState().user?.id;
      if (!uid) return null;
      const id = crypto.randomUUID();
      await put({ id, userId: uid, blob, gameHint: meta.gameHint, quality: meta.quality, capturedAt: new Date().toISOString(), status: 'pending', attempts: 0, nextAttemptAt: 0 });
      await reload();
      void pump();
      return id;
    },
    resolveDuplicate: async (id, action) => {
      const p = (await all()).find((x) => x.id === id);
      if (!p) return null;
      let next: string | null = null;
      if (action === 'cancel') await get().discard(id);
      else {
        // a new client id so the server treats it as a deliberate extra copy
        await remove(id);
        next = crypto.randomUUID();
        await put({ ...p, id: next, status: 'pending', allowDuplicate: true, duplicate: undefined, nextAttemptAt: 0 });
        void pump();
      }
      await reload();
      return next;
    },
    retry: async (id) => {
      const p = (await all()).find((x) => x.id === id);
      if (p) await put({ ...p, status: 'pending', nextAttemptAt: 0, error: undefined });
      void pump();
    },
    discard: async (id) => {
      await remove(id);
      URL.revokeObjectURL(urls.get(id) ?? '');
      urls.delete(id);
      await reload();
    },
    start: () => {
      void pump();
      const t = setInterval(() => void pump(), 4000);
      const on = () => {
        set({ online: true });
        void pump();
      };
      window.addEventListener('online', on);
      return () => {
        clearInterval(t);
        window.removeEventListener('online', on);
      };
    },
  };
});
