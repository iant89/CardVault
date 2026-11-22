import { describe, expect, it } from 'vitest';
import { autoLabelSource, cer, eraOf, metrics, namePrediction, numberPrediction, sliceReport, splitFor, type ScoredItem } from './ocr-data.js';

describe('exam split', () => {
  it('is stable per card and close to the target share', () => {
    expect(splitFor('card-1')).toBe(splitFor('card-1'));
    const n = 5000;
    let exam = 0;
    for (let i = 0; i < n; i++) if (splitFor(`card-${i}`) === 'exam') exam++;
    expect(exam / n).toBeGreaterThan(0.17);
    expect(exam / n).toBeLessThan(0.23);
  });
});

describe('trusting automatic labels', () => {
  const s = (o: Record<string, number>) => Object.entries(o).map(([signal, score]) => ({ signal, score, weight: 1 }));
  it('a name is corroborated by an exact number or a strong picture match', () => {
    expect(autoLabelSource('name', s({ 'ocr.name': 1, 'ocr.number': 1 }))).toBe('corroborated');
    expect(autoLabelSource('name', s({ 'ocr.name': 1, 'image.hash': 0.9 }))).toBe('corroborated');
    // only the name itself agreed: the engine would be grading itself
    expect(autoLabelSource('name', s({ 'ocr.name': 1, 'ocr.game': 1 }))).toBe('self');
    expect(autoLabelSource('name', s({ 'ocr.name': 1, 'ocr.number': 0.7 }))).toBe('self');
  });
  it('a number needs the picture: a name fits many printings', () => {
    expect(autoLabelSource('number', s({ 'ocr.name': 1, 'ocr.number': 1 }))).toBe('self');
    expect(autoLabelSource('number', s({ 'ocr.number': 1, 'image.hash': 0.9 }))).toBe('corroborated');
  });
});

describe('what a reading counts as', () => {
  it('names: debris trimmed, normalized', () => {
    expect(namePrediction('5 Fletchling 60')).toBe('fletchling');
    expect(namePrediction('BASIC Pikachu ex 200\nsomething')).toBe('pikachu ex');
    expect(namePrediction('')).toBe('');
  });
  it('numbers: normalized, with the printed form', () => {
    expect(numberPrediction('E086/193\nGE086193 SRA', 'pokemon')).toEqual({ norm: '86', raw: '086/193' });
    expect(numberPrediction('nothing here', 'pokemon')).toBeNull();
  });
});

describe('scoring', () => {
  it('character error rate', () => {
    expect(cer('fletchling', 'fletchling')).toBe(0);
    expect(cer('fletchlinq', 'fletchling')).toBeCloseTo(0.1);
    expect(cer('', 'abc')).toBe(1);
  });
  it('eras', () => {
    expect(eraOf('1999-01-09')).toBe('≤2010');
    expect(eraOf('2023-03-31')).toBe('2023+');
    expect(eraOf(null)).toBe('unknown');
  });
  const item = (o: Partial<ScoredItem>): ScoredItem => ({ field: 'name', game: 'pokemon', source: 'review', era: '2023+', correct: true, cer: 0, confidence: 0.95, regression: false, exam: true, ...o });
  it('accuracy, confident accuracy and calibration', () => {
    const m = metrics('x', [item({}), item({}), item({ correct: false, cer: 0.5, confidence: 0.95 }), item({ correct: false, cer: 1, confidence: 0.1 })]);
    expect(m.n).toBe(4);
    expect(m.accuracy).toBe(0.5);
    expect(m.confident).toBe(3);
    expect(m.confidentAccuracy).toBeCloseTo(2 / 3, 3);
    expect(m.calibrationError).toBeGreaterThan(0.2);
  });
  it('slices keep games, sources and eras apart, and the regression set separate', () => {
    const r = sliceReport([
      item({ game: 'pokemon' }),
      item({ game: 'magic', correct: false }),
      item({ field: 'number', source: 'harvest' }),
      item({ regression: true, exam: false, correct: false }),
    ]);
    const get = (s: string) => r.find((x) => x.slice === s);
    expect(get('all · name')!.n).toBe(2);
    expect(get('game magic · name')!.accuracy).toBe(0);
    expect(get('game pokemon · name')!.accuracy).toBe(1);
    expect(get('source harvest · number')!.n).toBe(1);
    expect(get('regression set · name')!.accuracy).toBe(0);
  });
});
