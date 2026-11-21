import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useOfflineQueue } from './offlineQueue';
import { assessQuality, autoLevels, CARD_RATIO, detectCard, toGray, warpCard, type Detection, type Quality, type Rect } from './vision';
import { useLive } from '../../stores/live';
import { StatusBadge } from '../../components/ui';
import { toast } from '../../stores/toasts';

const GAMES = [
  { slug: '', label: 'Auto-detect' },
  { slug: 'pokemon', label: 'Pokémon' },
  { slug: 'magic', label: 'Magic' },
  { slug: 'yugioh', label: 'Yu-Gi-Oh!' },
  { slug: 'football', label: 'Football' },
  { slug: 'baseball', label: 'Baseball' },
  { slug: 'basketball', label: 'Basketball' },
  { slug: 'hockey', label: 'Hockey' },
];
const RESOLUTIONS = { '720p': [1280, 720], '1080p': [1920, 1080], '4K': [3840, 2160] } as const;
type Res = keyof typeof RESOLUTIONS;
const ANALYSIS_W = 360;
const STABLE_FRAMES = 7;

const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(`cv:scan:${k}`) ?? d;
  } catch {
    return d;
  }
};
const savePref = (k: string, v: string) => {
  try {
    localStorage.setItem(`cv:scan:${k}`, v);
  } catch {
    /* ignore */
  }
};

