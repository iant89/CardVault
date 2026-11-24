import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VisionPanel, type Overview, type VisionRun } from '../OcrLabPage';

const dataset = (id: string, samples: number, fields: Record<string, number>) => ({
  id,
  rows: 400,
  counts: { 'review · name': 400 },
  createdAt: '2026-11-24T10:00:00Z',
  vision: { samples, cards: Math.round(samples / 2), fields },
});

const overview = (over: Partial<Overview> = {}): Overview =>
  ({
    counts: [],
    totals: { samples: 0, regression: 0, cards: 0, exam_groups: 0, last7days: 0 },
    exam: null,
    newSinceExam: 0,
    import: null,
    dataset: null,
    datasets: [dataset('20261124-1000', 620, { name: 600, number: 540 })],
    training: null,
    vision: null,
    python: { status: 'ready', steps: [], venv: '/data/storage/ocr/venv', configured: false, manual: 'bash scripts/ocr-python.sh', setupScript: null, log: [] },
    evaluations: [],
    ...over,
  }) as Overview;

const render = (d: Overview) =>
  renderToStaticMarkup(createElement(VisionPanel, { d, busy: false, trainActive: false, act: async () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('CardVault-Vision training panel', () => {
  it('offers the manifest datasets, saying what each head can train on', () => {
    const t = text(render(overview()));
    expect(t).toContain('Train with CardVault-Vision');
    expect(t).toContain('20261124-1000 · 620 cards');
    expect(t).toContain('600 names');
    expect(t).toContain('540 numbers');
    expect(t).toContain('Name + number (a scan’s pair)');
    expect(t).toContain('Game classifier');
    expect(t).toContain('Train & export');
  });

  it('asks for an export when no dataset has a manifest yet', () => {
    const html = render(overview({ datasets: [{ ...dataset('old', 0, {}), vision: null }] }));
    expect(text(html)).toContain('Export training data first');
    // the button is present but cannot start a run with nothing to train on
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('shows each head’s state while a run is going', () => {
    const vision: VisionRun = {
      status: 'running',
      kind: 'ocr-pair',
      dataset: '20261124-1000',
      version: '2026.11.24-1530',
      epochs: 30,
      device: 'auto',
      task: 'number-ocr',
      epoch: 4,
      stages: [
        { task: 'name-ocr', state: 'exporting', bestMetric: 0.081, metricName: 'cer' },
        { task: 'number-ocr', state: 'training', bestMetric: null, metricName: null },
      ],
      history: [{ epoch: 4, loss: 0.5, cer: 0.091 }],
      step: 2,
      steps: 4,
      etaSeconds: 600,
    };
    const t = text(render(overview({ vision })));
    expect(t).toContain('number-ocr · 20261124-1000');
    expect(t).toContain('epoch 4 of 30');
    expect(t).toContain('held-out CER 9.10%');
    // an exported head has moved on from "training" to its artifact
    expect(t).toContain('↑ name-ocr CER 8.1%');
    expect(t).toContain('• number-ocr');
    expect(t).toContain('Stop');
  });

  it('reports a finished run with the models it registered', () => {
    const vision: VisionRun = {
      status: 'done',
      kind: 'ocr-pair',
      dataset: '20261124-1000',
      version: '1.0.0',
      stages: [
        { task: 'name-ocr', state: 'done', modelId: 'vision-ocr-1.0.0' },
        { task: 'number-ocr', state: 'done', modelId: 'vision-ocr-1.0.0' },
      ],
    };
    const t = text(render(overview({ vision })));
    expect(t).toContain('Finished');
    expect(t).toContain('vision-ocr-1.0.0');
    expect(t).not.toContain('Show the trainer’s log');
  });

  it('explains a failure and keeps the log reachable', () => {
    const vision: VisionRun = {
      status: 'failed',
      kind: 'card-classifier',
      dataset: '20261124-1000',
      stages: [{ task: 'card-classifier', state: 'failed', error: 'vision train card-classifier exited with code 2.' }],
      error: 'vision train card-classifier exited with code 2.',
      log: ['Traceback (most recent call last):', 'ModuleNotFoundError: No module named torch'],
    };
    const t = text(render(overview({ vision })));
    expect(t).toContain('Failed');
    expect(t).toContain('vision train card-classifier exited with code 2.');
    expect(t).toContain('Show the trainer’s log');
    expect(t).toContain('ModuleNotFoundError');
  });
});
