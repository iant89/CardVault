import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { api, money } from '../../services/api';
import { StatusBadge } from '../../components/ui';
import { CameraIcon, TrashIcon } from '../../components/icons';
import type { PendingView } from './offlineQueue';
import { canEdit } from './useScanEdit';
import { IDENTIFIED, IN_PROGRESS, NEEDS_REVIEW, STATUS_LABEL, type ScanDetail, type ScanListItem } from './scanTypes';

interface Props {
  scans: ScanListItem[];
  pending: PendingView[];
  sessionStart: number;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (scan: ScanListItem) => void;
  onRetake: (scan: ScanListItem) => void;
  onDelete: (scan: ScanListItem) => void;
  /** scan currently being retaken (camera armed for it) */
  retakingId: string | null;
  onDuplicate: (id: string, action: 'add' | 'cancel') => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

const statusTone = (s: string) =>
  IDENTIFIED.includes(s) ? 'good' : NEEDS_REVIEW.includes(s) ? 'warn' : s === 'FAILED' || s === 'REJECTED' ? 'bad' : 'info';

const narrow = () => window.matchMedia('(max-width: 1000px)').matches;
const TIP_W = 300;

/** Collapsible list of recent scans (newest first) with live status tooltips. */
export function ScanSidebar({ scans, pending, sessionStart, collapsed, onToggle, onEdit, onRetake, onDelete, retakingId, onDuplicate, onRetry, onDiscard }: Props) {
  const [open, setOpen] = useState<{ id: string; top: number; left: number; inline: boolean } | null>(null);
  const [details, setDetails] = useState<Record<string, ScanDetail>>({});
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // session running totals (local captures not yet uploaded count as processing)
  const session = scans.filter((s) => new Date(s.createdAt).getTime() >= sessionStart);
  const waiting = pending.filter((p) => p.status !== 'duplicate' && p.status !== 'failed').length;
  const undecided = pending.filter((p) => p.status === 'duplicate').length;
  const totals = {
    scanned: session.length + waiting + undecided,
    identified: session.filter((s) => IDENTIFIED.includes(s.status)).length,
    review: session.filter((s) => NEEDS_REVIEW.includes(s.status)).length,
    processing: session.filter((s) => IN_PROGRESS.includes(s.status)).length + waiting,
    failed: session.filter((s) => s.status === 'FAILED').length,
  };

  const load = (id: string) =>
    void api
      .get<ScanDetail>(`/api/scans/${id}`)
      .then((d) => setDetails((m) => ({ ...m, [id]: d })))
      .catch(() => undefined);

  // keep the open tooltip live as the scan moves through the pipeline
  const openStatus = scans.find((s) => s.id === open?.id)?.status;
  useEffect(() => {
    if (open) load(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id, openStatus]);

  const show = (id: string, el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    if (narrow()) return;
    const r = el.getBoundingClientRect();
    const top = Math.max(70, Math.min(r.top, window.innerHeight - 340));
    setOpen({ id, top, left: Math.max(8, r.left - TIP_W - 12), inline: false });
  };
  const hide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen((o) => (o && !o.inline ? null : o)), 180);
  };
  const tap = (id: string) => {
    if (!narrow()) return;
    setOpen((o) => (o?.id === id ? null : { id, top: 0, left: 0, inline: true }));
  };

  if (collapsed) {
    return (
      <aside className="panel scan-side collapsed">
        <button className="scan-rail" onClick={onToggle} aria-label="Show scans">
          <span>‹</span>
          <strong>{totals.scanned}</strong>
          <span className="rail-label">Scans</span>
          {totals.review > 0 && <span className="count">{totals.review}</span>}
        </button>
      </aside>
    );
  }

  const dupes = pending.filter((p) => p.status === 'duplicate');
  const queued = pending.filter((p) => p.status !== 'duplicate');
  const tipScan = open ? scans.find((s) => s.id === open.id) : undefined;

