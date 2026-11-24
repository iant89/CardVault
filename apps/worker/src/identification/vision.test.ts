import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLASS_TO_GAME,
  classifyModelCard,
  decodeClassifier,
  decodeCtc,
  discoverExports,
  gameForClass,
  lineSpecFrom,
  loadVisionArtifact,
  softmax,
} from './vision.js';

/** One time step of a `T`-step logits tensor, with `winner` given the top score. */
const step = (classes: number, winner: number, top = 8): number[] => {
  const row = new Array(classes).fill(0);
  row[winner] = top;
  return row;
};

/** Three labels → five classes: 0 pad, 1 blank, then the labels. */
const read = (rows: number[][], labels: string[], extra: Partial<Parameters<typeof decodeCtc>[3]> = {}) =>
  decodeCtc(new Float32Array(rows.flat()), rows.length, labels.length + 2, { labels, indexOffset: 2, blankIndex: 1, padIndex: 0, ...extra });

describe('CTC decoding of CardVault-Vision logits', () => {
  const labels = ['A', 'B', 'C'];
  // classes: 0 = pad, 1 = blank, 2 = A, 3 = B, 4 = C
  it('collapses repeats, drops blanks, and maps index i-2', () => {
    const rows = [step(5, 2), step(5, 2), step(5, 1), step(5, 3), step(5, 1), step(5, 2)];
    const r = read(rows, labels);
    expect(r.text).toBe('ABA');
    expect(r.confidence).toBeGreaterThan(0.99);
  });

  it('does not repeat a character across a blank (two A glyphs)', () => {
    const rows = [step(5, 2), step(5, 1), step(5, 2)];
    expect(read(rows, labels).text).toBe('AA');
  });

  it('treats pad (0) as a separator, like blank', () => {
    const rows = [step(5, 2), step(5, 0), step(5, 2)];
    expect(read(rows, labels).text).toBe('AA');
  });

  it('skips a disallowed class when choosing the winner (number spots)', () => {
    // the model wants "B" but only digits are allowed on this spot
    const rows = [step(5, 3), step(5, 2)];
    const r = read(rows, labels, { allowed: new Set(['A', 'C']) });
    expect(r.text).toBe('A');
  });

  it('reads a confident empty line as confident, and a confused one as not', () => {
    const sure = read([step(5, 1), step(5, 1)], labels);
    expect(sure.text).toBe('');
    expect(sure.confidence).toBeGreaterThan(0.99);
    // an even three-way split on every step: nothing is certain
    const flat = [0, 0, 0, 0, 0];
    const unsure = read([flat, flat], labels);
    expect(unsure.confidence).toBeLessThan(0.5);
  });

  it('emits only characters the spot can contain', () => {
    // a number spot: digits and a slash, nothing else
    const r = read([step(5, 2), step(5, 4)], ['0', '/', 'Z'], { allowed: new Set('0123456789/') });
    expect(r.text).toBe('0');
  });
});

describe('softmax', () => {
  it('is a distribution, even for large logits', () => {
    const p = softmax(new Float32Array([1000, 1001, 1002]), 0, 3);
    expect(Math.abs(p[0]! + p[1]! + p[2]! - 1)).toBeLessThan(1e-6);
    expect(p[2]).toBeGreaterThan(p[1]!);
  });
});

describe('card classifier decoding', () => {
  const labels = ['POKEMON', 'MAGIC_THE_GATHERING', 'YU_GI_OH', 'SPORTS', 'OTHER', 'UNKNOWN'];
  it('picks the argmax and reports its probability', () => {
    const logits = new Float32Array([1, 0, 0, 6, 0, 0]);
    const g = decodeClassifier(logits, labels);
    expect(g.label).toBe('SPORTS');
    expect(g.confidence).toBeGreaterThan(0.9);
    expect(g.scores[0]!.label).toBe('SPORTS');
  });
  it('routes every exported class it knows to a CardVault game', () => {
    expect(gameForClass('POKEMON')).toBe('pokemon');
    expect(gameForClass('MAGIC_THE_GATHERING')).toBe('magic');
    expect(gameForClass('YU_GI_OH')).toBe('yugioh');
    expect(gameForClass('HOCKEY')).toBe('hockey');
    // one physical sports layout: any of the four is a usable route
    expect(gameForClass('SPORTS')).toBeTruthy();
    expect(gameForClass('OTHER')).toBeNull();
    expect(gameForClass('UNKNOWN')).toBeNull();
    expect(Object.keys(CLASS_TO_GAME)).not.toContain('SPORTS');
  });
});

