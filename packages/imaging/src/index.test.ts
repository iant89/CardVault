import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  CLASSIFIER_SIZE,
  lineTensor,
  classifierTensor,
  TRAINER_LINE_SPEC,
  VISION_LINE_SPEC,
  dhash,
  hammingDistance,
  hashSimilarity,
  normalizeUpload,
  ImageValidationError,
} from './index.js';

const img = (color: string, shape: string) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560"><rect width="400" height="560" fill="${color}"/>${shape}</svg>`)).png().toBuffer();

describe('imaging', () => {
  it('hashes similar images close and different images far', async () => {
    const a = await img('#fff', '<circle cx="200" cy="200" r="120" fill="#c00"/>');
    const a2 = await sharp(a).modulate({ brightness: 1.05 }).jpeg({ quality: 70 }).toBuffer();
    const b = await img('#fff', '<rect x="40" y="300" width="320" height="200" fill="#00c"/>');
    const [ha, ha2, hb] = await Promise.all([dhash(a), dhash(a2), dhash(b)]);
    expect(ha).toHaveLength(64);
    expect(hammingDistance(ha, ha2)).toBeLessThan(16);
    expect(hammingDistance(ha, hb)).toBeGreaterThan(40);
    expect(hashSimilarity(ha, ha)).toBe(1);
  });
  it('rejects non-images', async () => {
    await expect(normalizeUpload(Buffer.from('<?php echo 1; ?>'))).rejects.toBeInstanceOf(ImageValidationError);
  });
});

/** A white line on a black band: [0, 1] pixels that differ per channel order. */
const line = (width: number) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><rect width="${width}" height="60" fill="#000"/><text x="10" y="45" font-size="40" fill="#fff">ABC</text></svg>`))
    .png()
    .toBuffer();

describe('line reader tensors', () => {
  it('matches tools/ocr-trainer: 32 px tall, [-1, 1], width from the aspect ratio', async () => {
    const t = await lineTensor(await line(200));
    expect(t.height).toBe(32);
    expect(t.width).toBe(Math.round((200 * 32) / 60));
    expect(Math.min(...t.data)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...t.data)).toBeLessThanOrEqual(1);
    expect(TRAINER_LINE_SPEC.range).toBe('signed');
  });

  it('matches CardVault-Vision: 32 px tall, [0, 1], 32..1600 wide', async () => {
    const t = await lineTensor(await line(200), VISION_LINE_SPEC);
    expect(t.height).toBe(32);
    expect(t.width).toBe(Math.round((200 * 32) / 60));
    expect(Math.min(...t.data)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...t.data)).toBeLessThanOrEqual(1);
    // a black-and-white line has both extremes, so the range is exercised
    expect(Math.min(...t.data)).toBeLessThan(0.2);
    expect(Math.max(...t.data)).toBeGreaterThan(0.8);
  });

  it('clamps a very long line to the vision head’s 1600 px limit', async () => {
    const t = await lineTensor(await line(4000), VISION_LINE_SPEC);
    expect(t.width).toBe(1600);
  });

  it('clamps a very short line up to the vision head’s 32 px minimum', async () => {
    const t = await lineTensor(await line(20), VISION_LINE_SPEC);
    expect(t.width).toBe(32);
  });

  it('can invert a light-on-dark line', async () => {
    const normal = await lineTensor(await line(200), VISION_LINE_SPEC);
    const inverted = await lineTensor(await line(200), { ...VISION_LINE_SPEC, invert: true });
    expect(inverted.data[0]).toBeCloseTo(1 - normal.data[0]!, 5);
  });
});

describe('classifier tensor', () => {
  it('is RGB CHW at 160×160, in [0, 1], squashing the aspect ratio', async () => {
    const card = await img('#fff', '<rect x="0" y="0" width="400" height="200" fill="#f00"/>');
    const t = await classifierTensor(card);
    const plane = CLASSIFIER_SIZE * CLASSIFIER_SIZE;
    expect(t.size).toBe(160);
    expect(t.data).toHaveLength(plane * 3);
    // red fills the top half of the card: R high, G/B near zero, channels planar
    expect(t.data[0]!).toBeGreaterThan(0.9);
    expect(t.data[plane]!).toBeLessThan(0.1);
    expect(t.data[plane * 2]!).toBeLessThan(0.1);
    expect(Math.max(...t.data)).toBeLessThanOrEqual(1);
  });
});