  const tip = (s: ScanListItem, inline: boolean) => (
    <div
      className={`scan-tip ${inline ? 'inline' : ''}`}
      style={inline ? undefined : { top: open!.top, left: open!.left, width: TIP_W }}
      onMouseEnter={() => clearTimeout(hideTimer.current)}
      onMouseLeave={hide}
      role="tooltip"
    >
      <ScanTip scan={s} detail={details[s.id]} onEdit={() => onEdit(s)} />
    </div>
  );

  return (
    <aside className="panel scan-side">
      <div className="scan-side-head">
        <div className="row between">
          <h3>Scans</h3>
          <button className="btn ghost icon sm" onClick={onToggle} aria-label="Collapse scans">
            ›
          </button>
        </div>
        <div className="scan-totals">
          <span>
            <strong>{totals.scanned}</strong> scanned
          </span>
          <span className="up">
            <strong>{totals.identified}</strong> identified
          </span>
          {totals.processing > 0 && (
            <span>
              <strong>{totals.processing}</strong> processing
            </span>
          )}
          {totals.review > 0 && (
            <Link to="/review" style={{ color: 'var(--warn)' }}>
              <strong>{totals.review}</strong> review
            </Link>
          )}
          {totals.failed > 0 && (
            <span className="down">
              <strong>{totals.failed}</strong> failed
            </span>
          )}
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          This session
        </div>
      </div>

      <div className="scan-list">
        {dupes.map((d) => (
          <div key={d.id} className="scan-dupe">
            <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <img src={d.url} alt="" />
              <div className="grow" style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>You already scanned this card.</strong>
                <div className="faint truncate" style={{ fontSize: 12 }}>
                  {d.duplicate?.cardName ?? 'Earlier scan'}
                </div>
                <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
                  <button className="btn sm primary" onClick={() => onDuplicate(d.id, 'add')}>
                    Add copy
                  </button>
                  {d.duplicate?.cardId && (
                    <Link className="btn sm" to={`/collection?card=${d.duplicate.cardId}`}>
                      View
                    </Link>
                  )}
                  <button className="btn sm ghost" onClick={() => onDuplicate(d.id, 'cancel')}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}

        {queued.map((p) => (
          <div key={p.id} className="scan-item" title={p.error}>
            <div className="thumb">
              <img src={p.url} alt="" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>
                {p.status === 'failed' ? 'Upload rejected' : p.replaceScanId ? `Retake: ${p.label ?? 'scan'}` : 'New capture'}
              </div>
              <div className="faint truncate" style={{ fontSize: 12 }}>
                {p.status === 'failed' ? p.error : p.status === 'uploading' ? 'Uploading…' : p.attempts ? 'Waiting for server…' : 'Queued on this device'}
              </div>
            </div>
            {p.status === 'failed' ? (
              <div className="row" style={{ gap: 2 }}>
                <button className="btn sm ghost" onClick={() => onRetry(p.id)}>
                  Retry
                </button>
                <button className="btn sm ghost icon" onClick={() => onDiscard(p.id)} aria-label="Discard">
                  ✕
                </button>
              </div>
            ) : (
              <span className="spinner" style={{ width: 14, height: 14 }} />
            )}
          </div>
        ))}

        {scans.map((s) => (
          <div key={s.id}>
            <div
              className={`scan-item ${open?.id === s.id ? 'open' : ''}`}
              onMouseEnter={(e) => show(s.id, e.currentTarget)}
              onMouseLeave={hide}
              onClick={() => tap(s.id)}
              tabIndex={0}
              onFocus={(e) => show(s.id, e.currentTarget)}
              onBlur={hide}
            >
              <div className="thumb">{(s.thumbnail ?? s.cardImage) && <img src={s.thumbnail ?? s.cardImage!} alt="" />}</div>
              <div style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>
                  {s.cardName ?? (NEEDS_REVIEW.includes(s.status) ? 'Unknown card' : 'Identifying…')}
                </div>
                <div className="truncate" style={{ fontSize: 12 }}>
                  <span className={`st-${statusTone(retakingId === s.id ? 'RETAKE' : s.status)}`}>{retakingId === s.id ? 'Retaking…' : (STATUS_LABEL[s.status] ?? s.status)}</span>
                  <span className="faint"> · {new Date(s.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              </div>
              <div className="row scan-actions" style={{ gap: 2 }}>
                <button
                  className={`btn ghost icon sm ${retakingId === s.id ? 'on' : ''}`}
                  title="Retake photo"
                  aria-label={`Retake photo of ${s.cardName ?? 'this scan'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetake(s);
                  }}
                >
                  <CameraIcon />
                </button>
                <button
                  className="btn ghost icon sm danger-hover"
                  title="Delete scan"
                  aria-label={`Delete scan of ${s.cardName ?? 'unknown card'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
            {open?.id === s.id && open.inline && tip(s, true)}
          </div>
        ))}

        {!scans.length && !pending.length && <div className="faint" style={{ padding: 12, fontSize: 14 }}>Captured cards appear here, newest first.</div>}
      </div>

      {open && !open.inline && tipScan && createPortal(tip(tipScan, false), document.body)}
    </aside>
  );
}

function ScanTip({ scan, detail, onEdit }: { scan: ScanListItem; detail?: ScanDetail; onEdit: () => void }) {
  const job = detail?.jobs[0];
  const card = detail?.card;
  const variant = card?.variants.find((v) => v.id === detail?.scan.variantId)?.type;
  const guess = detail?.identifications.find((i) => i.cardId && i.name);
  const ocr = detail?.identifications.find((i) => i.ocrTop)?.ocrTop?.trim();
  const status = detail?.scan.status ?? scan.status;
  const editable = canEdit(status, detail?.scan.collectionItemId ?? scan.collectionItemId);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <strong>{STATUS_LABEL[status] ?? status}</strong>
        <StatusBadge status={status} />
      </div>
      {job?.stage && !IDENTIFIED.includes(status) && <div className="faint" style={{ fontSize: 13 }}>{job.stage}</div>}
      {job && job.progress < 100 && !['COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED'].includes(job.status) && (
        <div className="progress">
          <div style={{ width: `${job.progress}%` }} />
        </div>
      )}

      {!detail ? (
        <div className="faint">
          <span className="spinner" style={{ width: 14, height: 14 }} /> Loading…
        </div>
      ) : card ? (
        <dl className="tip-kv">
          <dt>Card</dt>
          <dd>{card.name}</dd>
          <dt>Game</dt>
          <dd>{card.game.name}</dd>
          <dt>Set</dt>
          <dd>{card.set?.name ?? '—'}</dd>
          <dt>Number</dt>
          <dd className="mono">{card.collectorNumber || '—'}</dd>
          {card.rarity && (
            <>
              <dt>Rarity</dt>
              <dd>{card.rarity}</dd>
            </>
          )}
          {variant && (
            <>
              <dt>Variant</dt>
              <dd>{variant.replace(/_/g, ' ').toLowerCase()}</dd>
            </>
          )}
          {detail.scan.confidence != null && (
            <>
              <dt>Confidence</dt>
              <dd>{(detail.scan.confidence * 100).toFixed(1)}%</dd>
            </>
          )}
          <dt>Market</dt>
          <dd>{card.price?.market != null ? money(card.price.market) : status === 'RESEARCHING' ? 'researching…' : '—'}</dd>
        </dl>
      ) : (
        <div style={{ fontSize: 13 }}>
          {guess ? (
            <div>
              Best guess: <strong>{guess.name}</strong>
              <span className="faint">
                {' '}
                · {guess.setName} {guess.collectorNumber} · {(guess.confidence * 100).toFixed(0)}%
              </span>
            </div>
          ) : IN_PROGRESS.includes(status) ? (
            <div className="faint">Not parsed yet.</div>
          ) : (
            <div className="faint">No catalog match.</div>
          )}
          {ocr && (
            <div className="faint mono" style={{ fontSize: 12, marginTop: 4 }}>
              Read: {ocr.slice(0, 60)}
            </div>
          )}
          {job?.error && <div className="down" style={{ fontSize: 12, marginTop: 4 }}>{job.error}</div>}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn sm primary" disabled={!editable} onClick={onEdit} title={editable ? undefined : 'Available once the card has been identified'}>
          Edit
        </button>
      </div>
    </div>
  );
}
