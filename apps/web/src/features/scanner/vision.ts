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

export type QuarterTurn = 0 | 90 | 180 | 270;
export type DetectionTurn = 0 | 90 | 270;

/** A normalized title-line region, using fractions of the card's width and height. */
export interface OrientationRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OrientationCorrection {
  image: ImageData;
  /** Clockwise degrees applied to the card image. */
  rotation: 0 | 180;
  /** Confidence that a half-turn was needed (0–1; zero when left untouched). */
  confidence: number;
}

export const CARD_RATIO = 63 / 88;

/** Rotate an ImageData clockwise without a canvas round-trip. */
export function rotateImageData(img: ImageData, degrees: QuarterTurn): ImageData {
  if (degrees === 0) return img;
  const width = degrees === 180 ? img.width : img.height;
  const height = degrees === 180 ? img.height : img.width;
  const out = new ImageData(width, height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let dx: number, dy: number;
      if (degrees === 90) (dx = img.height - 1 - y), (dy = x);
      else if (degrees === 180) (dx = img.width - 1 - x), (dy = img.height - 1 - y);
      else (dx = y), (dy = img.width - 1 - x);
      const from = (y * img.width + x) * 4;
      const to = (dy * width + dx) * 4;
      out.data[to] = img.data[from]!;
      out.data[to + 1] = img.data[from + 1]!;
      out.data[to + 2] = img.data[from + 2]!;
      out.data[to + 3] = img.data[from + 3]!;
    }
  }
  return out;
}

function regionEdgeScore(img: ImageData, region: OrientationRegion): number {
  const x0 = Math.max(2, Math.floor(region.left * img.width));
  const y0 = Math.max(2, Math.floor(region.top * img.height));
  const x1 = Math.min(img.width - 2, Math.ceil((region.left + region.width) * img.width));
  const y1 = Math.min(img.height - 2, Math.ceil((region.top + region.height) * img.height));
  if (x1 - x0 < 6 || y1 - y0 < 6) return 0;
  const lum = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
  };
  let score = 0, strong = 0, count = 0;
  // Sample at half resolution; the title uses larger strokes than the tiny
  // copyright/footer text, and the two-pixel derivative ignores camera noise.
  for (let y = y0 + 2; y < y1 - 2; y += 2) {
    for (let x = x0 + 2; x < x1 - 2; x += 2) {
      const edge = Math.abs(lum(x + 2, y) - lum(x - 2, y)) + Math.abs(lum(x, y + 2) - lum(x, y - 2));
      score += Math.max(0, Math.min(1, (edge - 22) / 300));
      if (edge >= 55) strong++;
      count++;
    }
  }
  return count ? score / count + (strong / count) * 0.15 : 0;
}

/**
 * Normalize a cropped card to its title-at-top orientation. The decision is
 * deliberately conservative: compare edge energy in each game's known name
 * region with the region that would occupy the same spot after a half-turn;
 * ambiguous or texture-heavy crops are left untouched.
 */
