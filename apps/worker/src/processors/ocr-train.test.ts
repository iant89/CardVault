import { describe, expect, it } from 'vitest';
import { parseTrainerLine } from './ocr-train.js';

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

  it('ignores ordinary log lines', () => {
    for (const line of ['synthetic: 500 lines/epoch, 6 fonts, 12 names', '  12 crops listed in the export are missing on disk (skipped)', '', 'Traceback (most recent call last):']) {
      expect(parseTrainerLine(line)).toBeNull();
    }
  });
});
