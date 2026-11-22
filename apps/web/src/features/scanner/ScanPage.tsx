import { useCallback, useEffect, useRef, useState } from 'react';
import { useOfflineQueue } from './offlineQueue';
import {
  assessQuality,
  autoLevels,
  CARD_RATIO,
  detectCard,
  planCapture,
  regionSignature,
  signatureDiff,
  toGray,
  type Detection,
  type Quad,
  type Quality,
  type Rect,
} from './vision';
import { useLive } from '../../stores/live';
import { StatusBadge, useConfirm } from '../../components/ui';
import { toast } from '../../stores/toasts';
import { api, ApiError } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { ScanSidebar } from './ScanSidebar';
import { canEdit, useScanEdit } from './useScanEdit';
import { beep, IDENTIFIED, NEEDS_REVIEW, STATUS_LABEL, type ScanDetail, type ScanListItem } from './scanTypes';

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
/** The frame must be empty this long before auto-capture re-arms (stops a hand passing over the card from re-triggering it). */
const REARM_EMPTY_MS = 700;
/** Batch mode: how long "✓ Captured" shows before prompting for the next card. */
const CAPTURED_MS = 2000;
/** Below this signature difference the card in frame is treated as the one just captured. */
const SAME_CARD_DIFF = 12;
/** A different card must be visible this many analysis frames (~1 s) before it re-arms auto-capture. */
const NEW_CARD_FRAMES = 8;

type Phase = 'idle' | 'captured' | 'ready';

/** Output width of a captured card image (height follows the 63:88 ratio). */
const OUT_W = 750;
/** Captures keep up to this width when the camera sees the card larger (sharper text for OCR). */
const MAX_OUT_W = 1500;

interface AlignReview {
  original: { blob: Blob; url: string };
  /** the straightened crop; null when the card's edges couldn't be found to correct it */
  adjusted: { blob: Blob; url: string } | null;
  quality: Record<string, unknown>;
  target: { scanId: string; name: string } | null;
}

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

