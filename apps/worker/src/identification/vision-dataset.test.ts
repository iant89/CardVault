import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contentHash, normalizeCardType, roiToPixels, sampleFor, readVisionManifest, splitForValidation, writeVisionDataset, VISION_MANIFEST } from './vision-dataset.js';
import type { VisionGroup } from './vision-dataset.js';
import type { WorkerContext } from '../context.js';

/**
 * A real PNG, built by hand: the test needs an image the pipeline will actually
 * decode, and pulling in an encoder just for that would test sharp, not us.
 */
function png(width: number, height: number, rgb: [number, number, number] = [120, 120, 120]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // every scanline starts with its filter type (0 = none), then the pixels
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) rows.set(rgb, at + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const group = (over: Partial<VisionGroup> = {}): VisionGroup => ({
  groupKey: 'scan:abc:v0',
  game: 'pokemon',
  cardId: 'card-1',
  imagePath: 'scans/abc.jpg',
  harvest: false,
  nameRegion: 0,
  numberRegion: 0,
  nameText: 'Pikachu',
  numberText: '25/198',
  meta: { era: '2011–2016' },
  ...over,
});

const image = { width: 750, height: 1047, sha256: 'a'.repeat(64), relativePath: 'images/x.jpg' };

describe('CardVault-Vision dataset samples', () => {
  it('writes field boxes in pixels of the full image plus the normalised roi', () => {
    const s = sampleFor(group(), image, { split: 'train' });
    // the Pokemon title spot: left 0.15, top 0.035, 0.60 × 0.07
    expect(s.annotation.fields.name!.bbox).toEqual({ x0: 113, y0: 37, x1: 563, y1: 110 });
    expect(s.annotation.fields.name!.roi).toMatchObject({ x0: 0.15, y0: 0.035 });
    expect(s.annotation.fields.number!.text).toBe('25/198');
    expect(s.annotation.card_type).toBe('POKEMON');
    expect(s.card_id).toBe('card-1');
    expect(s.split).toBe('train');
  });

  it('omits a field whose text is unknown rather than annotating it empty', () => {
    const s = sampleFor(group({ nameText: null }), image, { split: 'train' });
    expect(s.annotation.fields.name).toBeUndefined();
    expect(Object.keys(s.annotation.fields)).toEqual(['number']);
  });

  it('omits a field whose spot is unknown', () => {
    const s = sampleFor(group({ numberRegion: 9 }), image, { split: 'train' });
    expect(s.annotation.fields.number).toBeUndefined();
  });

  it('marks harvested captures as generated, so they stay a separate slice', () => {
    const s = sampleFor(group({ harvest: true }), image, { split: 'train' });
    expect(s.annotation.generation).toMatchObject({ source: 'harvest' });
    expect(s.tags).toContain('harvest');
    expect(s.annotation.extra).toBeDefined();
  });

  it('carries the era as a tag for slicing', () => {
    expect(sampleFor(group(), image, { split: 'train' }).tags).toContain('era:2011–2016');
  });

  it('labels sports cards with the shared sports layout', () => {
    const s = sampleFor(group({ game: 'baseball', nameText: 'Ken Griffey Jr.', numberText: '#24' }), image, { split: 'train' });
    expect(s.annotation.card_type).toBe('BASEBALL');
    expect(s.annotation.fields.name!.text).toBe('Ken Griffey Jr.');
    expect(s.annotation.fields.number!.bbox.x0).toBe(Math.round(0.72 * 750));
  });

  it('knows every CardVault game as a CardVault-Vision card type', () => {
    expect(['pokemon', 'magic', 'yugioh', 'baseball', 'football', 'basketball', 'hockey'].map(normalizeCardType)).toEqual([
      'POKEMON',
      'MAGIC_THE_GATHERING',
      'YU_GI_OH',
      'BASEBALL',
      'FOOTBALL',
      'BASKETBALL',
      'HOCKEY',
    ]);
    // 'other' abstains rather than claiming to be a type it is not
    expect(normalizeCardType('other')).toBe('UNKNOWN');
  });
});

describe('roiToPixels', () => {
  it('rounds a fractional region onto the image', () => {
    expect(roiToPixels({ left: 0.5, top: 0.5, width: 0.25, height: 0.1 }, 800, 1000)).toEqual({ x0: 400, y0: 500, x1: 600, y1: 600 });
  });
});

describe('content hash', () => {
  it('does not depend on sample order (two shards hash the same)', () => {
    const a = [{ image_id: 'b', sha256: '2' }, { image_id: 'a', sha256: '1' }];
    const b = [{ image_id: 'a', sha256: '1' }, { image_id: 'b', sha256: '2' }];
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toHaveLength(64);
    expect(contentHash(a)).not.toBe(contentHash([{ image_id: 'a', sha256: '9' }]));
  });
});

describe('reading a written manifest back', () => {
  it('round-trips a manifest the trainer can read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cvv-ds-'));
    mkdirSync(path.join(dir, 'vision'), { recursive: true });
    const manifest = {
      schema_version: '1.0',
      name: 'cardvault-x',
      kind: 'real',
      root: '.',
      version: { version: '1.0.0', created_at: '2026-11-24T00:00:00Z', content_hash: contentHash([{ image_id: 'a', sha256: '1' }]) },
      counts: { samples: 1, cards: 1 },
      provenance: { source: 'cardvault' },
      metadata: {},
      samples: [sampleFor(group(), image, { split: 'train' })],
    };
    writeFileSync(path.join(dir, 'vision', VISION_MANIFEST), JSON.stringify(manifest));
    const read = await readVisionManifest(path.join(dir, 'vision'));
    expect(read?.samples).toHaveLength(1);
    expect(read?.samples[0]!.annotation.fields.name!.text).toBe('Pikachu');
    // a missing manifest is null, not a throw: OCR Lab lists every dataset
    expect(await readVisionManifest(path.join(dir, 'nope'))).toBeNull();
  });
});