export function correctCardOrientation(img: ImageData, nameRegions: readonly OrientationRegion[] = []): OrientationCorrection {
  if (!nameRegions.length || img.width < 8 || img.height < 8) return { image: img, rotation: 0, confidence: 0 };
  let topScore = 0, bottomScore = 0;
  for (const r of nameRegions) {
    if (![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) continue;
    const top = regionEdgeScore(img, r);
    const bottom = regionEdgeScore(img, { ...r, left: 1 - r.left - r.width, top: 1 - r.top - r.height });
    topScore = Math.max(topScore, top);
    bottomScore = Math.max(bottomScore, bottom);
  }
  const margin = bottomScore - topScore;
  const ratio = bottomScore / Math.max(topScore, 0.004);
  // A modest evidence floor suppresses flips caused by the card's footer or artwork.
  if (bottomScore >= 0.018 && margin >= 0.008 && ratio >= 1.65) {
    const confidence = Math.max(0, Math.min(1, margin / Math.max(bottomScore, 0.02)));
    return { image: rotateImageData(img, 180), rotation: 180, confidence };
  }
  return { image: img, rotation: 0, confidence: 0 };
}

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
 * Zoom level that would make a card whose width is `cardWFrac` of the frame
 * fill `fill` of the on-screen guide. Viewport height sets the guide size
 * (78% of it); `frameDisplayedW` is the video's rendered width. The result is
 * not clamped — the caller limits it to the device's zoom range and adds a
 * dead band, so a card that nearly fits doesn't nudge the zoom.
 */
export function autoZoomTarget(cardWFrac: number, frameDisplayedW: number, viewportH: number, fill = 0.85): number {
  if (!(cardWFrac > 0) || !(frameDisplayedW > 0) || !(viewportH > 0)) return 1;
  const guideW = viewportH * 0.78 * CARD_RATIO;
  return (fill * guideW) / (cardWFrac * frameDisplayedW);
}

/**
 * Detect the card around the on-screen guide. For each side we cast short
 * scan-lines across the expected edge, take the outermost strong gradient
 * and fit a line; the four line intersections are the card corners.
 */
/** Steepest tilt (slope) accepted for a card side relative to the guide: ~20°. */
const MAX_TILT = 0.36;
/**
 * Largest slope difference allowed between opposite card sides (~14°). A card
 * lying on a desk seen from an angled camera is a mild trapezoid (≈0.15);
 * an outline mixing card and background edges is typically far beyond this.
 */
const MAX_SKEW = 0.25;
/** Support (in scan-lines) a candidate line loses per pixel of distance from the guide edge. */
const GUIDE_PULL = 0.25;

/**
 * The card's edge is the one straight line running along the whole side;
 * background edges are scattered or cover only part of it. From per-scan-line
 * edge candidates, find the line (u = a·v + b) supported by the most scan
 * lines (RANSAC-style, deterministic), discounted by its distance from the
 * guide edge, then least-squares refit on its inliers.
 */
function consensusLine(rows: { v: number; us: number[] }[], guideEdge: number): { a: number; b: number; inliers: number } | null {
  const filled = rows.filter((r) => r.us.length);
  if (filled.length < 6) return null;
  const TOL = 1.6;
  const support = (a: number, b: number) => {
    const pts: { u: number; v: number }[] = [];
    for (const r of filled) {
      const want = a * r.v + b;
      let best = Infinity, bu = 0;
      for (const u of r.us) {
        const d = Math.abs(u - want);
        if (d < best) (best = d), (bu = u);
      }
      if (best <= TOL) pts.push({ u: bu, v: r.v });
    }
    return pts;
  };
  let bestPts: { u: number; v: number }[] = [];
  let bestScore = -Infinity;
  let seed = 9301;
  const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
  const half = Math.floor(filled.length / 2);
  for (let it = 0; it < 240; it++) {
    // one point from each half of the side keeps the pair well separated
    const r1 = filled[rnd(half)]!, r2 = filled[half + rnd(filled.length - half)]!;
    const u1 = r1.us[rnd(r1.us.length)]!, u2 = r2.us[rnd(r2.us.length)]!;
    if (r2.v === r1.v) continue;
    const a = (u2 - u1) / (r2.v - r1.v);
    if (Math.abs(a) > MAX_TILT) continue;
    const b = u1 - a * r1.v;
    const pts = support(a, b);
    const mid = a * ((filled[0]!.v + filled[filled.length - 1]!.v) / 2) + b;
    // the card sits in the guide: a line far outside it needs clearly more support to win
    const score = pts.length - GUIDE_PULL * Math.abs(mid - guideEdge);
    if (score > bestScore) (bestScore = score), (bestPts = pts);
  }
  return bestPts.length ? fitLine(bestPts) : null;
}

/**
 * Detect the card around the on-screen guide. The card rarely fills the guide
 * exactly (held a little nearer or farther), so the search is repeated around
 * guides scaled to 78% and 128% of the given one and the most confident result
 * wins. The given guide is tried first and accepted at once when it is already
 * confident, so the common case costs no more than a single search.
 */
export function detectCard(gray: Float32Array, w: number, h: number, guide: Rect): Detection | null {
  let best: Detection | null = null;
  for (const sc of [1, 0.78, 1.28]) {
    const d = detectAtScale(gray, w, h, sc === 1 ? guide : scaleRect(guide, sc));
    if (d && (!best || d.confidence > best.confidence)) best = d;
    if (best && best.confidence >= 0.6) break;
  }
  return best;
}

export interface OrientedDetection extends Detection {
  /** Rotate the source clockwise by this amount to make the card portrait. */
  rotation: DetectionTurn;
}

function rotateGray(gray: Float32Array, w: number, h: number, degrees: DetectionTurn): { gray: Float32Array; w: number; h: number } {
  if (degrees === 0) return { gray, w, h };
  const width = h, height = w, out = new Float32Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = degrees === 90 ? h - 1 - y : y;
      const dy = degrees === 90 ? x : w - 1 - x;
      out[dy * width + dx] = gray[y * w + x]!;
    }
  }
  return { gray: out, w: width, h: height };
}

