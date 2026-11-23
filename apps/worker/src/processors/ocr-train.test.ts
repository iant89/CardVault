import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSetupScript, findTrainPython, parseTrainerLine, scoreOf, setupStep, shortenLine, stepAt, trainVenvDir } from './ocr-train.js';

describe('trainer output', () => {
  it('reads the resolved dataset', () => {
    expect(parseTrainerLine("dataset 20261122-120000: 501 lines {'review · name': 212}")).toEqual({
      type: 'dataset',
      id: '20261122-120000',
      lines: 501,
    });
  });

  it('reads epoch progress, with and without held-out slices', () => {
    expect(parseTrainerLine('epoch   1  loss 31.4853  dev name 0.5  number 1.0  (0.3 min)')).toEqual({
      type: 'epoch',
      epoch: 1,
      loss: 31.4853,
      devName: 0.5,
      devNumber: 1.0,
      minutes: 0.3,
    });
    expect(parseTrainerLine('epoch  12  loss 0.5123  dev name 0.875  number None  (2.3 min)')).toEqual({
      type: 'epoch',
      epoch: 12,
      loss: 0.5123,
      devName: 0.875,
      devNumber: null,
      minutes: 2.3,
    });
  });

  it('reads the finished model id and the final dev report', () => {
    expect(parseTrainerLine('wrote /data/storage/ocr/models/crnn-20261122-190626')).toEqual({
      type: 'wrote',
      modelId: 'crnn-20261122-190626',
    });
    const dev = { name: { n: 10, accuracy: 0.9, cer: 0.1 }, number: { n: 8, accuracy: null, cer: null } };
    expect(parseTrainerLine(`  dev: ${JSON.stringify(dev)}`)).toEqual({ type: 'dev', dev });
  });

  it('reads the run plan (this is what makes a time-until-finished possible)', () => {
    expect(parseTrainerLine('plan epochs 30 steps 12 × 30 train 480 dev 21 batch 48')).toEqual({
      type: 'plan',
      epochs: 30,
      stepsPerEpoch: 12,
      epochsSteps: 360,
      train: 480,
      dev: 21,
      batch: 48,
    });
  });

  it('reads each step inside an epoch', () => {
    expect(parseTrainerLine('step 7/12 loss 2.4180 (1.4 min)')).toEqual({ type: 'batch', epoch: 0, step: 7, steps: 12, loss: 2.418 });
  });

  it('reads the held-out lines it re-checked, with the verdict and confidence', () => {
    expect(parseTrainerLine('sample 3 name conf 0.981 ok ocr/scans/a/b.png Pikachu → Pikachu')).toEqual({
      type: 'sample',
      id: 3,
      field: 'name',
      confidence: 0.981,
      correct: true,
      crop: 'ocr/scans/a/b.png',
      truth: 'Pikachu',
      predicted: 'Pikachu',
      epoch: 0,
    });
    expect(parseTrainerLine('sample 9 number conf 0.412 miss - 043/072 → 043/012')).toEqual({
      type: 'sample',
      id: 9,
      field: 'number',
      confidence: 0.412,
      correct: false,
      crop: null,
      truth: '043/072',
      predicted: '043/012',
      epoch: 0,
    });
    // nothing read at all is an empty reading, not the literal text "(nothing)"
    expect(parseTrainerLine('sample 4 name conf 0.100 miss - Mewtwo → (nothing)')).toMatchObject({ predicted: '', correct: false });
  });

  it('reads how long an epoch took, when the trainer reports it', () => {
    expect(parseTrainerLine('epoch   2  loss 1.1  dev name 0.9  number None  (8.1 min)  epoch 243.0 s')).toMatchObject({
      type: 'epoch',
      epoch: 2,
      seconds: 243,
    });
  });

  it('ignores ordinary log lines', () => {
    for (const line of ['synthetic: 500 lines/epoch, 6 fonts, 12 names', '  12 crops listed in the export are missing on disk (skipped)', '', 'Traceback (most recent call last):']) {
      expect(parseTrainerLine(line)).toBeNull();
    }
  });
});

describe('trainer python', () => {
  it('builds the venv path from storage, or uses OCR_TRAIN_VENV', () => {
    expect(trainVenvDir({}, '/data/storage')).toBe(path.join('/data/storage', 'ocr', 'venv'));
    expect(trainVenvDir({ OCR_TRAIN_VENV: '/opt/py' }, '/data/storage')).toBe('/opt/py');
  });

  it('accepts a configured interpreter that imports torch and pillow', () => {
    // this test runs under node, not python: "python3 -c import torch" fails, so
    // point at a tiny shell that exits 0 to prove the probe path and precedence
    const fake = path.join(mkdtempSync(path.join(tmpdir(), 'cv-py-')), 'python');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(findTrainPython(fake)).toEqual({ python: fake });
    expect(findTrainPython(fake, '/data/storage')).toEqual({ python: fake });
  });

  it('explains how to install an interpreter when none is found', () => {
    const fake = path.join(mkdtempSync(path.join(tmpdir(), 'cv-py-')), 'python');
    writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { python, error } = findTrainPython(fake);
    expect(python).toBe('');
    expect(error).toMatch(/cannot import torch and pillow/);
    expect(error).toMatch(/OCR_TRAIN_PYTHON/);
  });

  it('follows the setup script’s phases (and keeps pip progress to one line)', () => {
    expect(setupStep('==> creating the virtual environment in /x/ocr/venv (with python3)')).toBe(1);
    expect(setupStep('==> reusing the virtual environment in /x/ocr/venv')).toBe(1);
    expect(setupStep('==> installing PyTorch (CPU build; the first run downloads a few hundred MB)')).toBe(2);
    expect(setupStep('==> the CPU index was not reachable; trying the default package index')).toBe(2);
    expect(setupStep('==> installing the trainer\'s packages from requirements.txt')).toBe(3);
    expect(setupStep('WARNING: Retrying after connection broken')).toBe(0);
    expect(shortenLine('\u001b[?25h  ━━━ 12.3/45.6 MB 1.2 MB/s eta 0:00:30\r  ━━━ 45.6/45.6 MB 5.0 MB/s eta 0:00:00')).toBe('━━━ 45.6/45.6 MB 5.0 MB/s eta 0:00:00');
    expect(shortenLine('x'.repeat(400)).length).toBeLessThanOrEqual(301);
  });

  it('finds the setup script next to the trainer', () => {
    expect(path.basename(findSetupScript('/opt/cardvault/tools/ocr-trainer'))).toBe('ocr-python.sh');
    expect(path.dirname(findSetupScript('/opt/cardvault/tools/ocr-trainer'))).toBe(path.join('/opt/cardvault', 'scripts'));
  });
});

describe('training progress', () => {
  it('counts a step by epoch and position inside it', () => {
    expect(stepAt(0, 12, 1)).toBe(1);
    expect(stepAt(3, 12, 0)).toBe(36);
    expect(stepAt(29, 12, 12)).toBe(360);
    expect(stepAt(-1, 12, 0)).toBe(0);
  });

  it('picks the checkpoint the trainer keeps: the best held-out score', () => {
    expect(scoreOf({ devName: 0.8, devNumber: 0.6 })).toBeCloseTo(0.7);
    expect(scoreOf({ devName: null, devNumber: 0.9 })).toBeCloseTo(0.9);
    expect(scoreOf({ devName: null, devNumber: null })).toBe(0);
  });
});
