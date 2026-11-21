import { describe, expect, it } from 'vitest';
import { detectCard, regionSignature, signatureDiff, CARD_RATIO, type Pt } from './vision';

/**
 * Synthetic analysis frame: a card rotated by `deg` on a flat table, with a
 * border, a body and a bright title bar near the top (the case that used to
 * pull the detected top edge onto the text).
 */
function frame(opts: { deg: number; bg: number; border: number; body: number; title: number; w?: number; h?: number }) {
  const W = opts.w ?? 360, H = opts.h ?? 203;
  const ch = 158, cw = ch * CARD_RATIO;
  const cx = W / 2, cy = H / 2;
  const a = (opts.deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // inverse-rotate into card space (origin = card centre)
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      let val = opts.bg;
      if (Math.abs(u) <= cw / 2 && Math.abs(v) <= ch / 2) {
        const bw = cw * 0.05;
        const inner = Math.abs(u) <= cw / 2 - bw && Math.abs(v) <= ch / 2 - bw;
        val = inner ? opts.body : opts.border;
        // title bar: 10% down from the top, inset from the sides
        if (inner && v > -ch / 2 + ch * 0.08 && v < -ch / 2 + ch * 0.13 && Math.abs(u) < cw * 0.35) val = opts.title;
      }
      g[y * W + x] = val;
    }
  }
  const corner = (u: number, v: number): Pt => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  const truth = [corner(-cw / 2, -ch / 2), corner(cw / 2, -ch / 2), corner(cw / 2, ch / 2), corner(-cw / 2, ch / 2)];
  // guide drawn by the UI: upright, 78%-of-height card outline centred in view
  const gh = ch * 1.02, gw = gh * CARD_RATIO;
  return { g, W, H, truth, guide: { x: cx - gw / 2, y: cy - gh / 2, w: gw, h: gh } };
}

const maxCornerError = (a: Pt[], b: Pt[]) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y)));

describe('detectCard', () => {
  it('finds a bright card on a dark table', () => {
    const f = frame({ deg: 3, bg: 21, border: 230, body: 245, title: 20 });
    const d = detectCard(f.g, f.W, f.H, f.guide);
    expect(d).not.toBeNull();
    expect(maxCornerError(d!.corners, f.truth)).toBeLessThan(3);
  });

  it('uses the weak outer border, not a strong title edge, on a dark card', () => {
    const f = frame({ deg: -2, bg: 21, border: 60, body: 30, title: 245 });
    const d = detectCard(f.g, f.W, f.H, f.guide);
    expect(d).not.toBeNull();
    expect(maxCornerError(d!.corners, f.truth)).toBeLessThan(3);
  });

  it('ignores table texture around the card', () => {
    const f = frame({ deg: 2, bg: 40, border: 90, body: 35, title: 240 });
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < f.g.length; i++) f.g[i]! += rnd() * 10; // wood-grain-like noise everywhere
    const d = detectCard(f.g, f.W, f.H, f.guide);
    expect(d).not.toBeNull();
    expect(maxCornerError(d!.corners, f.truth)).toBeLessThan(3);
  });

  it('returns nothing on an empty table', () => {
    const f = frame({ deg: 0, bg: 21, border: 21, body: 21, title: 21 });
    expect(detectCard(f.g, f.W, f.H, f.guide)).toBeNull();
  });
});

describe('card signatures', () => {
  it('tell the same card from a different one', () => {
    const a = frame({ deg: 3, bg: 21, border: 230, body: 245, title: 20 });
    const a2 = frame({ deg: 3.5, bg: 24, border: 228, body: 243, title: 22 }); // same card, slight shift/exposure
    const b = frame({ deg: -2, bg: 21, border: 60, body: 30, title: 245 });
    const sa = regionSignature(a.g, a.W, a.guide);
    expect(signatureDiff(sa, regionSignature(a2.g, a2.W, a2.guide))).toBeLessThan(12);
    expect(signatureDiff(sa, regionSignature(b.g, b.W, b.guide))).toBeGreaterThanOrEqual(12);
  });
});