function pointInSource(p: Pt, w: number, h: number, degrees: DetectionTurn): Pt {
  if (degrees === 90) return { x: p.y, y: h - 1 - p.x };
  if (degrees === 270) return { x: w - 1 - p.y, y: p.x };
  return p;
}

function guideInRotatedFrame(guide: Rect, w: number, h: number, degrees: DetectionTurn): Rect {
  if (degrees === 0) return guide;
  const cx = guide.x + guide.w / 2, cy = guide.y + guide.h / 2;
  const center = degrees === 90 ? { x: h - 1 - cy, y: cx } : { x: cy, y: w - 1 - cx };
  // `guide` describes the portrait target; after rotating the frame, keep its
  // dimensions and move its centre with the image.
  return { x: center.x - guide.w / 2, y: center.y - guide.h / 2, w: guide.w, h: guide.h };
}

/**
 * Detect a portrait card whether the source image is upright or turned on its
 * side. The returned corner order follows the card's logical top-left, so a
 * later homography can both straighten and orient a 90°/270° source.
 */
export function detectCardAnyOrientation(gray: Float32Array, w: number, h: number, guide: Rect, includeUpright = true): OrientedDetection | null {
  let best: OrientedDetection | null = null;
  const rotations: readonly DetectionTurn[] = includeUpright ? [0, 90, 270] : [90, 270];
  for (const rotation of rotations) {
    const rotated = rotateGray(gray, w, h, rotation);
    const rotatedGuide = guideInRotatedFrame(guide, w, h, rotation);
    const detection = detectCard(rotated.gray, rotated.w, rotated.h, rotatedGuide);
    if (!detection) continue;
    const candidate: OrientedDetection = {
      ...detection,
      corners: detection.corners.map((p) => pointInSource(p, w, h, rotation)) as Detection['corners'],
      rotation,
    };
    // Prefer the unrotated interpretation when evidence ties; side turns are
    // only needed when the expected portrait search did not fit the card.
    if (!best || candidate.confidence > best.confidence + 0.015) best = candidate;
  }
  return best;
}