function Meter({ label, value, good, text }: { label: string; value: number; good: boolean; text: string }) {
  return (
    <div className="meter">
      <span className="muted">{label}</span>
      <div className="bar">
        <div style={{ width: `${Math.max(4, Math.min(100, value))}%`, background: good ? 'var(--good)' : 'var(--warn)' }} />
      </div>
      <span style={{ textAlign: 'right', color: good ? 'var(--good)' : 'var(--warn)', fontWeight: 700 }}>{text}</span>
    </div>
  );
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisRef = useRef<HTMLCanvasElement | null>(null);
  const detRef = useRef<{ det: Detection | null; stable: number; armed: boolean; last: Detection | null }>({ det: null, stable: 0, armed: true, last: null });

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(pref('device', ''));
  const [res, setRes] = useState<Res>(pref('res', '1080p') as Res);
  const [game, setGame] = useState(pref('game', ''));
  const [auto, setAuto] = useState(pref('auto', 'true') === 'true');
  const [camState, setCamState] = useState<'starting' | 'on' | 'denied' | 'unavailable'>('starting');
  const [camError, setCamError] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const qualityRef = useRef<Quality | null>(null);
  const [found, setFound] = useState(false);
  const [flash, setFlash] = useState(0);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [count, setCount] = useState(0);

  const { items, add, resolveDuplicate, discard, retry, online } = useOfflineQueue();
  const jobs = useLive((s) => s.jobs);
  const recent = jobs.filter((j) => j.queue === 'identification' || j.scanId).slice(0, 12);

  // ---- camera lifecycle
  const startCamera = useCallback(async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamState('unavailable');
      setCamError(window.isSecureContext ? 'This browser has no camera API.' : 'Camera access needs HTTPS (or localhost). Use the photo upload below, or serve CardVault over HTTPS.');
      return;
    }
    setCamState('starting');
    const [w, h] = RESOLUTIONS[res];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: w },
          height: { ideal: h },
        },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
      if (caps.focusMode?.includes('continuous')) await track!.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      setTorch(caps.torch ? false : null);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCamState('on');
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      setDevices(list);
    } catch (e) {
      const err = e as DOMException;
      setCamState(err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      setCamError(err.name === 'NotAllowedError' ? 'Camera permission was denied.' : err.message || 'No camera found.');
    }
  }, [deviceId, res]);

  useEffect(() => {
    void startCamera();
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, [startCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch == null) return;
    await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }).catch(() => undefined);
    setTorch(!torch);
  };

  // ---- geometry: guide rectangle in video pixel space
  const guideInVideo = useCallback((): Rect | null => {
    const v = videoRef.current, vp = vpRef.current;
    if (!v || !vp || !v.videoWidth) return null;
    const W = vp.clientWidth, H = vp.clientHeight;
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    const offX = (W - v.videoWidth * scale) / 2, offY = (H - v.videoHeight * scale) / 2;
    const gh = H * 0.78, gw = gh * CARD_RATIO;
    return { x: ((W - gw) / 2 - offX) / scale, y: ((H - gh) / 2 - offY) / scale, w: gw / scale, h: gh / scale };
  }, []);

  // ---- capture
  const capture = useCallback(
    async (source: 'auto' | 'manual') => {
      const v = videoRef.current;
      const guide = guideInVideo();
      if (!v || !guide) return;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const k = v.videoWidth / ANALYSIS_W;
      const det = detRef.current.det;
      const q = qualityRef.current;
      let out: ImageData;
      if (det) {
        // 1-3. crop + perspective + rotation correction from detected corners
        out = warpCard(ctx.getImageData(0, 0, c.width, c.height), det.corners.map((p) => ({ x: p.x * k, y: p.y * k })) as Detection['corners']);
      } else {
        // fallback: crop the guide rectangle
        const gx = Math.max(0, guide.x), gy = Math.max(0, guide.y);
        const t = document.createElement('canvas');
        t.width = 750;
        t.height = Math.round(750 / CARD_RATIO);
        t.getContext('2d')!.drawImage(c, gx, gy, guide.w, guide.h, 0, 0, t.width, t.height);
        out = t.getContext('2d')!.getImageData(0, 0, t.width, t.height);
      }
      autoLevels(out); // 4. normalize
      const oc = document.createElement('canvas');
      oc.width = out.width;
      oc.height = out.height;
      oc.getContext('2d')!.putImageData(out, 0, 0);
      const blob = await new Promise<Blob | null>((r) => oc.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) return;
      setFlash((f) => f + 1);
      navigator.vibrate?.(30);
      setCount((n) => n + 1);
      await add(blob, {
        gameHint: game || undefined,
        quality: { source, detected: !!det, detectionConfidence: det?.confidence ?? null, ...(q ? { sharpness: Math.round(q.sharpness), brightness: Math.round(q.brightness), glare: q.glare } : {}) },
      }); // 5. saved (local queue → server)
      detRef.current.armed = false; // wait for the card to be removed before next auto shot
    },
    [add, game, guideInVideo],
  );

  // ---- analysis loop (~8 fps)
  useEffect(() => {
    if (camState !== 'on') return;
    let raf = 0;
    let last = 0;
    analysisRef.current ??= document.createElement('canvas');
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 120) return;
      last = t;
      const v = videoRef.current;
      const guideV = guideInVideo();
      if (!v || !guideV || v.readyState < 2) return;
      const a = analysisRef.current!;
      const s = ANALYSIS_W / v.videoWidth;
      a.width = ANALYSIS_W;
      a.height = Math.round(v.videoHeight * s);
      const ctx = a.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0, a.width, a.height);
      const img = ctx.getImageData(0, 0, a.width, a.height);
      const { g, max } = toGray(img);
      const guide = { x: guideV.x * s, y: guideV.y * s, w: guideV.w * s, h: guideV.h * s };
      const q = assessQuality(g, max, a.width, guide);
      const det = detectCard(g, a.width, a.height, guide);
      const st = detRef.current;
      if (det && st.last) {
        const move = det.corners.reduce((acc, p, i) => acc + Math.hypot(p.x - st.last!.corners[i]!.x, p.y - st.last!.corners[i]!.y), 0) / 4;
        st.stable = move < guide.w * 0.02 ? st.stable + 1 : 0;
      } else st.stable = 0;
      if (!det) {
        // card removed → re-arm auto capture
        if (st.det == null) st.armed = true;
      }
      st.last = det;
      st.det = det;
      qualityRef.current = q;
      setQuality(q);
      setFound(!!det);
      drawOverlay(det, s);
      if (auto && st.armed && det && q.ok && st.stable >= STABLE_FRAMES) void capture('auto');
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camState, auto, capture, guideInVideo]);

  const drawOverlay = (det: Detection | null, s: number) => {
    const c = overlayRef.current, v = videoRef.current, vp = vpRef.current;
    if (!c || !v || !vp) return;
    const W = vp.clientWidth, H = vp.clientHeight;
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!det) return;
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    const offX = (W - v.videoWidth * scale) / 2, offY = (H - v.videoHeight * scale) / 2;
    const map = (p: { x: number; y: number }) => [(p.x / s) * scale + offX, (p.y / s) * scale + offY] as const;
    ctx.beginPath();
    det.corners.forEach((p, i) => (i ? ctx.lineTo(...map(p)) : ctx.moveTo(...map(p))));
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#3ddc97';
    ctx.fillStyle = 'rgba(61,220,151,.08)';
    ctx.fill();
    ctx.stroke();
  };

  const hint = !quality
    ? 'PLACE CARD HERE'
    : !found
      ? 'PLACE CARD HERE'
      : quality.tooDark
        ? 'MORE LIGHT'
        : quality.hasGlare
          ? 'TILT TO REDUCE GLARE'
          : quality.blurry
            ? 'HOLD STEADY — FOCUSING'
            : auto
              ? 'HOLD STILL…'
              : 'READY';

  const onFile = async (f: File) => {
    await add(f, { gameHint: game || undefined, quality: { source: 'file' } });
    setCount((n) => n + 1);
    toast('Photo queued', 'success');
  };

  const dupes = items.filter((i) => i.status === 'duplicate');
  const pend = items.filter((i) => i.status !== 'duplicate');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Scan</h1>
          <p>Point → Scan → Done. Identification and research continue in the background.</p>
        </div>
        <div className="row wrap">
          <span className="badge">
            <span className={`dot ${camState === 'on' ? 'good' : camState === 'starting' ? 'warn pulse' : 'bad'}`} /> Camera {camState === 'on' ? 'connected' : camState}
          </span>
          {!online && <span className="badge warn">Server offline — saving locally</span>}
          {count > 0 && <span className="badge accent">{count} this session</span>}
        </div>
      </div>

      <div className="scanner">
        <div className="stack">
          <div className="viewport" ref={vpRef}>
            <video ref={videoRef} playsInline muted autoPlay />
            <canvas ref={overlayRef} className="overlay-canvas" />
            <div className={`guide ${found ? 'found' : ''}`}>{camState === 'on' && <div className="hint">{hint}</div>}</div>
            <div className={`capture-flash ${flash ? 'go' : ''}`} key={flash} />
            <div className="vp-status">
              {quality && camState === 'on' && (
                <>
                  <span className={`badge ${quality.blurry ? 'warn' : 'good'}`}>{quality.blurry ? 'Blurry' : 'Sharp'}</span>
                  <span className={`badge ${quality.tooDark || quality.tooBright ? 'warn' : 'good'}`}>{quality.tooDark ? 'Dark' : quality.tooBright ? 'Bright' : 'Light OK'}</span>
                  {quality.hasGlare && <span className="badge warn">Glare</span>}
                  {found && <span className="badge good">Card detected</span>}
                </>
              )}
            </div>
            {camState !== 'on' && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
                {camState === 'starting' ? <span className="spinner" /> : <div className="muted">{camError}</div>}
              </div>
            )}
            <div className="vp-bottom">
              {torch != null && (
                <button className="btn icon" onClick={() => void toggleTorch()} aria-label="Toggle light" style={{ background: torch ? 'var(--warn)' : undefined }}>
                  ☀
                </button>
              )}
              <button className={`shutter ${auto ? 'auto' : ''}`} onClick={() => void capture('manual')} disabled={camState !== 'on'} aria-label="Scan card" />
              <button className={`btn sm ${auto ? 'primary' : ''}`} onClick={() => (setAuto(!auto), savePref('auto', String(!auto)))}>
                Auto {auto ? 'on' : 'off'}
              </button>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {GAMES.map((g) => (
              <button key={g.slug} className={`chip ${game === g.slug ? 'on' : ''}`} onClick={() => (setGame(g.slug), savePref('game', g.slug))}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <div className="stack">
          {dupes.map((d) => (
            <div className="panel" key={d.id} style={{ borderColor: 'rgba(255,200,87,.5)' }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <img src={d.url} alt="" style={{ width: 54, borderRadius: 6 }} />
                <div className="grow">
                  <strong>You already scanned this card.</strong>
                  <div className="faint" style={{ fontSize: 13 }}>
                    {d.duplicate?.cardName ?? 'Earlier scan'} · {d.duplicate ? new Date(d.duplicate.createdAt).toLocaleString() : ''}
                  </div>
                  <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                    <button className="btn sm primary" onClick={() => void resolveDuplicate(d.id, 'add')}>
                      Add another copy
                    </button>
                    {d.duplicate?.cardId && (
                      <Link className="btn sm" to={`/collection?card=${d.duplicate.cardId}`}>
                        View existing
                      </Link>
                    )}
                    <button className="btn sm ghost" onClick={() => void resolveDuplicate(d.id, 'cancel')}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {quality && camState === 'on' && (
            <div className="panel stack" style={{ gap: 10 }}>
              <h3>Capture quality</h3>
              <Meter label="Focus" value={(quality.sharpness / 200) * 100} good={!quality.blurry} text={quality.blurry ? 'blurry' : 'sharp'} />
              <Meter label="Lighting" value={(quality.brightness / 255) * 100} good={!quality.tooDark && !quality.tooBright} text={quality.tooDark ? 'dark' : quality.tooBright ? 'bright' : 'good'} />
              <Meter label="Glare" value={100 - Math.min(100, quality.glare * 1500)} good={!quality.hasGlare} text={quality.hasGlare ? 'glare' : 'none'} />
              <Meter label="Card" value={found ? 100 : 10} good={found} text={found ? 'found' : 'searching'} />
            </div>
          )}

          <div className="panel stack" style={{ gap: 10 }}>
            <div className="row between">
              <h3>This session</h3>
              <Link to="/queue" style={{ fontSize: 13 }}>
                Queue →
              </Link>
            </div>
            {pend.length > 0 && (
              <>
                <div className="faint" style={{ fontSize: 13 }}>
                  Uploading ({pend.length})
                </div>
                <div className="thumbs">
                  {pend.map((p) => (
                    <div className="thumb" key={p.id} title={p.error}>
                      <img src={p.url} alt="" />
                      <div className="st" style={{ color: p.status === 'failed' ? 'var(--bad)' : undefined }} onClick={() => (p.status === 'failed' ? void retry(p.id) : undefined)}>
                        {p.status === 'failed' ? 'retry' : p.status === 'uploading' ? '↑' : p.attempts ? 'waiting' : 'queued'}
                      </div>
                      {p.status === 'failed' && (
                        <button className="btn ghost icon sm" style={{ position: 'absolute', top: 0, right: 0 }} onClick={() => void discard(p.id)} aria-label="Discard">
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {recent.length ? (
              <div className="stack" style={{ gap: 6 }}>
                {recent.map((j) => (
                  <div key={j.id} className="row" style={{ gap: 10, fontSize: 14 }}>
                    <div className="thumb" style={{ width: 34, flex: 'none' }}>
                      {j.thumbnail && <img src={j.thumbnail} alt="" />}
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 600 }}>
                        {j.label}
                      </div>
                      <div className="faint truncate" style={{ fontSize: 12 }}>
                        {j.stage}
                      </div>
                    </div>
                    <StatusBadge status={j.status} />
                  </div>
                ))}
              </div>
            ) : (
              !pend.length && <div className="faint">Captured cards appear here.</div>
            )}
          </div>

          <details className="panel">
            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Camera settings</summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <label className="field">
                <span>Camera</span>
                <select className="select" value={deviceId} onChange={(e) => (setDeviceId(e.target.value), savePref('device', e.target.value))}>
                  <option value="">Default (rear)</option>
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Resolution</span>
                <select className="select" value={res} onChange={(e) => (setRes(e.target.value as Res), savePref('res', e.target.value))}>
                  {Object.keys(RESOLUTIONS).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <div className="faint" style={{ fontSize: 13 }}>
                Tips: plain dark background, even light from above, card flat inside the frame. Sleeves and top-loaders add glare.
              </div>
            </div>
          </details>

          <label className="btn" style={{ width: '100%' }}>
            ⇪ Upload photo instead
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
          </label>
        </div>
      </div>
    </div>
  );
}
