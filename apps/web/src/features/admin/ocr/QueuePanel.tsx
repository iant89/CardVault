import { useEffect, useMemo, useRef, useState } from 'react';
import type { LabQueue, LabTask } from '@cardvault/shared';
import { ProgressRing } from '../../../components/ProgressRing';
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  DownloadIcon,
  ImportIcon,
  LayersIcon,
  PulseIcon,
  QueueIcon,
  RefreshIcon,
  ScanIcon,
  SparkIcon,
  StopIcon,
  TargetIcon,
  TerminalIcon,
  XIcon,
} from '../../../components/icons';
import { KIND_LABEL, STATE_LABEL, formatDuration, formatEta, orderTasks, queueSummaryText, taskSubtitle } from './labFormat';

const KIND_ICON: Record<LabTask['kind'], (p: { size?: number }) => ReturnType<typeof LayersIcon>> = {
  evaluation: TargetIcon,
  export: DownloadIcon,
  train: SparkIcon,
  python: TerminalIcon,
  import: ImportIcon,
  watch: PulseIcon,
  rescan: ScanIcon,
};

/**
 * The OCR Lab task queue: a button in the page's upper right that turns into a
 * popup listing every task.
 *
 * While anything is running the button carries a ring showing the active task's
 * progress (the page draws the same ring, so the queue is legible from the top
 * of the screen without opening it). Each entry shows its name, what it is
 * doing, its state, a progress bar, the time it has taken and — while running —
 * how long it expects to keep going.
 */
export interface QueueActions {
  onCancel: (t: LabTask) => void;
  onRetry: (t: LabTask) => void;
  onDismiss: (t: LabTask) => void;
  onClearFinished: () => void;
  onRefresh: () => void;
}

