import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { dhash, hammingDistance, hashSimilarity, normalizeUpload, ImageValidationError } from './index.js';

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
