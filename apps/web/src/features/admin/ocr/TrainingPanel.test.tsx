import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccuracyChart, TrainingPanel, type TrainingRun } from './TrainingPanel';

const render = (t: TrainingRun) => renderToStaticMarkup(createElement(TrainingPanel, { t, busy: true, onStop: () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const running: TrainingRun = {
  status: 'running',
  dataset: '20261122-120000',
  lines: 501,
  epochs: 30,
  epoch: 4,
  loss: 2.3456,
  devName: 0.71,
  devNumber: 0.9,
  step: 48,
  steps: 360,
  secondsPerEpoch: 185,
  etaSeconds: 4_800,
  startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  bestEpoch: 3,
  bestName: 0.72,
  history: [
    { epoch: 1, loss: 4.2, devName: 0.1, devNumber: 0.2, minutes: 3 },
    { epoch: 2, loss: 3.1, devName: 0.55, devNumber: 0.6, minutes: 6 },
    { epoch: 3, loss: 2.6, devName: 0.72, devNumber: 0.88, minutes: 9 },
    { epoch: 4, loss: 2.3456, devName: 0.71, devNumber: 0.9, minutes: 12 },
  ],
  recent: [
    { id: 1, field: 'name', truth: 'Pikachu', predicted: 'Pikachu', confidence: 0.98, correct: true, crop: 'ocr/abc.png', epoch: 4 },
    { id: 2, field: 'number', truth: '043/072', predicted: '043/012', confidence: 0.61, correct: false, crop: 'ocr/def.png', epoch: 4 },
  ],
};

describe('the training panel', () => {
  it('shows the time until finished once a pace exists', () => {
    const t = text(render(running));
    expect(t).toContain('Time until finished');
    expect(t).toContain('~1 h 20 min left');
    expect(t).toContain('Elapsed');
    expect(t).toContain('48 / 360');
    expect(t).toContain('Epoch 4 of 30');
    expect(t).toContain('~3m 05s per epoch');
    expect(t).toContain('Best epoch so far');
    expect(t).toContain('#3');
    // the best line names the same epoch as the tracker (mean held-out accuracy), not the highest single field
    expect(t).toContain('Best: epoch 3 — names 71.0%, numbers 90.0%');
  });

  it('lists the held-out lines with their verdict, reading and confidence', () => {
    const html = render(running);
    const t = text(html);
    expect(t).toContain('Recent held-out lines');
    expect(t).toContain('1 of 2 right');
    expect(t).toContain('Pikachu');
    expect(t).toContain('043/012'); // what it read
    expect(t).toContain('043/072'); // what the line says
    expect(t).toContain('98% sure');
    expect(t).toContain('61% sure');
    expect(html).toContain('/api/dev/ocr/training/crop?path=ocr%2Fabc.png');
    expect(html).toContain('ocr-vision-card ok');
    expect(html).toContain('ocr-vision-card no');
  });

  it('says it is estimating before the first epoch, rather than guessing', () => {
    const t = text(render({ status: 'running', epochs: 10, epoch: 0, startedAt: new Date().toISOString() }));
    expect(t).toContain('estimating after the first epoch');
  });

  it('does not offer to stop a finished run, and reports the model it wrote', () => {
    const html = render({ status: 'done', modelId: 'crnn-20261122-190626', minutes: 44, devName: 0.94, devNumber: 0.99 });
    expect(text(html)).toContain('Wrote crnn-20261122-190626');
    expect(html).not.toContain('>Stop<');
  });
});

describe('held-out accuracy chart', () => {
  it('waits for a second epoch before drawing a line', () => {
    expect(text(renderToStaticMarkup(createElement(AccuracyChart, { history: [] })))).toContain('No epochs finished yet');
    expect(text(renderToStaticMarkup(createElement(AccuracyChart, { history: [running.history![0]!] })))).toContain('The chart fills in as epochs finish');
  });

  it('draws both series and the best epoch', () => {
    const s = renderToStaticMarkup(createElement(AccuracyChart, { history: running.history!, bestEpoch: 3 }));
    expect(s).toContain('ocr-chart-name');
    expect(s).toContain('ocr-chart-number');
    expect(s).toContain('ocr-chart-bestline');
    expect(s).toContain('epoch 1');
    expect(s).toContain('epoch 4');
  });

  it('skips a series the trainer could not measure', () => {
    const s = renderToStaticMarkup(createElement(AccuracyChart, { history: [{ epoch: 1, loss: 1, devName: 0.5, devNumber: null, minutes: 1 }, { epoch: 2, loss: 1, devName: 0.6, devNumber: null, minutes: 2 }] }));
    expect(s).toContain('ocr-chart-name');
    expect(s).not.toContain('ocr-chart-number-dot');
  });
});
