/**
 * Lightweight in-browser card vision (Canvas API only, no OpenCV needed):
 *  - quality: sharpness (Laplacian variance), brightness, glare
 *  - card boundary detection: per-side edge sampling + robust line fit,
 *    corners = line intersections (handles mild rotation & perspective)
 *  - perspective correction: homography warp to a normalized 63:88 card
 */
export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Quality {
  sharpness: number;
  brightness: number;
  glare: number;
  blurry: boolean;
  tooDark: boolean;
  tooBright: boolean;
  hasGlare: boolean;
  ok: boolean;
}
export interface Detection {
  corners: [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL
  confidence: number;
}

export const CARD_RATIO = 63 / 88;
/** Sobel magnitude that counts as a card edge (≈ 15 grey levels of contrast). */
const EDGE_FLOOR = 60;

/**
 * Grayscale plus per-pixel *minimum* channel. Specular glare clips every
 * channel, so min-channel ≥ 252 marks glare while white card stock / borders
 * (which still have some colour cast) do not trip it.
 */
export function toGray(img: ImageData): { g: Float32Array; max: Uint8Array } {
  const n = img.width * img.height;
  const g = new Float32Array(n);
  const max = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = 0.299 * d[j]! + 0.587 * d[j + 1]! + 0.114 * d[j + 2]!;
    max[i] = Math.min(d[j]!, d[j + 1]!, d[j + 2]!);
  }
  return { g, max };
}

export function assessQuality(gray: Float32Array, maxc: Uint8Array, w: number, r: Rect): Quality {
  const x0 = Math.max(1, Math.floor(r.x)), y0 = Math.max(1, Math.floor(r.y));
  const x1 = Math.floor(r.x + r.w) - 1, y1 = Math.floor(r.y + r.h) - 1;
  let sum = 0, n = 0, blown = 0, ls = 0, lsq = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * w + x;
      const v = gray[i]!;
      sum += v;
      if (maxc[i]! >= 252) blown++;
      const lap = 4 * v - gray[i - 1]! - gray[i + 1]! - gray[i - w]! - gray[i + w]!;
      ls += lap;
      lsq += lap * lap;
      n++;
    }
  }
  if (!n) return { sharpness: 0, brightness: 0, glare: 0, blurry: true, tooDark: true, tooBright: false, hasGlare: false, ok: false };
  const mean = ls / n;
  const sharpness = lsq / n - mean * mean;
  const brightness = sum / n;
  const glare = blown / n;
  const q = { sharpness, brightness, glare, blurry: sharpness < 45, tooDark: brightness < 55, tooBright: brightness > 220, hasGlare: glare > 0.06 };
  return { ...q, ok: !q.blurry && !q.tooDark && !q.tooBright && !q.hasGlare };
}

const gradAt = (g: Float32Array, w: number, x: number, y: number, horizontal: boolean) => {
  const i = y * w + x;
  return horizontal
    ? Math.abs(g[i - w + 1]! + 2 * g[i + 1]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - 1]! - g[i + w - 1]!)
    : Math.abs(g[i + w - 1]! + 2 * g[i + w]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - w]! - g[i - w + 1]!);
};

/** Robust least-squares fit of u = a*v + b. */
function fitLine(pts: { u: number; v: number }[]): { a: number; b: number; inliers: number } | null {
  let cur = pts;
  for (let iter = 0; iter < 3; iter++) {
    if (cur.length < 6) return null;
    const n = cur.length;
    let sv = 0, su = 0, svv = 0, svu = 0;
    for (const p of cur) {
      sv += p.v;
      su += p.u;
      svv += p.v * p.v;
      svu += p.v * p.u;
    }
    const den = n * svv - sv * sv;
    if (Math.abs(den) < 1e-6) return null;
    const a = (n * svu - sv * su) / den;
    const b = (su - a * sv) / n;
    const res = cur.map((p) => Math.abs(p.u - (a * p.v + b)));
    const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)]!;
    const tol = Math.max(1.5, med * 2.5);
    const next = cur.filter((_, i) => res[i]! <= tol);
    if (next.length === cur.length || iter === 2) return { a, b, inliers: next.length };
    cur = next;
  }
  return null;
}

