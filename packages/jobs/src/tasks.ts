import type { Redis } from 'ioredis';
import type { LabTask, TaskState } from '@cardvault/shared';

/**
 * The OCR Lab queue's memory — shared by the API (which enqueues work and
 * builds the queue view) and the worker (which reports progress).
 *
 * Every long piece of lab work (scoring, exporting, training, the trainer's
 * Python setup, a TCGdex import, a trial refresh) is recorded here in redis so
 * the queue survives restarts, page reloads and BullMQ forgetting a job, and so
 * cancelled or failed work still shows what happened. Entries are small and
 * expire after a week.
 *
 * A task is keyed by the thing it works on (`ocr-evaluate:<id>`, `ocr-train`),
 * so a worker that restarts and re-runs a job updates the same entry.
 */

export const TASK_KEY = (key: string) => `ocr:task:${key}`;
export const TASK_INDEX_KEY = 'ocr:tasks';
const TTL_SECONDS = 7 * 24 * 3600;
const MAX_TASKS = 40;

export interface TaskRecord {
  /** stable id, also the redis key suffix (`ocr-evaluate:<uuid>`) */
  key: string;
  kind: 'evaluation' | 'export' | 'train' | 'python' | 'import' | 'watch' | 'rescan';
  name: string;
  state: TaskState;
  /** 0-100 */
  progress: number;
  /** what the bar is counting, e.g. "412 / 1,500 groups" */
  progressLabel: string | null;
  /** one line of context, rewritten as the task moves on */
  detail: string;
  /** seconds left, from the task's own pace; null until a pace exists */
  etaSeconds: number | null;
  /** multi-phase tasks (the trainer's Python setup) */
  step: { total: number; index: number; label: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** ms spent running, filled in when the task ends */
  runtimeMs: number | null;
  error: string | null;
  /** where the finished work can be looked at (a model id, a dataset id …) */
  result: string | null;
  /** the request that repeats this task, for the queue's Retry button */
  retry: { path: string; body?: Record<string, unknown>; label: string } | null;
}

/**
 * Create or amend a task. Returns the stored record so a processor can keep
 * reporting against the same timestamps.
 */
export async function saveTask(
  redis: Redis,
  patch: Partial<TaskRecord> & Pick<TaskRecord, 'key' | 'kind' | 'name'>,
): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const raw = await redis.get(TASK_KEY(patch.key)).catch(() => null);
  const before = raw ? (JSON.parse(raw) as TaskRecord) : null;
  const base: TaskRecord = before ?? {
    key: patch.key,
    kind: patch.kind,
    name: patch.name,
    state: 'queued',
    progress: 0,
    progressLabel: null,
    detail: '',
    etaSeconds: null,
    step: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    runtimeMs: null,
    error: null,
    result: null,
    retry: null,
  };
  const state = patch.state ?? base.state;
  const record: TaskRecord = {
    ...base,
    ...patch,
    state,
    // the first time it is seen running, start the clock
    startedAt: base.startedAt ?? (state === 'running' ? now : null),
    finishedAt: ['done', 'failed', 'cancelled'].includes(state) ? (base.finishedAt ?? now) : null,
  };
  if (record.startedAt && ['done', 'failed', 'cancelled'].includes(record.state) && record.runtimeMs == null) {
    record.runtimeMs = Math.max(0, new Date(record.finishedAt!).getTime() - new Date(record.startedAt).getTime());
  }
  await redis
    .multi()
    .set(TASK_KEY(record.key), JSON.stringify(record), 'EX', TTL_SECONDS)
    // newest first, de-duplicated, capped: the list may hold a finished entry
    .lrem(TASK_INDEX_KEY, 0, record.key)
    .lpush(TASK_INDEX_KEY, record.key)
    .ltrim(TASK_INDEX_KEY, 0, MAX_TASKS - 1)
    .expire(TASK_INDEX_KEY, TTL_SECONDS)
    .exec()
    .catch(() => undefined);
  return record;
}

/** Every task in the queue, newest first; entries that expired are skipped. */
export async function listTasks(redis: Redis): Promise<TaskRecord[]> {
  const keys = await redis.lrange(TASK_INDEX_KEY, 0, MAX_TASKS - 1).catch(() => [] as string[]);
  if (!keys.length) return [];
  const raws = await redis.mget(...keys.map(TASK_KEY)).catch(() => [] as (string | null)[]);
  const out: TaskRecord[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as TaskRecord);
    } catch {
      /* a half-written entry: skip it rather than fail the queue */
    }
  }
  return out;
}

/** Store progress on a task that is already running (a no-op when none exists yet). */
export async function taskProgress(
  redis: Redis,
  key: string,
  patch: { progress?: number; progressLabel?: string | null; detail?: string; etaSeconds?: number | null; step?: TaskRecord['step'] },
): Promise<void> {
  const raw = await redis.get(TASK_KEY(key)).catch(() => null);
  if (!raw) return;
  const next: TaskRecord = { ...(JSON.parse(raw) as TaskRecord), ...patch };
  await redis.set(TASK_KEY(key), JSON.stringify(next), 'EX', TTL_SECONDS).catch(() => undefined);
}

/** Start a task if the caller has not already created one. */
export async function ensureTask(
  redis: Redis,
  task: Partial<TaskRecord> & Pick<TaskRecord, 'key' | 'kind' | 'name'>,
): Promise<TaskRecord> {
  const raw = await redis.get(TASK_KEY(task.key)).catch(() => null);
  if (raw) {
    const before = JSON.parse(raw) as TaskRecord;
    // a task whose worker died mid-run is picked up again: restart its clock
    if (before.state === 'running' || before.state === 'queued') return before;
    return saveTask(redis, { ...task, state: 'running', finishedAt: null, runtimeMs: null, error: null });
  }
  return saveTask(redis, { ...task, state: 'running' });
}

/** Remove a task from the queue (used to drop a finished entry the admin dismisses). */
export async function forgetTask(redis: Redis, key: string): Promise<void> {
  await redis.multi().del(TASK_KEY(key)).lrem(TASK_INDEX_KEY, 0, key).exec().catch(() => undefined);
}

/** The task a maintenance job reports into — the same keys the processors use. */
export function taskKeyOf(jobName: string, data: Record<string, unknown> = {}): string | null {
  switch (jobName) {
    case 'ocr-evaluate':
      return data.evaluationId ? `ocr-evaluate:${String(data.evaluationId)}` : null;
    case 'ocr-export-dataset':
      return 'ocr-export';
    case 'ocr-train-model':
      return 'ocr-train';
    case 'ocr-python-setup':
      return 'ocr-python';
    case 'ocr-import-harvest':
      return 'ocr-import';
    case 'ocr-watch':
      return 'ocr-watch';
    case 'ocr-scan-models':
      return 'ocr-rescan';
    default:
      return null;
  }
}

/**
 * A stored record as the page shows it: runtime is computed live while the task
 * runs (so the queue's clock ticks between polls), and is the final duration
 * once it ends.
 */
export function toLabTask(t: TaskRecord, now = Date.now()): LabTask {
  const running = t.state === 'running';
  const runtimeMs = running && t.startedAt ? Math.max(0, now - new Date(t.startedAt).getTime()) : t.runtimeMs;
  return {
    id: t.key,
    kind: t.kind,
    name: t.name,
    description: t.detail,
    state: t.state,
    progress: t.state === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(t.progress))),
    progressLabel: t.progressLabel,
    runtimeMs,
    etaSeconds: running ? t.etaSeconds : null,
    step: t.step,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    error: t.error,
    cancellable: running || t.state === 'queued',
    canRetry: t.retry != null,
  };
}
