import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { avatarSrc } from '../services/api';
import { useToasts } from '../stores/toasts';
import { useNavigate } from 'react-router';

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1'];

export function Avatar({ name, avatar, size = 36 }: { name: string; avatar?: string | null; size?: number }) {
  const src = avatarSrc(avatar);
  const emoji = avatar && !avatar.startsWith('file:') ? avatar : null;
  const color = COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * (emoji ? 0.55 : 0.4), background: src ? undefined : `linear-gradient(135deg, ${color}, #1e2638)` }}>
      {src ? <img src={src} alt="" /> : emoji ?? name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function Dialog({ open, onClose, children, size }: { open: boolean; onClose: () => void; children: ReactNode; size?: 'sm' }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', k);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${size ?? ''}`} role="dialog" aria-modal="true">
        <button className="btn ghost icon dialog-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  const nav = useNavigate();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          onClick={() => {
            if (t.href) nav(t.href);
            dismiss(t.id);
          }}
          style={{ cursor: t.href ? 'pointer' : 'default' }}
        >
          <span>{t.kind === 'success' ? '✓' : t.kind === 'warn' ? '!' : t.kind === 'error' ? '✕' : 'ℹ'}</span>
          <span className="grow">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    COMPLETED: 'good',
    FAILED: 'bad',
    CANCELLED: '',
    MANUAL_REVIEW: 'warn',
    NEEDS_VERIFICATION: 'warn',
    QUEUED: '',
    REJECTED: '',
  };
  const cls = map[status] ?? 'accent';
  return <span className={`badge ${cls}`}>{status.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function Trend({ value, suffix = '' }: { value: number | null | undefined; suffix?: string }) {
  if (value == null) return <span className="faint">—</span>;
  return (
    <span className={value > 0 ? 'up' : value < 0 ? 'down' : 'muted'}>
      {value > 0 ? '▲' : value < 0 ? '▼' : '■'} {Math.abs(value).toFixed(1)}%{suffix}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <span className="spinner" /> <div style={{ marginTop: 10 }}>{label}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {children && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * Promise-based confirmation dialog:
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (await confirm({ title, message, confirmLabel })) …
 */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(undefined);
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setOpts(o);
      }),
    [],
  );
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setOpts(null);
  };
  const el = (
    <Dialog open={!!opts} onClose={() => close(false)} size="sm">
      {opts && (
        <div className="stack">
          <h2>{opts.title}</h2>
          <div className="muted" style={{ fontSize: 15 }}>
            {opts.message}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button className="btn ghost" onClick={() => close(false)}>
              Cancel
            </button>
            <button className={`btn ${opts.danger ? 'danger' : 'primary'}`} onClick={() => close(true)} autoFocus>
              {opts.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
  return [confirm, el];
}