/**
 * Detect the card around the on-screen guide. For each side we cast short
 * scan-lines across the expected edge, take the outermost strong gradient
 * and fit a line; the four line intersections are the card corners.
 */
export function detectCard(gray: Float32Array, w: number, h: number, guide: Rect): Detection | null {
  const SAMPLES = 28;
  const bandX = guide.w * 0.22, bandY = guide.h * 0.16;
  type Side = 'left' | 'right' | 'top' | 'bottom';
  const lines: Partial<Record<Side, { a: number; b: number; inliers: number }>> = {};

  for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
    const vertical = side === 'left' || side === 'right';
    const pts: { u: number; v: number }[] = [];
    for (let s = 0; s < SAMPLES; s++) {
      const t = 0.15 + (0.7 * s) / (SAMPLES - 1);
      const v = Math.round(vertical ? guide.y + guide.h * t : guide.x + guide.w * t);
      const edge = vertical ? (side === 'left' ? guide.x : guide.x + guide.w) : side === 'top' ? guide.y : guide.y + guide.h;
      const band = vertical ? bandX : bandY;
      const lim = vertical ? w : h;
      // scan from outside → inside
      const outer = side === 'left' || side === 'top' ? Math.max(2, Math.round(edge - band)) : Math.min(lim - 3, Math.round(edge + band));
      const inner = side === 'left' || side === 'top' ? Math.min(lim - 3, Math.round(edge + band)) : Math.max(2, Math.round(edge - band));
      const step = outer < inner ? 1 : -1;
      const vv = Math.min(Math.max(v, 2), (vertical ? h : w) - 3);
      let best = 0;
      const vals: number[] = [];
      for (let u = outer; u !== inner; u += step) {
        const gm = vertical ? gradAt(gray, w, u, vv, true) : gradAt(gray, w, vv, u, false);
        vals.push(gm);
        if (gm > best) best = gm;
      }
      if (best < 60) continue; // no edge on this scan-line
      // Outermost edge above a fixed strength floor: a weak card border on a
      // dark table must win over strong artwork/text edges further inside.
      // (Random table texture outside the card is rejected by the line fit.)
      const thr = Math.min(best * 0.55, EDGE_FLOOR);
      const k = vals.findIndex((x) => x >= thr);
      if (k >= 0) pts.push({ u: outer + k * step, v: vv });
    }
    const line = fitLine(pts);
    if (!line || line.inliers < SAMPLES * 0.45) return null;
    lines[side] = line;
  }
  const L = lines.left!, R = lines.right!, T = lines.top!, B = lines.bottom!;
  // vertical lines: x = a*y + b ; horizontal lines: y = a*x + b
  const meet = (v: { a: number; b: number }, hz: { a: number; b: number }): Pt => {
    const y = (hz.a * v.b + hz.b) / (1 - hz.a * v.a);
    return { x: v.a * y + v.b, y };
  };
  const corners: [Pt, Pt, Pt, Pt] = [meet(L, T), meet(R, T), meet(R, B), meet(L, B)];
  const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
  const wTop = dist(corners[0], corners[1]), wBot = dist(corners[3], corners[2]);
  const hL = dist(corners[0], corners[3]), hR = dist(corners[1], corners[2]);
  const ratio = (wTop + wBot) / (hL + hR);
  const area = ((wTop + wBot) / 2) * ((hL + hR) / 2);
  if (ratio < 0.55 || ratio > 0.9) return null;
  if (area < guide.w * guide.h * 0.45 || area > guide.w * guide.h * 1.8) return null;
  if (Math.abs(wTop - wBot) / Math.max(wTop, wBot) > 0.25 || Math.abs(hL - hR) / Math.max(hL, hR) > 0.25) return null;
  const confidence = (L.inliers + R.inliers + T.inliers + B.inliers) / (4 * SAMPLES);
  return { corners, confidence };
}

/** Solve the 3×3 homography mapping src[i] → dst[i] (4 point pairs). */
function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination on 8×9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const h = A.map((row, i) => row[8]! / row[i]!);
  return [...h, 1];
}

