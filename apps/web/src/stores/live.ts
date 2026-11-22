import { create } from 'zustand';
import type { CardVaultEvent } from '@cardvault/shared';
import { api } from '../services/api';
import type { JobDTO } from '../types';
import { actionToast, toast } from './toasts';

/**
 * Live job monitor fed by Server-Sent Events. Events patch jobs in place for
 * instant feedback, then a debounced refetch reconciles with the server.
 */
interface LiveState {
  connected: boolean;
  jobs: JobDTO[];
  counts: Record<string, number>;
  /** bumps whenever collection-affecting events arrive; pages watch it to refetch */
  revision: number;
  lastEvent: CardVaultEvent | null;
  refresh: () => Promise<void>;
  connect: () => () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  jobs: [],
  counts: {},
  revision: 0,
  lastEvent: null,
  refresh: async () => {
    try {
      const r = await api.get<{ jobs: JobDTO[]; counts: Record<string, number> }>('/api/jobs?limit=150');
      set({ jobs: r.jobs, counts: r.counts });
    } catch {
      /* ignore */
    }
  },
  connect: () => {
    void get().refresh();
    const es = new EventSource('/api/events', { withCredentials: true });
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void get().refresh(), 600);
    };
    es.onopen = () => set({ connected: true });
    es.onerror = () => set({ connected: false });
    const handle = (raw: MessageEvent) => {
      const e = JSON.parse(raw.data) as CardVaultEvent;
      if (e.type === 'WORKER_HEARTBEAT') return;
      set((s) => ({
        lastEvent: e,
        jobs: s.jobs.map((j) => (j.id === e.jobId ? { ...j, status: e.state ?? j.status, stage: e.message ?? j.stage, progress: e.progress ?? j.progress } : j)),
        revision: ['CARD_RESEARCH_COMPLETE', 'PRICE_UPDATED', 'IDENTIFICATION_COMPLETE', 'MANUAL_REVIEW_REQUIRED'].includes(e.type) ? s.revision + 1 : s.revision,
      }));
      if (e.type === 'IDENTIFICATION_COMPLETE') {
        const owned = Number((e.data as { alreadyOwned?: number } | undefined)?.alreadyOwned ?? 0);
        const name = (e.message ?? '').replace(/\s*\(.*\)$/, '');
        if (owned > 0 && e.scanId) {
          // a repeat scan is simply another copy; offer Undo in case it was an accidental double capture
          const scanId = e.scanId;
          actionToast(`Added another ${name} — you now have ${owned + 1} copies`, 'success', {
            label: 'Undo',
            run: () =>
              void api
                .del(`/api/scans/${scanId}`)
                .then(() => {
                  toast(`Removed the extra copy of ${name}`, 'info');
                  void get().refresh();
                })
                .catch(() => toast('Could not undo — delete it from the scans list', 'error')),
          });
        } else toast(`Identified ${e.message ?? ''}`, 'success');
      }
      if (e.type === 'MANUAL_REVIEW_REQUIRED') toast(`Needs review: ${e.message ?? 'card'}`, 'warn', '/review');
      if (e.type === 'JOB_FAILED' && e.state === 'FAILED') toast(`Job failed: ${e.message ?? ''}`, 'error', '/queue');
      schedule();
    };
    for (const t of ['JOB_CREATED', 'JOB_STARTED', 'JOB_PROGRESS', 'IDENTIFICATION_COMPLETE', 'IDENTIFICATION_FAILED', 'RESEARCH_STARTED', 'CARD_RESEARCH_COMPLETE', 'PRICE_UPDATED', 'JOB_COMPLETE', 'JOB_FAILED', 'MANUAL_REVIEW_REQUIRED']) {
      es.addEventListener(t, handle as EventListener);
    }
    return () => {
      es.close();
      set({ connected: false });
    };
  },
}));

export const ACTIVE_STATES = ['PROCESSING', 'MATCHING', 'RESEARCHING', 'PRICING'];