describe('writing the dataset the trainer reads', () => {
  it('records an absolute root, because a relative one is resolved against the trainer\'s own working directory', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'cvv-store-'));
    mkdirSync(path.join(storageDir, 'scans'), { recursive: true });
    // `group()`'s default imagePath; the bytes are re-encoded as JPEG by the writer
    writeFileSync(path.join(storageDir, 'scans', 'abc.jpg'), png(75, 105));
    const ctx = { storageDir, log: { info() {}, warn() {}, debug() {} } } as unknown as WorkerContext;

    const out = await writeVisionDataset(ctx, '20261124-1000', [group()], { createdAt: '2026-11-24T00:00:00Z', split: 'train' });
    expect(out).not.toBeNull();
    const dir = path.join(storageDir, 'ocr', 'datasets', '20261124-1000', 'vision');
    const manifest = JSON.parse(readFileSync(path.join(dir, VISION_MANIFEST), 'utf8')) as { root: string; samples: { image_path: string }[] };

    expect(path.isAbsolute(manifest.root)).toBe(true);
    expect(path.resolve(manifest.root)).toBe(dir);
    // every sample's image really is there, resolved the way the trainer does it
    for (const sample of manifest.samples) expect(existsSync(path.join(manifest.root, sample.image_path))).toBe(true);
  });

  it('writes nothing rather than an empty manifest the trainer would fail on', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'cvv-store-'));
    const ctx = { storageDir, log: { info() {}, warn() {}, debug() {} } } as unknown as WorkerContext;
    // the scan it points at does not exist
    expect(await writeVisionDataset(ctx, 'empty', [group()], { createdAt: '2026-11-24T00:00:00Z', split: 'train' })).toBeNull();
  });
});

describe('the factory\'s own validation split', () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ card_id: `card-${i}` }));

  it('counts cards, so a card with many scans is one hold-out decision', () => {
    const many = [...cards(10), { card_id: 'card-0' }, { card_id: 'card-0' }, { card_id: 'card-0' }];
    const val = splitForValidation(many, 0.2);
    expect(val.size).toBe(2); // 10 unique cards, 20% → 2, not 13 samples
    expect(splitForValidation([...cards(10), { card_id: 'card-0' }], 0.2)).toEqual(val);
  });

  it('splits the same way every time, so a card cannot drift between runs', () => {
    expect([...splitForValidation(cards(50), 0.2)].sort()).toEqual([...splitForValidation(cards(50), 0.2)].sort());
    expect([...splitForValidation(cards(50), 0.2)].sort()).toEqual([...splitForValidation([...cards(50)].reverse(), 0.2)].sort());
  });

  it('always leaves something to train on', () => {
    expect(splitForValidation(cards(1), 0.2).size).toBe(0);
    expect(splitForValidation(cards(2), 0.5).size).toBe(1);
    expect(splitForValidation(cards(0), 0.2).size).toBe(0);
  });
});
