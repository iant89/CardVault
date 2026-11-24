import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findVisionDir, parseTrainJson, parseVisionLine, safeVersion, tasksFor, versionStamp } from './ocr-vision.js';

describe('which heads a run trains', () => {
  it('trains both OCR heads by default: that is what a scan uses', () => {
    expect(tasksFor('ocr-pair')).toEqual(['name-ocr', 'number-ocr']);
  });
  it('trains one head or all three on request', () => {
    expect(tasksFor('name-ocr')).toEqual(['name-ocr']);
    expect(tasksFor('number-ocr')).toEqual(['number-ocr']);
    expect(tasksFor('card-classifier')).toEqual(['card-classifier']);
    expect(tasksFor('all')).toEqual(['name-ocr', 'number-ocr', 'card-classifier']);
  });
});

describe('reading the vision trainer’s output', () => {
  it('reads an OCR epoch line', () => {
    expect(parseVisionLine('12:03:04 | INFO    | cardvault_vision.training.trainer | epoch 3/20  loss=0.4123  cer=0.0812 em=42.00%')).toEqual({
      kind: 'epoch',
      epoch: 3,
      epochs: 20,
      loss: 0.4123,
      cer: 0.0812,
    });
  });

  it('reads a classifier epoch line (acc and macro F1, no CER)', () => {
    expect(parseVisionLine('12:03:04 | INFO    | cardvault_vision.training.trainer | epoch 2/10  loss=0.2211  val_loss=0.2010  acc=88.00%  macroF1=0.8710')).toEqual({
      kind: 'epoch',
      epoch: 2,
      epochs: 10,
      loss: 0.2211,
      macroF1: 0.871,
    });
  });

  it('strips ANSI colour codes before reading a line', () => {
    expect(parseVisionLine('\u001b[38;5;39m12:03:04 | INFO | epoch 1/5  loss=1.0000  cer=0.5000\u001b[0m')).toMatchObject({ kind: 'epoch', epoch: 1, epochs: 5, cer: 0.5 });
  });

  it('reads what the exporter wrote', () => {
    expect(parseVisionLine('12:09:55 | INFO    | cardvault_vision.export | Exported name-ocr 1.0.0 -> /data/storage/ocr/vision/exports/name-ocr/1.0.0')).toEqual({
      kind: 'exported',
      task: 'name-ocr',
      exportDir: '/data/storage/ocr/vision/exports/name-ocr/1.0.0',
    });
  });

  it('notices a collapsed model (CER looks fine, the readings are not)', () => {
    expect(parseVisionLine('Collapsed predictions at epoch 4: 1/21 distinct, mean length 0% of reference. CER 0.9000 is not a reading score')).toEqual({ kind: 'collapsed' });
  });

  it('says nothing about an ordinary log line', () => {
    expect(parseVisionLine('Using field \'name\' for name-ocr (120/140 samples)')).toBeNull();
  });
});

describe('reading the trainer’s JSON result', () => {
  it('finds the result object even after hundreds of log lines', () => {
    const lines = ['noise', '{"epochs": 3}', JSON.stringify({ task: 'name-ocr', best_checkpoint: '/x/best.pt', best_metric: 0.081, metric_name: 'cer', architecture: 'crnn' })];
    expect(parseTrainJson(lines)).toMatchObject({ best_checkpoint: '/x/best.pt', best_metric: 0.081, metric_name: 'cer' });
  });
  it('is null when nothing was printed (a crashed run)', () => {
    expect(parseTrainJson(['Traceback...', '{"not": "a result"}'])).toBeNull();
  });
});

describe('versions', () => {
  it('stamps a version that is a safe directory name', () => {
    expect(versionStamp(new Date('2026-11-24T15:30:00Z'))).toBe('2026.11.24-1530');
    expect(safeVersion('1.0.0')).toBe('1.0.0');
    expect(safeVersion('../production')).toBe(versionStamp());
    expect(safeVersion(undefined)).toBe(versionStamp());
  });
});

describe('finding the vision checkout', () => {
  const checkout = (dir: string) => {
    mkdirSync(path.join(dir, 'src', 'cardvault_vision', 'cli'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'cardvault_vision', 'cli', 'main.py'), '');
    return dir;
  };

  it('finds a checkout in vendor/ or beside the repository', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'repo-'));
    mkdirSync(path.join(repo, 'apps', 'worker'), { recursive: true });
    const vendored = checkout(path.join(repo, 'vendor', 'CardVault-Vision'));
    expect(findVisionDir(undefined, [path.join(repo, 'apps', 'worker')])).toBe(vendored);
  });

  it('honours an explicit directory, and refuses one that is not a checkout', () => {
    const dir = checkout(mkdtempSync(path.join(tmpdir(), 'cvv-')));
    expect(findVisionDir(dir)).toBe(dir);
    expect(findVisionDir(mkdtempSync(path.join(tmpdir(), 'empty-')))).toBeNull();
  });

  it('accepts a directory that is not a checkout as absent, and only reports real ones', () => {
    const lonely = mkdtempSync(path.join(tmpdir(), 'lonely-'));
    expect(findVisionDir(path.join(lonely, 'no-such-dir'))).toBeNull();
    // walking up can legitimately find a checkout beside the repository (a
    // developer who cloned both): whatever is returned must be a real one
    const found = findVisionDir(undefined, [lonely]);
    if (found) expect(existsSync(path.join(found, 'src', 'cardvault_vision', 'cli', 'main.py'))).toBe(true);
  });
});
