/** Labels and maths the OCR Lab's queue shows. Pure, so they are easy to test. */
import type { LabQueue, LabTask, TaskKind, TaskState } from '@cardvault/shared';

export const STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const KIND_LABEL: Record<TaskKind, string> = {
  evaluation: 'Scoring',
  export: 'Export',
  train: 'Training',
  python: 'Setup',
  import: 'Import',
  watch: 'Watch',
  rescan: 'Models',
};

/** "2m 05s", "48s", "1h 12m" — a duration a person can read at a glance. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 1) return '<1s';
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Time until finished. Deliberately vague past an hour, where precision is noise. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 5) return 'almost done';
  if (seconds < 60) return `~${Math.round(seconds / 5) * 5}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours} h ${rest} min left` : `~${hours} h left`;
}

/** The line under a task's name: what it is doing, or how it ended. */
export function taskSubtitle(t: LabTask): string {
  if (t.state === 'failed') return t.error ?? 'It failed.';
  if (t.state === 'cancelled') return t.error ?? 'Stopped.';
  if (t.state === 'queued') return t.description || 'Waiting for the worker…';
  if (t.state === 'done') return t.description || 'Finished.';
  return t.description || KIND_LABEL[t.kind];
}

/** The one-line status for the queue button's tooltip and the popup header. */
export function queueSummaryText(q: LabQueue | null): string {
  if (!q || !q.tasks.length) return 'No tasks in the OCR Lab queue';
  const running = q.counts.running ?? 0;
  const queued = q.counts.queued ?? 0;
  const failed = q.counts.failed ?? 0;
  if (running || queued) {
    const bits = [running ? `${running} running` : null, queued ? `${queued} queued` : null].filter(Boolean);
    return `Task queue · ${bits.join(' · ')}`;
  }
  if (failed) return `Task queue · ${failed} failed`;
  return 'Task queue · nothing running';
}

/** Tasks in the order the queue shows them: running, queued, then finished newest first. */
export function orderTasks(tasks: LabTask[]): LabTask[] {
  const rank: Record<TaskState, number> = { running: 0, queued: 1, failed: 2, cancelled: 3, done: 4 };
  return [...tasks].sort((a, b) => rank[a.state] - rank[b.state] || new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
}

/** Only the finished entries, for the "Clear finished" button and its count. */
export const finishedTasks = (tasks: LabTask[]) => tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.state));
