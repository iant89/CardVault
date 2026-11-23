/**
 * OCR Lab task queue — the shape every long-running lab action reports in.
 *
 * The lab's work happens in the worker (scoring, exports, training, the
 * trainer's Python setup, TCGdex imports), each with its own store of progress
 * (a database row, or a redis status written by the worker). This module holds
 * the one shape those stores are presented as, plus the small amount of maths
 * the queue needs (percent, runtime, a time-until-finished estimate) so the API
 * and the UI cannot disagree about it.
 */

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What kind of work a task is: decides its icon, and which cancel it offers. */
export type TaskKind = 'evaluation' | 'export' | 'train' | 'python' | 'import' | 'watch' | 'rescan';

/**
 * A phase of a multi-step task (the trainer's Python setup reports 3 of 3,
 * "Trainer packages"). `index` is 1-based while the task runs.
 */
export interface TaskStepInfo {
  index: number;
  total: number;
  label: string;
}

/**
 * One entry in the OCR Lab queue.
 *
 * `progress` is always 0–100 (an estimate while the task cannot measure itself,
 * e.g. the first epoch of training), and `runtimeMs` is time spent — live while
 * running, final once it ends, and null before it starts.
 */
export interface LabTask {
  id: string;
  kind: TaskKind;
  /** short name shown in the queue, e.g. "Score a model on exam v3" */
  name: string;
  /** one line of context: what it is doing, or how it ended */
  description: string;
  state: TaskState;
  /** 0–100 */
  progress: number;
  /** the number behind the bar, e.g. "412 / 1,500 groups" */
  progressLabel: string | null;
  /** time spent so far (running), or the total (finished). Null before it starts. */
  runtimeMs: number | null;
  /** seconds left, from the task's own pace; null until a pace exists */
  etaSeconds: number | null;
  /** phase of a stepped task (trainer setup) */
  step: TaskStepInfo | null;
  /** ISO timestamps, as reported by the store that owns the task */
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** why it failed or was cancelled */
  error: string | null;
  /** true when the lab can stop the task */
  cancellable: boolean;
  /** true when the same request can be queued again from the queue */
  canRetry: boolean;
}

/** Everything the queue button and popup need in one poll. */
export interface LabQueue {
  tasks: LabTask[];
  /** the task currently running, if any (the ring shows its progress) */
  activeId: string | null;
  /** 0–100: the active task's progress, else 0 */
  progress: number;
  counts: Partial<Record<TaskState, number>>;
  /** total tasks in the queue, including finished ones still listed */
  total: number;
}

export const TERMINAL_TASK_STATES: TaskState[] = ['done', 'failed', 'cancelled'];

export const isTaskActive = (t: Pick<LabTask, 'state'>) => t.state === 'running' || t.state === 'queued';
export const isTaskDone = (t: Pick<LabTask, 'state'>) => TERMINAL_TASK_STATES.includes(t.state);

/** Clamp to the whole numbers a progress bar can show. */
export function percent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** Fraction done (0–1) from a count; 0 when there is nothing to measure yet. */
export function ratio(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, done / total));
}

/**
 * Seconds until a task that has finished `done` of `total` units is done,
 * measured from the pace so far. Null until at least one unit is done — before
 * that there is no pace to extrapolate, and a guess is worse than nothing.
 */
export function etaFromPace(done: number, total: number, elapsedMs: number): number | null {
  if (done >= total && total > 0) return 0;
  if (done <= 0 || total <= done || !(elapsedMs > 0)) return null;
  const msPerUnit = elapsedMs / done;
  return Math.max(0, Math.round((msPerUnit * (total - done)) / 1000));
}

/**
 * Time until a training run finishes: every epoch costs about what the ones so
 * far cost. Returns null until one epoch has been timed, so the lab shows
 * "estimating…" rather than inventing a number.
 */
export function etaFromEpochs(epoch: number, epochs: number, elapsedMs: number): number | null {
  if (epoch >= epochs && epochs > 0) return 0;
  if (epoch <= 0 || epochs <= epoch || !(elapsedMs > 0)) return null;
  const msPerEpoch = elapsedMs / epoch;
  return Math.max(0, Math.round((msPerEpoch * (epochs - epoch)) / 1000));
}

/** The queue as the top-right button shows it: active task, progress, counts. */
export function summarizeQueue(tasks: LabTask[]): LabQueue {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const active = tasks.find((t) => t.state === 'running') ?? tasks.find((t) => t.state === 'queued') ?? null;
  return {
    tasks,
    activeId: active?.id ?? null,
    progress: active && active.state === 'running' ? active.progress : 0,
    counts,
    total: tasks.length,
  };
}