/** iOS often hands us HEIC; convert to a modest JPEG the API can always decode. */
async function preparePhoto(f: File): Promise<Blob> {
  if (f.type === 'image/jpeg' || f.size > 60_000_000) return f;
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
    return blob ?? f;
  } catch {
    // Older browsers may not decode the selected type — let the server try it.
    return f;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisRef = useRef<HTMLCanvasElement | null>(null);
  const detRef = useRef<{ det: Detection | null; stable: number; armed: boolean; last: Detection | null; emptySince: number | null; newCard: number }>({
    det: null,
    stable: 0,
    armed: true,
    last: null,
    emptySince: null,
    newCard: 0,
  });
  const qualityRef = useRef<Quality | null>(null);
  /** coarse look of the last captured card, to recognise when a different card is placed */
  const lastSigRef = useRef<Float32Array | null>(null);
  /** set by "Scan another card": reopen disarmed so the card just scanned isn't captured again */
  const reopenDisarmed = useRef(false);
  const camGen = useRef(0);
  const lastFrameSig = useRef<Float32Array | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const phaseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionStart] = useState(() => Date.now() - 1000);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(pref('device', ''));
  const [res, setRes] = useState<Res>(pref('res', '1080p') as Res);
  const [game, setGame] = useState(pref('game', ''));
  const [auto, setAuto] = useState(pref('auto', 'true') === 'true');
  const [batch, setBatch] = useState(pref('batch', 'true') === 'true');
  const [sound, setSound] = useState(pref('sound', 'true') === 'true');
  const [sideCollapsed, setSideCollapsed] = useState(pref('side', 'open') === 'collapsed');
  const [camState, setCamState] = useState<'starting' | 'on' | 'paused' | 'denied' | 'unavailable'>('starting');
  const [camError, setCamError] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const lowResWarned = useRef(false);
  const [found, setFound] = useState(false);
  const [flash, setFlash] = useState(0);
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [torch, setTorch] = useState<boolean | null>(null);
  /** single mode: the capture being shown after the camera closes */
  const [captured, setCaptured] = useState<{ localId: string; url: string } | null>(null);
  /** retake mode: the next capture replaces this scan's photo */
  const [retake, setRetakeState] = useState<{ scanId: string; name: string } | null>(null);
  const retakeRef = useRef<{ scanId: string; name: string } | null>(null);
  const setRetake = (v: { scanId: string; name: string } | null) => {
    retakeRef.current = v;
    setRetakeState(v);
  };
  const [confirm, confirmDialog] = useConfirm();
  /** alignment review after a misaligned capture */
  const [review, setReviewState] = useState<AlignReview | null>(null);
  const reviewRef = useRef<AlignReview | null>(null);
  const setReview = (v: AlignReview | null) => {
    reviewRef.current = v;
    setReviewState(v);
  };

  const { items, add, discard, retry, online, uploadedIds, uploaded } = useOfflineQueue();
  const jobs = useLive((s) => s.jobs);
  const scans = useAsync(() => api.get<{ scans: ScanListItem[] }>('/api/scans?limit=50'), []);
  const { edit, dialog } = useScanEdit();

  // refresh the scan list whenever a job event arrives or an upload lands
  useEffect(() => {
    scans.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, uploaded]);

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  useEffect(() => () => clearTimeout(phaseTimer.current), []);

  // ---- camera lifecycle
  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startCamera = useCallback(async () => {
    const gen = ++camGen.current;
    stopCamera();
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
      if (gen !== camGen.current) {
        // a newer start (or unmount) superseded this one — don't leave a live camera behind
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
      if (caps.focusMode?.includes('continuous')) await track!.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      setTorch(caps.torch ? false : null);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      Object.assign(detRef.current, { det: null, last: null, stable: 0, armed: !reopenDisarmed.current, emptySince: null, newCard: 0 });
      reopenDisarmed.current = false;
      setCamState('on');
      // the guide covers a fixed share of the frame, so the camera's resolution
      // sets how many pixels the card's small print gets
      const got = track?.getSettings?.().height ?? videoRef.current?.videoHeight ?? 0;
      if (got && got < 900 && !lowResWarned.current) {
        lowResWarned.current = true;
        toast(`Camera is running at ${got}p: small print like collector numbers may not be readable. Choose 1080p or 4K in the camera settings if your camera supports it.`, 'info');
      }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
    } catch (e) {
      if (gen !== camGen.current) return;
      const err = e as DOMException;
      setCamState(err.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      setCamError(err.name === 'NotAllowedError' ? 'Camera permission was denied.' : err.message || 'No camera found.');
    }
  }, [deviceId, res]);

  useEffect(() => {
    void startCamera();
    return () => {
      camGen.current++;
      stopCamera();
    };
  }, [startCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch == null) return;
    await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }).catch(() => undefined);
    setTorch(!torch);
  };

  // ---- geometry: guide rectangle in video pixel space
  const guideInVideo = useCallback((): Rect | null => {
    const v = videoRef.current,
      vp = vpRef.current;
    if (!v || !vp || !v.videoWidth) return null;
    const W = vp.clientWidth,
      H = vp.clientHeight;
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    const offX = (W - v.videoWidth * scale) / 2,
      offY = (H - v.videoHeight * scale) / 2;
    const gh = H * 0.78,
      gw = gh * CARD_RATIO;
    return { x: ((W - gw) / 2 - offX) / scale, y: ((H - gh) / 2 - offY) / scale, w: gw / scale, h: gh / scale };
  }, []);

  // ---- capture
  const toBlob = (img: ImageData) => {
    const oc = document.createElement('canvas');
    oc.width = img.width;
    oc.height = img.height;
    oc.getContext('2d')!.putImageData(img, 0, 0);
    return new Promise<Blob | null>((res) => oc.toBlob(res, 'image/jpeg', 0.92));
  };

  /** Queue a final image and continue the single/batch flow. */
  const commitCapture = useCallback(
    async (blob: Blob, quality: Record<string, unknown>, target: { scanId: string; name: string } | null) => {
      toast(target ? `Captured — replacing the photo of ${target.name}` : 'Captured', 'success');
      const localId = await add(blob, { gameHint: game || undefined, replaceScanId: target?.scanId, label: target?.name, quality });
      if (batch) {
        // "✓ Captured" → 2 s later "Ready for the next card…"
        clearTimeout(phaseTimer.current);
        setPhase('captured');
        phaseTimer.current = setTimeout(() => setPhase('ready'), CAPTURED_MS);
      } else if (localId) {
        // single: close the camera and show this card's result
        stopCamera();
        setCamState('paused');
        setCaptured({ localId, url: URL.createObjectURL(blob) });
      }
    },
    [add, game, batch],
  );

  const capture = useCallback(
    async (source: 'auto' | 'manual') => {
      const v = videoRef.current;
      const guide = guideInVideo();
      if (!v || !guide || reviewRef.current) return;
      detRef.current.armed = false; // wait for the card to be removed before the next auto shot
      detRef.current.emptySince = null;
      detRef.current.newCard = 0;
      lastSigRef.current = lastFrameSig.current;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const frame = ctx.getImageData(0, 0, c.width, c.height);
      const k = v.videoWidth / ANALYSIS_W;
      const det = detRef.current.det;
      const q = qualityRef.current;

      // the crop along the live outline (or guide), re-checked against the card's
      // real edges; anything not verified goes to the keep/retake review
      const live = det ? (det.corners.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad) : null;
      const plan = planCapture(frame, live, guide, OUT_W, ANALYSIS_W, MAX_OUT_W);
      const original = plan.original;

      setFlash((f) => f + 1);
      if (sound) beep();
      navigator.vibrate?.(30);
      const target = retakeRef.current;
      setRetake(null);
      const quality = {
        source,
        detected: !!det,
        detectionConfidence: det?.confidence ?? null,
        alignment: plan.deviation == null ? null : Math.round(plan.deviation * 1000) / 1000,
        ...(q ? { sharpness: Math.round(q.sharpness), brightness: Math.round(q.brightness), glare: q.glare } : {}),
      };

      autoLevels(original);
      const originalBlob = await toBlob(original);
      if (!originalBlob) return;
      if (!plan.needsReview) {
        await commitCapture(originalBlob, quality, target);
        return;
      }

      // not verified: offer the corrected crop (if the card was found) and ask
      let adjusted: { blob: Blob; url: string } | null = null;
      if (plan.adjusted) {
        autoLevels(plan.adjusted);
        const b = await toBlob(plan.adjusted);
        if (b) adjusted = { blob: b, url: URL.createObjectURL(b) };
      }
      setReview({
        original: { blob: originalBlob, url: URL.createObjectURL(originalBlob) },
        adjusted,
        quality,
        target,
      });
    },
    [add, game, guideInVideo, batch, sound, commitCapture],
  );

  // ---- alignment review decisions
  const closeReview = () => {
    const rv = reviewRef.current;
    if (rv) {
      URL.revokeObjectURL(rv.original.url);
      if (rv.adjusted) URL.revokeObjectURL(rv.adjusted.url);
    }
    setReview(null);
  };
  const acceptAdjusted = async () => {
    const rv = reviewRef.current;
    if (!rv?.adjusted) return;
    closeReview();
    await commitCapture(rv.adjusted.blob, { ...rv.quality, adjusted: true }, rv.target);
  };
  const useOriginal = async () => {
    const rv = reviewRef.current;
    if (!rv) return;
    closeReview();
    await commitCapture(rv.original.blob, { ...rv.quality, adjusted: false }, rv.target);
  };
  const retakeCapture = () => {
    const rv = reviewRef.current;
    closeReview();
    if (rv?.target) setRetake(rv.target); // a sidebar retake stays a retake
    // the same card is expected back in frame: arm for it immediately
    lastSigRef.current = null;
    Object.assign(detRef.current, { armed: true, stable: 0, newCard: 0, emptySince: null });
    setPhase('idle');
    toast('Retake — adjust the card and hold it steady', 'info');
  };

  // ---- retake & delete from the scans sidebar
  const startRetake = async (scan: ScanListItem) => {
    const name = scan.cardName ?? 'this card';
    const identified = IDENTIFIED.includes(scan.status);
    const ok = await confirm({
      title: 'Retake photo?',
      message: identified ? (
        <>
          <p style={{ margin: 0 }}>
            <strong>{name}</strong> has already been identified. Retaking removes that identification and the copy it added to your collection (including any condition, price or notes you edited), then identifies the card again from the new photo.
          </p>
          <p style={{ marginBottom: 0 }}>The current photo is kept until the new one is taken.</p>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>The current photo will be replaced by the next one you take. The card stays in the queue and is identified from the new photo.</p>
          <p style={{ marginBottom: 0 }}>The current photo is kept until the new one is taken.</p>
        </>
      ),
      confirmLabel: 'Retake photo',
    });
    if (!ok) return;
    setRetake({ scanId: scan.id, name });
    if (captured) URL.revokeObjectURL(captured.url);
    setCaptured(null);
    // arm for the same card: a retake is allowed (expected) to show the card just scanned
    clearTimeout(phaseTimer.current);
    setPhase('idle');
    lastSigRef.current = null;
    Object.assign(detRef.current, { armed: true, stable: 0, newCard: 0, emptySince: null });
    if (camState !== 'on') {
      reopenDisarmed.current = false;
      void startCamera();
    }
    vpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); // on phones the list sits below the camera
    toast(`Retaking ${name} — place the card in the frame`, 'info');
  };

  const deleteScan = async (scan: ScanListItem) => {
    const name = scan.cardName ?? 'this card';
    const identified = IDENTIFIED.includes(scan.status);
    const ok = await confirm({
      title: 'Delete scan?',
      message: (
        <p style={{ margin: 0 }}>
          The photo of <strong>{name}</strong> and its place in the queue will be removed.
          {identified ? ' The copy it added to your collection will be removed too.' : ''} This can't be undone.
        </p>
      ),
      confirmLabel: 'Delete scan',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/scans/${scan.id}`);
      if (retakeRef.current?.scanId === scan.id) setRetake(null);
      toast(`Deleted scan of ${name}`, 'info');
      scans.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Delete failed', 'error');
      scans.reload();
    }
  };

  const scanAnother = () => {
    if (captured) URL.revokeObjectURL(captured.url);
    setCaptured(null);
    // if the card just scanned is still in front of the camera, wait for the swap
    reopenDisarmed.current = true;
    setPhase('ready');
    void startCamera();
  };

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
      const { g, max } = toGray(ctx.getImageData(0, 0, a.width, a.height));
      const guide = { x: guideV.x * s, y: guideV.y * s, w: guideV.w * s, h: guideV.h * s };
      const q = assessQuality(g, max, a.width, guide);
      const det = detectCard(g, a.width, a.height, guide);
      const st = detRef.current;
      const sig = det ? regionSignature(g, a.width, guide) : null;
      lastFrameSig.current = sig;
      if (det && st.last) {
        const move = det.corners.reduce((acc, p, i) => acc + Math.hypot(p.x - st.last!.corners[i]!.x, p.y - st.last!.corners[i]!.y), 0) / 4;
        st.stable = move < guide.w * 0.02 ? st.stable + 1 : 0;
      } else st.stable = 0;
      // Re-arm after a capture when either:
      //  - the frame has been empty for REARM_EMPTY_MS (card lifted away), or
      //  - a clearly different card has been in view for NEW_CARD_FRAMES (quick swap).
      // A hand passing over the same card does neither.
      if (det) st.emptySince = null;
      else {
        st.emptySince ??= t;
        if (t - st.emptySince >= REARM_EMPTY_MS) st.armed = true;
      }
      if (!st.armed && det && sig && lastSigRef.current) {
        st.newCard = signatureDiff(sig, lastSigRef.current) >= SAME_CARD_DIFF ? st.newCard + 1 : 0;
        if (st.newCard >= NEW_CARD_FRAMES) st.armed = true;
      }
      // a new card has arrived after the prompt — back to normal guidance
      if (phaseRef.current === 'ready' && st.armed && det) setPhase('idle');
      st.last = det;
      st.det = det;
      qualityRef.current = q;
      setQuality(q);
      setFound(!!det);
      drawOverlay(det, s);
      if (auto && st.armed && det && q.ok && st.stable >= STABLE_FRAMES && !reviewRef.current) void capture('auto');
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [camState, auto, capture, guideInVideo]);

  const drawOverlay = (det: Detection | null, s: number) => {
    const c = overlayRef.current,
      v = videoRef.current,
      vp = vpRef.current;
    if (!c || !v || !vp) return;
    const W = vp.clientWidth,
      H = vp.clientHeight;
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!det) return;
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    const offX = (W - v.videoWidth * scale) / 2,
      offY = (H - v.videoHeight * scale) / 2;
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

  const hint =
    phase === 'captured'
      ? '✓ CAPTURED'
      : phase === 'ready'
        ? 'READY FOR THE NEXT CARD…'
        : !quality || !found
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
    // a sidebar retake also applies to an uploaded photo
    const target = retakeRef.current;
    try {
      toast('Preparing photo…', 'info');
      const blob = await preparePhoto(f);
      const localId = await add(blob, { gameHint: game || undefined, quality: { source: 'file' }, replaceScanId: target?.scanId, label: target?.name });
      if (!localId) {
        toast('Not signed in — sign in again and retry.', 'error');
        return;
      }
      setRetake(null);
      toast(target ? `Captured — replacing the photo of ${target.name}` : 'Captured — uploading now', 'success');
      if (!batch) {
        stopCamera();
        setCamState('paused');
        setCaptured({ localId, url: URL.createObjectURL(blob) });
      }
    } catch (e) {
      toast(e instanceof Error ? `Photo failed: ${e.message}` : 'Photo failed', 'error');
    }
  };

  const setMode = (b: boolean) => {
    setBatch(b);
    savePref('batch', String(b));
    setPhase('idle');
  };

  const scanList = scans.data?.scans ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Scan</h1>
          <p>Point → Scan → Done. Identification and research continue in the background.</p>
        </div>
        <div className="row wrap">
          <span className="badge">
            <span className={`dot ${camState === 'on' ? 'good' : camState === 'starting' ? 'warn pulse' : camState === 'paused' ? '' : 'bad'}`} /> Camera{' '}
            {camState === 'on' ? 'connected' : camState === 'paused' ? 'closed' : camState}
          </span>
          {!online && <span className="badge warn">Server offline — saving locally</span>}
        </div>
      </div>

      <div className={`scanner ${sideCollapsed ? 'collapsed' : ''}`}>
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="viewport" ref={vpRef}>
            <video ref={videoRef} playsInline muted autoPlay style={{ visibility: captured ? 'hidden' : 'visible' }} />
            <canvas ref={overlayRef} className="overlay-canvas" style={{ visibility: captured ? 'hidden' : 'visible' }} />
            {!captured && (
              <div className={`guide ${found || phase === 'captured' ? 'found' : ''} ${phase !== 'idle' ? 'prompt' : ''}`}>
                {camState === 'on' && <div className="hint">{hint}</div>}
              </div>
            )}
            <div className={`capture-flash ${flash ? 'go' : ''}`} key={flash} />

            {!captured && (
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
            )}
            {retake && !captured && (
              <div className="retake-banner" role="status">
                <span>📷 Retaking photo · {retake.name}</span>
                <button className="btn sm" onClick={() => setRetake(null)}>
                  Cancel
                </button>
              </div>
            )}
            <div className="vp-mode" role="group" aria-label="Scan mode">
              <button className={!batch ? 'on' : ''} onClick={() => setMode(false)} title="Close the camera after each card">
                Single
              </button>
              <button className={batch ? 'on' : ''} onClick={() => setMode(true)} title="Keep scanning — swap cards one after another">
                Batch
              </button>
            </div>

            {camState !== 'on' && !captured && camState !== 'paused' && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
                {camState === 'starting' ? <span className="spinner" /> : <div className="muted">{camError}</div>}
              </div>
            )}

            {review && (
              <AlignmentReview review={review} onKeepCorrected={() => void acceptAdjusted()} onKeepOriginal={() => void useOriginal()} onRetake={retakeCapture} />
            )}
            {review ? null : captured ? (
              <SingleResult
                captured={captured}
                pending={items.find((i) => i.id === captured.localId)}
                scan={scanList.find((s) => s.id === uploadedIds[captured.localId])}
                onAnother={scanAnother}
                onEdit={(s) => void edit(s)}
              />
            ) : (
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
            )}
          </div>

          <div className="chip-row">
            {GAMES.map((g) => (
              <button key={g.slug} className={`chip ${game === g.slug ? 'on' : ''}`} onClick={() => (setGame(g.slug), savePref('game', g.slug))}>
                {g.label}
              </button>
            ))}
          </div>

          <div className="scan-tools">
            {quality && camState === 'on' && (
              <div className="panel stack" style={{ gap: 10 }}>
                <h3>Capture quality</h3>
                <Meter label="Focus" value={(quality.sharpness / 200) * 100} good={!quality.blurry} text={quality.blurry ? 'blurry' : 'sharp'} />
                <Meter label="Lighting" value={(quality.brightness / 255) * 100} good={!quality.tooDark && !quality.tooBright} text={quality.tooDark ? 'dark' : quality.tooBright ? 'bright' : 'good'} />
                <Meter label="Glare" value={100 - Math.min(100, quality.glare * 1500)} good={!quality.hasGlare} text={quality.hasGlare ? 'glare' : 'none'} />
                <Meter label="Card" value={found ? 100 : 10} good={found} text={found ? 'found' : 'searching'} />
              </div>
            )}
            <div className="stack">
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
                  <label className="checkbox">
                    <input type="checkbox" checked={sound} onChange={(e) => (setSound(e.target.checked), savePref('sound', String(e.target.checked)))} /> Beep on capture
                  </label>
                  <div className="faint" style={{ fontSize: 13 }}>
                    Tips: plain dark background, even light from above, card flat inside the frame. Sleeves and top-loaders add glare.
                  </div>
                </div>
              </details>
              <button className="btn" style={{ width: '100%' }} onClick={() => fileInputRef.current?.click()}>
                ⇪ Upload photo instead
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = ''; // allow picking the same photo again
                  if (f) void onFile(f);
                }}
              />
            </div>
          </div>
        </div>

        <ScanSidebar
          scans={scanList}
          pending={items}
          sessionStart={sessionStart}
          collapsed={sideCollapsed}
          onToggle={() => {
            setSideCollapsed((c) => {
              savePref('side', c ? 'open' : 'collapsed');
              return !c;
            });
          }}
          onEdit={(s) => void edit(s)}
          onRetry={(id) => void retry(id)}
          onDiscard={(id) => void discard(id)}
          onRetake={(sc) => void startRetake(sc)}
          onDelete={(sc) => void deleteScan(sc)}
          retakingId={retake?.scanId ?? null}
        />
      </div>
      {dialog}
      {confirmDialog}
    </div>
  );
}

/** Single mode: the camera is closed and this card's progress is shown in its place. */
function SingleResult({
  captured,
  pending,
  scan,
  onAnother,
  onEdit,
}: {
  captured: { url: string };
  pending?: { status: string; error?: string };
  scan?: ScanListItem;
  onAnother: () => void;
  onEdit: (s: ScanListItem) => void;
}) {
  // once identified, show how many copies the owner now has (they share pricing)
  const identified = !!scan && IDENTIFIED.includes(scan.status);
  const owned = useAsync(
    () => (identified ? api.get<ScanDetail>(`/api/scans/${scan!.id}`).then((d) => d.owned) : Promise.resolve(null)),
    [scan?.id, identified],
  ).data;
  const title =
    pending?.status === 'failed'
      ? 'Upload rejected'
      : scan
        ? (scan.cardName ?? (NEEDS_REVIEW.includes(scan.status) ? 'Needs a quick review' : 'Identifying…'))
        : 'Uploading…';
  const copies = owned?.copies ?? 0;
  return (
    <div className="single-result">
      <img src={captured.url} alt="Captured card" />
      <div className="single-card panel">
        <div className="row between" style={{ gap: 8 }}>
          <strong className="truncate">{title}</strong>
          {scan && <StatusBadge status={scan.status} />}
        </div>
        <div className="faint" style={{ fontSize: 13 }}>
          {pending?.status === 'failed'
            ? pending.error
            : scan
              ? identified
                ? `${STATUS_LABEL[scan.status]}${scan.confidence != null ? ` · ${(scan.confidence * 100).toFixed(0)}% match` : ''}${
                    copies > 1 ? ` · you now have ${copies} copies (shared pricing)` : ''
                  }`
                : STATUS_LABEL[scan.status]
              : pending?.error
                ? `Waiting to upload: ${pending.error}`
                : 'Saved on this device — it uploads automatically.'}
        </div>
        <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {scan && canEdit(scan.status, scan.collectionItemId) && (
            <button className="btn sm" onClick={() => onEdit(scan)}>
              Edit
            </button>
          )}
          <button className="btn sm primary" onClick={onAnother}>
            ◉ Scan another card
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown when a capture looked misaligned: the corrected and original crops
 * side by side, with one choice — keep corrected, keep original or retake.
 */
function AlignmentReview({
  review,
  onKeepCorrected,
  onKeepOriginal,
  onRetake,
}: {
  review: AlignReview;
  onKeepCorrected: () => void;
  onKeepOriginal: () => void;
  onRetake: () => void;
}) {
  const corrected = review.adjusted;
  return (
    <div className="single-result align-review" role="dialog" aria-label="Check card alignment">
      <div className={`align-pair ${corrected ? '' : 'single'}`}>
        {corrected && (
          <figure className="align-option recommended">
            <img src={corrected.url} alt="Corrected card" />
            <figcaption>Corrected</figcaption>
          </figure>
        )}
        <figure className="align-option">
          <img src={review.original.url} alt="Original capture" />
          <figcaption>Original</figcaption>
        </figure>
      </div>
      <div className="single-card panel">
        <strong>{corrected ? 'This card looked misaligned, so we corrected it.' : 'We couldn’t find the card’s edges to check this photo.'}</strong>
        <div className="faint" style={{ fontSize: 13 }}>
          {corrected ? 'Compare the two and choose which photo to keep — or retake it.' : 'Make sure the whole card is in the photo and straight. Keep it, or retake?'}
        </div>
        <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn sm ghost" onClick={onRetake}>
            Retake
          </button>
          <button className={`btn sm ${corrected ? '' : 'primary'}`} onClick={onKeepOriginal} autoFocus={!corrected}>
            Keep original
          </button>
          {corrected && (
            <button className="btn sm primary" onClick={onKeepCorrected} autoFocus>
              Keep corrected
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