describe('preprocessing contract', () => {
  it('reads CardVault-Vision OCR exports as [0, 1] with a 1600px width limit', () => {
    const spec = lineSpecFrom({ input_height: 32, width: 'dynamic', value_range: [0, 1] });
    expect(spec).toMatchObject({ height: 32, range: 'unit', maxWidth: 1600 });
    expect(spec.maxWidth).toBeGreaterThan(32);
  });
  it('recognises a legacy [-1, 1] range', () => {
    expect(lineSpecFrom({ input_height: 32, value_range: [-1, 1] }).range).toBe('signed');
  });
  it('keeps a fixed width from a non-dynamic export', () => {
    expect(lineSpecFrom({ input_height: 32, width: 320, value_range: [0, 1] }).maxWidth).toBe(320);
  });
  it('falls back to the export defaults when the file is absent', () => {
    expect(lineSpecFrom({})).toMatchObject({ height: 32, range: 'unit', maxWidth: 1600 });
  });
});

describe('models from another CardVault install', () => {
  it('trusts the artifact JSON over a guessed kind', () => {
    const card = classifyModelCard({ task: 'name-ocr', version: '1.0.0', heads: { name: 'exports/name-ocr/1.0.0' } });
    expect(card.kind).toBe('vision');
    expect(classifyModelCard({ kind: 'vision', task: 'card-classifier' }).kind).toBe('classifier');
    expect(classifyModelCard({ charset: 'abc' }).kind).toBe('trainer');
  });
});

// ------------------------------------------------------------------ artifacts on disk

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Write an artifact directory shaped exactly like `vision export` writes one. */
function writeArtifact(root: string, task: string, version: string, opts: { tamper?: boolean; labels?: string[]; checksumFile?: boolean; validation?: string } = {}) {
  const dir = path.join(root, task, version);
  mkdirSync(dir, { recursive: true });
  const model = Buffer.from(`onnx:${task}:${version}`);
  writeFileSync(path.join(dir, 'model.onnx'), model);
  const checksum = sha(model);
  const labels = opts.labels ?? (task === 'card-classifier' ? ['POKEMON', 'OTHER', 'UNKNOWN'] : ['A', 'B']);
  writeFileSync(
    path.join(dir, 'metadata.json'),
    JSON.stringify({
      schema_version: '1.0',
      task,
      version,
      architecture: task === 'card-classifier' ? 'card-type-cnn' : 'crnn',
      format: 'onnx',
      input_spec: { name: 'images', shape: ['batch', 1, 32, 'width'], dtype: 'float32' },
      output_spec: { name: 'logits', shape: ['time', 'batch', labels.length + 2], dtype: 'float32' },
      num_classes: task === 'card-classifier' ? labels.length : labels.length + 2,
      checksum_sha256: opts.tamper ? sha('something else') : checksum,
      dataset: { version: '20261124-1200', content_hash: null },
      metrics: { cer: 0.08 },
    }),
  );
  writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({ task, count: labels.length, labels, index_offset: task === 'card-classifier' ? 0 : 2 }));
  writeFileSync(path.join(dir, 'preprocessing.json'), JSON.stringify({ type: task === 'card-classifier' ? 'whole-card-classification' : 'ocr-line', input_height: 32, width: 'dynamic', input_size: 160, value_range: [0, 1] }));
  writeFileSync(path.join(dir, 'contract.json'), JSON.stringify({ decoding: { type: 'ctc_greedy', blank_index: 1, pad_index: 0 } }));
  if (opts.checksumFile !== false) writeFileSync(path.join(dir, 'checksum.sha256'), `${checksum}  model.onnx\n`);
  if (opts.validation) writeFileSync(path.join(dir, 'validation.json'), JSON.stringify({ status: opts.validation, problems: opts.validation === 'REJECTED' ? ['numerical check failed'] : [] }));
  return dir;
}

