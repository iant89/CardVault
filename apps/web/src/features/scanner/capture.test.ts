import { beforeAll, describe, expect, it } from 'vitest';
import { CARD_RATIO, correctPhoto, planCapture, rectQuad, sharpen, warpCard, type Pt, type Quad } from './vision';

beforeAll(() => {
  // node has no ImageData; a minimal stand-in is all the vision code uses
  if (!(globalThis as { ImageData?: unknown }).ImageData) {
    (globalThis as Record<string, unknown>).ImageData = class {
      data: Uint8ClampedArray;
      constructor(public width: number, public height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
});

const W = 960, H = 540;
const CH = 420, CW = CH * CARD_RATIO;

/** A camera frame: a patterned card, rotated `deg`, offset by (ox, oy), on a darker table. */
function scene(deg: number, ox = 0, oy = 0) {
  const img = new ImageData(W, H);
  const cx = W / 2 + ox, cy = H / 2 + oy;
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      let val = 55 + ((x * 7 + y * 13) % 9); // table with slight texture
      if (Math.abs(u) <= CW / 2 && Math.abs(v) <= CH / 2) {
        const inner = Math.abs(u) <= CW / 2 - 14 && Math.abs(v) <= CH / 2 - 14;
        // artwork: a pattern that makes a misaligned crop easy to tell apart
        val = inner ? 120 + 60 * Math.sin(u / 9) * Math.cos(v / 13) : 225;
      }
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = val;
      img.data[o + 3] = 255;
    }
  }
  const corner = (u: number, v: number): Pt => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  const truth: Quad = [corner(-CW / 2, -CH / 2), corner(CW / 2, -CH / 2), corner(CW / 2, CH / 2), corner(-CW / 2, CH / 2)];
  const gh = CH * 1.04, gw = gh * CARD_RATIO;
  const guide = { x: W / 2 - gw / 2, y: H / 2 - gh / 2, w: gw, h: gh };
  return { img, truth, guide };
}

/** Mean absolute grey difference between two same-size crops (0 = identical). */
function diff(a: ImageData, b: ImageData) {
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i]! - b.data[i]!);
  return s / (a.data.length / 4);
}

describe('planCapture', () => {
  it('saves without asking when the live outline is on the card', () => {
    const { img, truth, guide } = scene(3);
    const p = planCapture(img, truth, guide);
    expect(p.needsReview).toBe(false);
    expect(p.adjusted).toBeNull();
  });

  it('a skewed, wrong live outline is caught and a corrected crop is offered', () => {
    const { img, truth, guide } = scene(2, 10, -6);
    const ideal = warpCard(img, truth, 750);
    // like the screenshot: outline slanted and pulled past the card on one side
    const bad: Quad = [
      { x: truth[0].x + 30, y: truth[0].y + 40 },
      { x: truth[1].x + 60, y: truth[1].y - 10 },
      { x: truth[2].x + 20, y: truth[2].y + 30 },
      { x: truth[3].x + 35, y: truth[3].y - 25 },
    ];
    const p = planCapture(img, bad, guide);
    expect(p.needsReview).toBe(true);
    expect(p.adjusted).not.toBeNull();
    const before = diff(p.original, ideal), after = diff(p.adjusted!, ideal);
    expect(after).toBeLessThan(before / 3);
    expect(after).toBeLessThan(6);
  });

  it('with no live outline, the card is found around the guide', () => {
    const { img, truth, guide } = scene(5, -12, 8);
    const ideal = warpCard(img, truth, 750);
    const p = planCapture(img, null, guide);
    expect(p.needsReview).toBe(true);
    expect(diff(p.adjusted!, ideal)).toBeLessThan(6);
  });

  it('no live outline but the card sits exactly in the guide: saved directly', () => {
    const { img, guide } = scene(0);
    const fit = scene(0).truth;
    const g = { x: fit[0].x, y: fit[0].y, w: fit[1].x - fit[0].x, h: fit[3].y - fit[0].y };
    const p = planCapture(img, null, g);
    expect(p.needsReview).toBe(false);
    void guide;
  });

  it('nothing to find: asks keep/retake with no corrected crop', () => {
    const img = new ImageData(W, H);
    img.data.fill(90);
    const { guide } = scene(0);
    const p = planCapture(img, rectQuad(guide), guide);
    expect(p.needsReview).toBe(true);
    expect(p.adjusted).toBeNull();
  });
});

describe('correctPhoto (uploaded photos)', () => {
  it('straightens the card found in the photo', () => {
    const { img, guide } = scene(5, -12, 8);
    const corrected = correctPhoto(img, guide);
    expect(corrected).not.toBeNull();
    expect(corrected!.width).toBe(750);
    expect(corrected!.height).toBe(Math.round(750 / CARD_RATIO));
  });

  it('keeps the photo when no card can be found', () => {
    const img = new ImageData(W, H);
    img.data.fill(90);
    const { guide } = scene(0);
    expect(correctPhoto(img, guide)).toBeNull();
  });
});

describe('sharpen', () => {
  it('increases edge contrast', () => {
    const img = new ImageData(5, 5);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const v = x < 2 ? 40 : 200;
        const o = (y * 5 + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    sharpen(img, 0.5);
    const at = (x: number, y: number) => img.data[(y * 5 + x) * 4]!;
    // the dark pixel beside the edge gets darker, the bright one brighter
    expect(at(1, 2)).toBeLessThan(40);
    expect(at(2, 2)).toBeGreaterThan(200);
    // far from the edge nothing changes
    expect(at(0, 2)).toBe(40);
    expect(at(4, 2)).toBe(200);
  });
});

describe('capture size', () => {
  it('keeps the camera detail up to the maximum width', () => {
    const { img, truth, guide } = scene(0);
    // card is ~300px wide in this frame: never stored smaller than the minimum
    expect(planCapture(img, truth, guide, 750, 360, 1500).original.width).toBe(750);
    // a card seen larger keeps its size, capped at the maximum
    const big: Quad = truth.map((p) => ({ x: p.x * 4, y: p.y * 4 })) as Quad;
    const frame4 = new ImageData(W * 4, H * 4);
    expect(planCapture(frame4, big, { ...guide, x: guide.x * 4, y: guide.y * 4, w: guide.w * 4, h: guide.h * 4 }, 750, 360, 1500).original.width).toBe(1203);
  });
});