/** Perspective-correct the quad into an upright W×H card (bilinear sampling). */
export function warpCard(src: ImageData, corners: [Pt, Pt, Pt, Pt], outW = 750): ImageData {
  const outH = Math.round(outW / CARD_RATIO);
  const dst = new ImageData(outW, outH);
  const H = homography(
    [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }],
    corners,
  );
  const sw = src.width, sh = src.height, s = src.data, d = dst.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const z = H[6]! * x + H[7]! * y + H[8]!;
      const sx = (H[0]! * x + H[1]! * y + H[2]!) / z;
      const sy = (H[3]! * x + H[4]! * y + H[5]!) / z;
      const o = (y * outW + x) * 4;
      // outside the frame: repeat the nearest edge pixel (black would create a
      // false "card edge" for the alignment check on padded crops)
      const cx = Math.min(Math.max(sx, 0), sw - 1.001), cy = Math.min(Math.max(sy, 0), sh - 1.001);
      const x0 = cx | 0, y0 = cy | 0, fx = cx - x0, fy = cy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = (s[i00 + c]! * (1 - fx) + s[i10 + c]! * fx) * (1 - fy) + (s[i01 + c]! * (1 - fx) + s[i11 + c]! * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  return dst;
}

/** Normalize exposure: stretch luminance to the 1st–99th percentile. */
export function autoLevels(img: ImageData): ImageData {
  const hist = new Uint32Array(256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 16) hist[Math.round(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!)]!++;
  const total = hist.reduce((a, b) => a + b, 0);
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc < total * 0.01) lo = i;
    if (acc < total * 0.99) hi = i;
  }
  if (hi - lo < 40) return img;
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c]! - lo) * k));
  return img;
}

/**
 * Coarse 8×8 luminance signature of the guide region, mean-removed so mild
 * exposure changes don't matter. Used to tell "same card still in frame"
 * from "a new card was placed".
 */
export function regionSignature(gray: Float32Array, w: number, r: Rect): Float32Array {
  const out = new Float32Array(64);
  const cw = r.w / 8, ch = r.h / 8;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let sum = 0, n = 0;
      for (let y = Math.floor(r.y + cy * ch); y < r.y + (cy + 1) * ch; y += 2) {
        for (let x = Math.floor(r.x + cx * cw); x < r.x + (cx + 1) * cw; x += 2) {
          const v = gray[y * w + x];
          if (v !== undefined) {
            sum += v;
            n++;
          }
        }
      }
      out[cy * 8 + cx] = n ? sum / n : 0;
    }
  }
  const mean = out.reduce((a, b) => a + b, 0) / 64;
  for (let i = 0; i < 64; i++) out[i]! -= mean;
  return out;
}

/** Mean absolute difference between two signatures (0 = identical). */
export function signatureDiff(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < 64; i++) d += Math.abs(a[i]! - b[i]!);
  return d / 64;
}

export type Quad = [Pt, Pt, Pt, Pt];

export const rectQuad = (r: Rect): Quad => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

/** Grow a quad about its centre so each side gains `pad` × its length. */
export function expandQuad(q: Quad, pad: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const k = 1 + 2 * pad;
  return q.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k })) as Quad;
}

/** A capture is treated as misaligned when a corner is off by more than this fraction of the card width. */
export const MISALIGNED = 0.02;

export interface Refinement {
  /** the card's real corners in the padded crop's coordinates */
  corners: Quad;
  /** largest corner offset from where the crop assumed the card was, as a fraction of card width */
  deviation: number;
}

/**
 * Alignment check on a padded crop (card plus a margin). `expected` is where
 * the original crop assumed the card was. Returns the card's actual corners
 * and how far off the assumption was, or null if no card edge is found.
 */
export function refineCrop(gray: Float32Array, w: number, h: number, expected: Rect): Refinement | null {
  const d = detectCard(gray, w, h, expected);
  if (!d) return null;
  const exp = rectQuad(expected);
  const deviation = Math.max(...d.corners.map((p, i) => Math.hypot(p.x - exp[i]!.x, p.y - exp[i]!.y))) / expected.w;
  return { corners: d.corners, deviation };
}