/** Scale a rect about its centre (the card stays centred when the guide is resized). */
function scaleRect(r: Rect, sc: number): Rect {
  const w = r.w * sc, h = r.h * sc;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

function detectAtScale(gray: Float32Array, w: number, h: number, guide: Rect): Detection | null {
  const SAMPLES = 28;
  const bandX = guide.w * 0.22, bandY = guide.h * 0.16;
  type Side = 'left' | 'right' | 'top' | 'bottom';
  const lines: Partial<Record<Side, { a: number; b: number; inliers: number }>> = {};

  for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
    const vertical = side === 'left' || side === 'right';
    const edge = vertical ? (side === 'left' ? guide.x : guide.x + guide.w) : side === 'top' ? guide.y : guide.y + guide.h;
    const band = vertical ? bandX : bandY;
    const lim = vertical ? w : h;
    const lo = Math.max(2, Math.round(edge - band));
    const hi = Math.min(lim - 3, Math.round(edge + band));
    // every edge candidate on every scan-line: local gradient maxima above the floor
    const rows: { v: number; us: number[] }[] = [];
    for (let s = 0; s < SAMPLES; s++) {
      const t = 0.15 + (0.7 * s) / (SAMPLES - 1);
      const v = Math.min(Math.max(Math.round(vertical ? guide.y + guide.h * t : guide.x + guide.w * t), 2), (vertical ? h : w) - 3);
      const g = (u: number) => (vertical ? gradAt(gray, w, u, v, true) : gradAt(gray, w, v, u, false));
      const us: number[] = [];
      let prev = g(lo - 1), cur = g(lo);
      for (let u = lo; u <= hi; u++) {
        const next = g(u + 1);
        if (cur >= EDGE_FLOOR && cur >= prev && cur > next) {
          // parabolic interpolation of the peak: the edge sits between pixels,
          // and the warp is only as accurate as the corners it is given
          const den = prev - 2 * cur + next;
          const frac = den < 0 ? Math.max(-1, Math.min(1, (0.5 * (prev - next)) / den)) : 0;
          us.push(u + frac);
        }
        prev = cur;
        cur = next;
      }
      rows.push({ v, us });
    }
    const line = consensusLine(rows, edge);
    if (!line || line.inliers < SAMPLES * 0.45) return null;
    lines[side] = line;
  }
  // opposite sides of a card seen roughly head-on are close to parallel; a
  // quad mixing card and background edges usually isn't
  if (Math.abs(lines.left!.a - lines.right!.a) > MAX_SKEW || Math.abs(lines.top!.a - lines.bottom!.a) > MAX_SKEW) return null;
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

/**
 * Contrast-stretch a grayscale frame for detection: percentile stretch
 * (1st–99th) plus a mild sharpen. Used as a fallback when the raw frame
 * yields no card — low-contrast scenes (haze, dim light, a dark card on a
 * dark table) push the card's gradients below the edge floor, and this lifts
 * them back above it. Only ever a fallback, so it can't do worse than the
 * raw frame (which already failed).
 */
export function enhanceGray(g: Float32Array, w: number, h: number): Float32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, Math.round(g[i]!)))]!++;
  const total = g.length;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc < total * 0.01) lo = i;
    if (acc < total * 0.99) hi = i;
  }
  const out = new Float32Array(g.length);
  if (hi - lo < 6) {
    out.set(g); // near-uniform: stretching would only amplify noise
    return out;
  }
  const k = 255 / (hi - lo);
  for (let i = 0; i < g.length; i++) out[i] = Math.max(0, Math.min(255, (g[i]! - lo) * k));
  // mild sharpen: soft edges lose gradient magnitude, and the detector needs it
  const src = new Float32Array(out);
  const amt = 0.25;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * src[i]! - src[i - 1]! - src[i + 1]! - src[i - w]! - src[i + w]!;
      out[i] = Math.max(0, Math.min(255, src[i]! + amt * lap));
    }
  }
  return out;
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
 * Mild unsharp mask (5-tap Laplacian): adds back the high-frequency detail a
 * bilinear warp and a soft camera take away, so small print like collector
 * numbers reads better. Kept gentle — a strong sharpen halos the digits.
 */
export function sharpen(img: ImageData, amount = 0.3): ImageData {
  const { width: w, height: h, data: d } = img;
  const src = new Uint8ClampedArray(d); // neighbours are read while writing
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c]!;
        const lap = 4 * v - src[i - 4 + c]! - src[i + 4 + c]! - src[i - w * 4 + c]! - src[i + w * 4 + c]!;
        d[i + c] = v + amount * lap;
      }
    }
  }
  return img;
}