describe('exported artifacts', () => {
  const root = () => mkdtempSync(path.join(tmpdir(), 'cvv-'));

  it('verifies the checksum, contract and labels of an export', async () => {
    const r = root();
    writeArtifact(r, 'name-ocr', '1.0.0');
    const a = await loadVisionArtifact(path.join(r, 'name-ocr', '1.0.0'), 'name-ocr/1.0.0');
    expect(a.task).toBe('name-ocr');
    expect(a.labels).toEqual(['A', 'B']);
    expect(a.indexOffset).toBe(2);
    expect(a.blankIndex).toBe(1);
    expect(a.inputName).toBe('images');
    expect(a.outputName).toBe('logits');
    expect(a.sha256).toBe(sha(Buffer.from('onnx:name-ocr:1.0.0')));
    expect(a.lineSpec?.range).toBe('unit');
  });

  it('refuses an artifact whose bytes do not match its checksum', async () => {
    const r = root();
    writeArtifact(r, 'name-ocr', '1.0.0', { tamper: true });
    await expect(loadVisionArtifact(path.join(r, 'name-ocr', '1.0.0'), 'x')).rejects.toThrow(/checksum mismatch/);
  });

  it('refuses an artifact whose own validation rejected it', async () => {
    const r = root();
    writeArtifact(r, 'number-ocr', '1.0.0', { validation: 'REJECTED' });
    await expect(loadVisionArtifact(path.join(r, 'number-ocr', '1.0.0'), 'x')).rejects.toThrow(/rejected this export/);
  });

  it('refuses an OCR export that declares the classifier index offset', async () => {
    const r = root();
    const dir = writeArtifact(r, 'name-ocr', '1.0.0');
    writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({ labels: ['A'], index_offset: 0 }));
    await expect(loadVisionArtifact(dir, 'x')).rejects.toThrow(/index_offset/);
  });

  it('finds the registry layout, skips production.json, and reports broken exports', async () => {
    const r = root();
    writeArtifact(r, 'name-ocr', '1.0.0');
    writeArtifact(r, 'number-ocr', '1.0.0');
    writeArtifact(r, 'card-classifier', '1.0.0', { labels: ['POKEMON', 'OTHER'] });
    writeArtifact(r, 'name-ocr', '2.0.0', { tamper: true });
    writeFileSync(path.join(r, 'name-ocr', 'production.json'), '{}');
    writeFileSync(path.join(r, 'registry.json'), JSON.stringify({ models: [] }));
    const { artifacts, errors } = await discoverExports(r);
    expect(artifacts.map((a) => `${a.task}@${a.metadata.version}`)).toEqual(['card-classifier@1.0.0', 'name-ocr@1.0.0', 'number-ocr@1.0.0']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatch(/checksum mismatch/);
  });

  it('finds flattened exports and a copied exports/ folder', async () => {
    const r = root();
    const nested = path.join(r, 'exports');
    writeArtifact(nested, 'name-ocr', '1.0.0');
    mkdirSync(path.join(r, 'name-ocr-1.0.0'), { recursive: true });
    const flat = writeArtifact(r, 'name-ocr', '3.0.0');
    const { artifacts } = await discoverExports(r);
    expect(artifacts.map((a) => a.metadata.version).sort()).toEqual(['1.0.0', '3.0.0']);
    expect(flat).toContain('3.0.0');
  });
});
