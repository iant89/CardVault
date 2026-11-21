import { useState } from 'react';
import { Link } from 'react-router';
import { useLive, ACTIVE_STATES } from '../../stores/live';

/** Persistent mini queue (desktop), always visible while jobs are running. */
export function JobMonitor() {
  const jobs = useLive((s) => s.jobs);
  const [open, setOpen] = useState(true);
  const active = jobs.filter((j) => ACTIVE_STATES.includes(j.status));
  const queued = jobs.filter((j) => j.status === 'QUEUED');
  if (!active.length && !queued.length) return null;
  return (
    <div className="monitor">
      <div className="panel">
        <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
          <strong>
            <span className="dot good pulse" /> &nbsp;Processing {active.length}
            {queued.length ? <span className="faint"> · {queued.length} queued</span> : null}
          </strong>
          <span className="faint">{open ? '▾' : '▴'}</span>
        </div>
        {open && (
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {active.slice(0, 4).map((j) => (
              <div key={j.id}>
                <div className="row between" style={{ fontSize: 13 }}>
                  <span className="truncate" style={{ fontWeight: 700 }}>
                    {j.label ?? 'Scan'}
                  </span>
                  <span className="faint">{j.progress}%</span>
                </div>
                <div className="faint truncate" style={{ fontSize: 12 }}>
                  {j.stage}
                </div>
                <div className="progress" style={{ marginTop: 4 }}>
                  <div style={{ width: `${j.progress}%` }} />
                </div>
              </div>
            ))}
            <Link to="/queue" style={{ fontSize: 13 }}>
              Open queue →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