/** Final polish for a warped card: exposure normalization, then a mild sharpen. */
export function finishCard(img: ImageData): ImageData {
  autoLevels(img);
  sharpen(img);
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
export const MISALIGNED = 0.01;

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

/** Grayscale, box-filtered down to `outW` pixels wide (no canvas needed). */
export function grayDownscale(img: ImageData, outW: number): { g: Float32Array; w: number; h: number; sc: number } {
  const sc = outW / img.width;
  const w = outW, h = Math.max(1, Math.round(img.height * sc));
  const sum = new Float32Array(w * h), cnt = new Float32Array(w * h);
  const d = img.data, iw = img.width;
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(h - 1, (y * sc) | 0);
    for (let x = 0; x < iw; x++) {
      const j = (y * iw + x) * 4, t = ty * w + Math.min(w - 1, (x * sc) | 0);
      sum[t] = sum[t]! + 0.299 * d[j]! + 0.587 * d[j + 1]! + 0.114 * d[j + 2]!;
      cnt[t] = cnt[t]! + 1;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i]! / cnt[i]! : 0;
  return { g: sum, w, h, sc };
}

export interface CapturePlan {
  /** the crop as captured: along the live outline, or the guide when there is none */
  original: ImageData;
  /** a crop along the card's re-found edges, when they differ from the original crop */
  adjusted: ImageData | null;
  /** how far the original crop was off (fraction of card width); null if it couldn't be checked */
  deviation: number | null;
  /** true unless the original crop was verified to sit on the card's real edges */
  needsReview: boolean;
}

/** Margin searched around the live outline, and (wider) around the guide as a fallback. */
export const LIVE_PAD = 0.08;
export const GUIDE_PAD = 0.15;

/**
 * Re-find the card's edges inside `quad` grown by `pad`. Returns the card's
 * corners in frame coordinates and how far they are from `quad`, or null.
 */
function locateAround(frame: ImageData, quad: Quad, pad: number, analysisW: number): { corners: Quad; deviation: number } | null {
  const outW = 600; // working resolution of the padded crop
  const padW = Math.round(outW * (1 + 2 * pad));
  const big = expandQuad(quad, pad);
  const padded = warpCard(frame, big, padW);
  const { g, w, h, sc } = grayDownscale(padded, analysisW);
  const outH = outW / CARD_RATIO;
  const expected = { x: ((padded.width - outW) / 2) * sc, y: ((padded.height - outH) / 2) * sc, w: outW * sc, h: outH * sc };
  const r = refineCrop(g, w, h, expected);
  if (!r) return null;
  // map the corners from padded-crop space back into the frame through the same homography warpCard used
  const H = homography(
    [{ x: 0, y: 0 }, { x: padW - 1, y: 0 }, { x: padW - 1, y: padded.height - 1 }, { x: 0, y: padded.height - 1 }],
    big,
  );
  const toFrame = (p: Pt): Pt => {
    const x = p.x / sc, y = p.y / sc, z = H[6]! * x + H[7]! * y + H[8]!;
    return { x: (H[0]! * x + H[1]! * y + H[2]!) / z, y: (H[3]! * x + H[4]! * y + H[5]!) / z };
  };
  return { corners: r.corners.map(toFrame) as Quad, deviation: r.deviation };
}

function quadDeviation(corners: Quad, expected: Quad): number {
  const width = Math.hypot(expected[1].x - expected[0].x, expected[1].y - expected[0].y);
  if (!(width > 0)) return Infinity;
  return Math.max(...corners.map((p, i) => Math.hypot(p.x - expected[i]!.x, p.y - expected[i]!.y))) / width;
}

/** Find an upright or side-turned card in the full frame, then map its logical corners back. */
function locateAnyOrientation(frame: ImageData, guide: Rect, analysisW: number): { corners: Quad; rotation: DetectionTurn; confidence: number } | null {
  const { g, w, h, sc } = grayDownscale(frame, analysisW);
  const scaledGuide = { x: guide.x * sc, y: guide.y * sc, w: guide.w * sc, h: guide.h * sc };
  let detection = detectCardAnyOrientation(g, w, h, scaledGuide);
  if (!detection) detection = detectCardAnyOrientation(enhanceGray(g, w, h), w, h, scaledGuide);
  if (!detection) return null;
  return {
    corners: detection.corners.map((p) => ({ x: p.x / sc, y: p.y / sc })) as Quad,
    rotation: detection.rotation,
    confidence: detection.confidence,
  };
}

/**
 * Decide what a capture produces. The photo is saved without asking only when
 * the card's real edges were re-found and match the crop. A wrong live outline
 * (cut-off, angled crop) or one that can't be checked goes to review: first
 * the card is searched for around the outline, then around the guide, then in
 * the full frame at upright and side-turned orientations. If found, a corrected
 * crop is offered.
 */
export function planCapture(frame: ImageData, live: Quad | null, guide: Rect, minW = 750, analysisW = 360, maxW = minW): CapturePlan {
  const base = live ?? rectQuad(guide);
  // keep the camera's detail: as wide as the card appears in the frame
  // (between minW and maxW), so small print like collector numbers survives
  const seen = (Math.hypot(base[1].x - base[0].x, base[1].y - base[0].y) + Math.hypot(base[2].x - base[3].x, base[2].y - base[3].y)) / 2;
  const outW = Math.round(Math.min(maxW, Math.max(minW, seen)));
  const original = warpCard(frame, base, outW);
  let found = live ? locateAround(frame, live, LIVE_PAD, analysisW) : null;
  if (found && found.deviation <= MISALIGNED) return { original, adjusted: null, deviation: found.deviation, needsReview: false };
  let deviation = found?.deviation ?? null;
  if (!found) {
    const expected = base;
    const g = locateAround(frame, rectQuad(guide), GUIDE_PAD, analysisW);
    if (g) {
      const dev = quadDeviation(g.corners, expected);
      if (dev <= MISALIGNED) return { original, adjusted: null, deviation: dev, needsReview: false };
      found = { corners: g.corners, deviation: dev };
    }

    // A portrait-only search misses a card that was photographed on its side.
    // Retry the full frame at 90°/270° and prefer a real side-turn over a weak
    // guide-local fit; an accepted result becomes the corrected review crop.
    const oriented = locateAnyOrientation(frame, guide, analysisW);
    if (oriented) {
      const dev = quadDeviation(oriented.corners, expected);
      if (oriented.rotation !== 0 || !found || dev < found.deviation) found = { corners: oriented.corners, deviation: dev };
    }
    deviation = found?.deviation ?? null;
    if (found && found.deviation <= MISALIGNED) return { original, adjusted: null, deviation: found.deviation, needsReview: false };
  }
  return { original, adjusted: found ? warpCard(frame, found.corners, outW) : null, deviation, needsReview: true };
}

/**
 * Convenience form for an uploaded photo: find the card around `guide` and
 * return a straightened, polished crop, or null if the card cannot be found.
 * `nameRegions` enables conservative 180° correction; callers that need a
 * keep/retake decision should use `planCapture` and present its crops.
 */
export function correctPhoto(
  frame: ImageData,
  guide: Rect,
  minW = 750,
  analysisW = 360,
  maxW = 1500,
  nameRegions: readonly OrientationRegion[] = [],
): ImageData | null {
  const plan = planCapture(frame, null, guide, minW, analysisW, maxW);
  const img = plan.adjusted ?? (plan.needsReview ? null : plan.original);
  if (!img) return null;
  const orientation = correctCardOrientation(img, nameRegions);
  finishCard(orientation.image);
  return orientation.image;
}