export function QueuePanel({ queue, ...actions }: { queue: LabQueue | null } & QueueActions) {
  const { onCancel, onRetry, onDismiss, onClearFinished, onRefresh } = actions;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const tasks = queue?.tasks ?? [];
  const active = tasks.find((t) => t.state === 'running') ?? null;

  // the clock ticks every second while the popup is open, so runtimes are live
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const running = (queue?.counts.running ?? 0) + (queue?.counts.queued ?? 0);
  const failed = queue?.counts.failed ?? 0;
  const busy = !!active || (queue?.counts.queued ?? 0) > 0;

  return (
    <div className="ocr-queue" ref={ref}>
      <button
        type="button"
        className={`ocr-queue-btn${open ? ' on' : ''}${busy ? ' busy' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={queueSummaryText(queue)}
      >
        {/* the ring sits behind the icon; with nothing running it is an idle track */}
        <ProgressRing
          value={active?.progress ?? (queue?.counts.queued ? 0 : 100)}
          size={38}
          stroke={3}
          idle={!busy}
          color={failed && !busy ? 'var(--bad)' : 'var(--accent)'}
          colorTo={failed && !busy ? 'var(--warn)' : 'var(--accent-2)'}
        >
          <QueueIcon size={16} />
        </ProgressRing>
        <span className="ocr-queue-label">
          <span className="ocr-queue-title">Queue</span>
          <span className="ocr-queue-sub">
            {active ? `${active.progress}%` : running ? `${queue?.counts.queued ?? 0} waiting` : failed ? `${failed} failed` : 'idle'}
          </span>
        </span>
        {failed > 0 && <span className="ocr-queue-dot" aria-hidden="true" />}
      </button>

      {open && <QueuePopup queue={queue} now={now} {...actions} />}
    </div>
  );
}

/** The popup itself: the header, the active task, and every entry. */
export function QueuePopup({ queue, now = Date.now(), ...actions }: { queue: LabQueue | null; now?: number } & QueueActions) {
  const { onCancel, onRetry, onDismiss, onClearFinished, onRefresh } = actions;
  const tasks = queue?.tasks ?? [];
  const active = tasks.find((t) => t.state === 'running') ?? null;
  const ordered = useMemo(() => orderTasks(tasks), [tasks]);
  const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.state)).length;
  return (
        <div className="ocr-queue-pop" role="dialog" aria-label="OCR Lab task queue">
          <div className="ocr-queue-head">
            <div style={{ minWidth: 0 }}>
              <strong>Task queue</strong>
              <div className="faint" style={{ fontSize: 12 }}>
                {queueSummaryText(queue)}
                {finished > 0 ? ` · ${finished} finished` : ''}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost icon" onClick={onRefresh} title="Refresh now" aria-label="Refresh now">
                <RefreshIcon size={15} />
              </button>
              {finished > 0 && (
                <button className="btn sm ghost" onClick={onClearFinished} title="Remove finished tasks from the list">
                  Clear finished
                </button>
              )}
            </div>
          </div>

          {active && (
            <div className="ocr-queue-active">
              <ProgressRing value={active.progress} size={46} stroke={4} color="var(--accent)" colorTo="var(--accent-2)">
                <strong style={{ fontSize: 13 }}>{active.progress}%</strong>
              </ProgressRing>
              <div style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 700 }}>{active.name}</div>
                <div className="faint truncate" style={{ fontSize: 12 }}>{taskSubtitle(active)}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {formatDuration(active.startedAt ? now - new Date(active.startedAt).getTime() : active.runtimeMs)}
                  {active.etaSeconds != null ? ` · ${formatEta(active.etaSeconds)}` : ''}
                </div>
              </div>
            </div>
          )}

          <div className="ocr-queue-list">
            {ordered.length === 0 && (
              <div className="ocr-queue-empty">
                <QueueIcon size={22} />
                <div>
                  <strong>Nothing queued</strong>
                  <div className="faint" style={{ fontSize: 12 }}>
                    Scoring, exports, training and imports run here, one after another.
                  </div>
                </div>
              </div>
            )}
            {ordered.map((t) => (
              <QueueRow
                key={t.id}
                t={t}
                now={now}
                onCancel={() => onCancel(t)}
                onRetry={() => onRetry(t)}
                onDismiss={() => onDismiss(t)}
              />
            ))}
          </div>

          <div className="ocr-queue-foot faint">
            <ClockIcon size={13} /> Runtimes are live. A stopped task keeps whatever it had already finished.
          </div>
        </div>
  );
}

function QueueRow({
  t,
  now,
  onCancel,
  onRetry,
  onDismiss,
}: {
  t: LabTask;
  now: number;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = KIND_ICON[t.kind] ?? LayersIcon;
  const live = t.state === 'running' && t.startedAt ? Math.max(0, now - new Date(t.startedAt).getTime()) : t.runtimeMs;
  // a stepped task leads with the phase it is in (the setup's "PyTorch (CPU build)")
  const base = taskSubtitle(t);
  const subtitle = t.step && base ? `${t.step.label} — ${base}` : t.step?.label ?? base;
  const long = subtitle.length > 84;
  const stateIcon =
    t.state === 'done' ? <CheckIcon size={13} /> : t.state === 'failed' ? <AlertIcon size={13} /> : t.state === 'cancelled' ? <StopIcon size={13} /> : null;

  const stepText = t.step ? `Step ${t.step.index} of ${t.step.total}` : null;

  return (
    <div className={`ocr-task ${t.state}`}>
      <div className={`ocr-task-mark ${t.state}`} aria-hidden="true">
        <Icon size={14} />
      </div>
      <div className="ocr-task-body">
        <div className="ocr-task-top">
          <span className="ocr-task-name truncate" title={t.name}>{t.name}</span>
          <span className={`ocr-state ${t.state}`}>
            {t.state === 'running' && <span className="dot good pulse" />}
            {stateIcon}
            {STATE_LABEL[t.state]}
          </span>
          <span className="ocr-task-kind faint hide-mobile">{KIND_LABEL[t.kind]}</span>
        </div>
        <div className="ocr-task-desc faint" title={long ? subtitle : undefined}>
          {stepText ? <span className="ocr-task-step">{stepText} · </span> : null}
          {long && !expanded ? `${subtitle.slice(0, 84)}…` : subtitle}
          {long && (
            <button className="ocr-link" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </div>
        <div className={`progress ocr-task-bar${t.state === 'failed' ? ' bad' : t.state === 'done' ? ' good' : ''}`} role="progressbar" aria-valuenow={t.progress} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${t.state === 'queued' ? 0 : t.progress}%` }} />
        </div>
        <div className="ocr-task-meta">
          <span className="ocr-task-pct">{t.state === 'queued' ? 'waiting' : `${t.progress}%`}</span>
          {t.progressLabel && <span className="faint">{t.progressLabel}</span>}
          <span className="ocr-meta-sep" />
          <span className="ocr-meta" title="Runtime">
            <ClockIcon size={12} /> {formatDuration(t.state === 'queued' ? null : live)}
          </span>
          {t.state === 'running' && t.etaSeconds != null && (
            <span className="ocr-meta eta" title="Estimated time until finished">
              <ChevronIcon size={12} dir="right" /> {formatEta(t.etaSeconds)}
            </span>
          )}
          {t.state === 'running' && t.etaSeconds == null && <span className="ocr-meta faint">estimating…</span>}
        </div>
      </div>
      <div className="ocr-task-actions">
        {t.cancellable && (
          <button className="btn sm ghost icon" onClick={onCancel} title={t.kind === 'train' ? 'Stop after the current step' : 'Stop this task'} aria-label="Stop">
            <StopIcon size={14} />
          </button>
        )}
        {!t.cancellable && (
          <>
            {t.canRetry && (
              <button className="btn sm ghost icon" onClick={onRetry} title="Run it again" aria-label="Run again">
                <RefreshIcon size={14} />
              </button>
            )}
            <button className="btn sm ghost icon" onClick={onDismiss} title="Remove from the queue" aria-label="Remove">
              <XIcon size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
