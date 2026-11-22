import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../services/api';
import { toast } from '../stores/toasts';

interface DevTool {
  id: string;
  name: string;
  url: string;
  available: boolean;
  running: boolean;
  managed: boolean;
  state?: string;
  done?: number;
  total?: number;
  failed?: number;
  error?: string;
}

const STATE_LABEL: Record<string, string> = {
  idle: 'Running · idle',
  discovering: 'Discovering sets…',
  running: 'Downloading',
  paused: 'Paused',
  finished: 'Finished',
};

function statusLine(t: DevTool): { text: string; dot: string } {
  if (t.error) return { text: t.error, dot: 'bad' };
  if (!t.available && !t.running) return { text: 'Not installed on this server', dot: 'bad' };
  if (!t.running) return { text: 'Not running: Open starts it', dot: '' };
  const pct = t.total ? Math.floor(((t.done ?? 0) / t.total) * 100) : null;
  const label = STATE_LABEL[t.state ?? ''] ?? 'Running';
  const progress = t.total ? ` · ${pct}% (${(t.done ?? 0).toLocaleString()} / ${t.total.toLocaleString()})` : '';
  const failed = t.failed ? ` · ${t.failed} failed` : '';
  return { text: `${label}${progress}${failed}`, dot: t.state === 'running' || t.state === 'discovering' ? 'good pulse' : t.state === 'paused' ? 'warn' : 'good' };
}

/**
 * Developer menu (administrators only): tools that run beside CardVault on the
 * server. Opening one starts it if needed and shows it in a new tab, served
 * through CardVault so it works from any device.
 */
export function DevMenu() {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<DevTool[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ tools: DevTool[] }>('/api/dev/tools');
      setTools(r.tools);
    } catch (e) {
      // DEV_TOOLS turned off on the server
      if (e instanceof ApiError && e.status === 404) setHidden(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [open, load]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, []);

  if (hidden) return null;

  const openTool = async (t: DevTool) => {
    // open the tab now, while the click still counts (pop-up blockers), and
    // point it at the tool once it's running
    const tab = window.open('', '_blank');
    tab?.document.write('<title>Starting…</title><body style="font:16px system-ui;background:#0b0b14;color:#ccc;display:grid;place-items:center;height:100vh;margin:0">Starting the TCGdex Harvester…</body>');
    setBusy(t.id);
    try {
      const r = t.running ? t : await api.post<DevTool>(`/api/dev/harvester/start`);
      if (tab) tab.location.href = r.url ?? t.url;
      else window.location.href = t.url;
      void load();
    } catch (e) {
      tab?.close();
      toast(e instanceof Error ? e.message : 'Could not start the tool', 'error');
    } finally {
      setBusy(null);
    }
  };

  const stopTool = async (t: DevTool) => {
    setBusy(t.id);
    try {
      await api.post('/api/dev/harvester/stop');
      toast(`${t.name} stopped. Its queue is saved and resumes next time.`);
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not stop the tool', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dev-menu" ref={ref}>
      <button className={`dev-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Developer tools">
        <span aria-hidden="true" className="dev-ico">
          {'</>'}
        </span>
        <span className="hide-mobile">Developer</span>
        {tools?.some((t) => t.running && t.state === 'running') && <span className="dot good pulse" />}
      </button>
      {open && (
        <div className="menu dev-panel" role="menu">
          <div className="dev-head">Developer tools</div>
          <Link to="/dev/ocr" className="dev-link" onClick={() => setOpen(false)}>
            <span className="dev-link-ico" aria-hidden="true">Aa</span>
            <span>
              <strong>OCR Lab</strong>
              <span className="faint dev-desc">Collected lines, the frozen exam and engine scores.</span>
            </span>
          </Link>
          {!tools && <div className="dev-empty faint">Loading…</div>}
          {tools?.map((t) => {
            const s = statusLine(t);
            return (
              <div key={t.id} className="dev-tool">
                <div className="dev-tool-main">
                  <strong>{t.name}</strong>
                  <span className="dev-status">
                    <span className={`dot ${s.dot}`} /> {s.text}
                  </span>
                  <span className="faint dev-desc">Downloads every card image and its data from TCGdex, for OCR training.</span>
                </div>
                <div className="dev-actions">
                  <button className="btn sm primary" disabled={busy === t.id || (!t.available && !t.running) || !!t.error} onClick={() => void openTool(t)}>
                    {busy === t.id ? 'Starting…' : t.running ? 'Open' : 'Start & open'}
                  </button>
                  {t.running && t.managed && (
                    <button className="btn sm ghost" disabled={busy === t.id} onClick={() => void stopTool(t)}>
                      Stop
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
