import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LabQueue, LabTask } from '@cardvault/shared';
import { QueuePanel, QueuePopup } from './QueuePanel';

const task = (o: Partial<LabTask>): LabTask => ({
  id: 't',
  kind: 'evaluation',
  name: 'Score Tesseract on exam v1',
  description: 'Reading the frozen exam lines…',
  state: 'running',
  progress: 42,
  progressLabel: '420 / 1,000 groups',
  runtimeMs: null,
  etaSeconds: 96,
  step: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: new Date(Date.now() - 64_000).toISOString(),
  finishedAt: null,
  error: null,
  cancellable: true,
  canRetry: true,
  ...o,
});

const noop = () => {};
const actions = { onCancel: noop, onRetry: noop, onDismiss: noop, onClearFinished: noop, onRefresh: noop };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const queue = (tasks: LabTask[]): LabQueue => ({
  tasks,
  activeId: tasks.find((t) => t.state === 'running')?.id ?? null,
  progress: tasks.find((t) => t.state === 'running')?.progress ?? 0,
  counts: tasks.reduce<Record<string, number>>((a, t) => ({ ...a, [t.state]: (a[t.state] ?? 0) + 1 }), {}),
  total: tasks.length,
});

describe('the queue button', () => {
  it('draws the ring at the active task’s progress', () => {
    const html = renderToStaticMarkup(createElement(QueuePanel, { queue: queue([task({})]), ...actions }));
    expect(html).toContain('data-progress="42"');
    expect(html).toContain('42%');
    expect(html).toContain('ocr-queue-btn busy');
  });

  it('is idle (an empty track rather than a filled ring) with nothing running', () => {
    const html = renderToStaticMarkup(createElement(QueuePanel, { queue: queue([task({ state: 'done', progress: 100 })]), ...actions }));
    expect(html).not.toContain('p-ring-arc');
    expect(html).toContain('idle');
    expect(html).not.toContain('ocr-queue-btn busy');
  });

  it('flags a failure even when the queue is quiet', () => {
    const html = renderToStaticMarkup(createElement(QueuePanel, { queue: queue([task({ state: 'failed', error: 'No Python.' })]), ...actions }));
    expect(html).toContain('1 failed');
    expect(html).toContain('ocr-queue-dot');
  });

  it('keeps the button up before the first poll returns', () => {
    const html = renderToStaticMarkup(createElement(QueuePanel, { queue: null, ...actions }));
    expect(html).toContain('Queue');
    expect(html).toContain('idle');
  });
});

describe('the queue popup', () => {
  const popup = (tasks: LabTask[], now = Date.now()) =>
    renderToStaticMarkup(createElement(QueuePopup, { queue: queue(tasks), now, ...actions }));

  it('shows each task with its name, description, state, bar and runtime', () => {
    const html = popup([task({})]);
    const t = text(html);
    expect(t).toContain('Score Tesseract on exam v1');
    expect(t).toContain('Reading the frozen exam lines');
    expect(t).toContain('Running');
    expect(t).toContain('42%');
    expect(t).toContain('420 / 1,000 groups');
    expect(t).toContain('1m 04s'); // runtime, live
    expect(t).toContain('~2 min left'); // 96 s, to the nearest minute
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
  });

  it('ticks the runtime with the clock it is given', () => {
    const started = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const t = text(popup([task({ startedAt: started, etaSeconds: null })], new Date('2026-01-01T00:01:30.000Z').getTime()));
    expect(t).toContain('1m 30s');
    expect(t).toContain('estimating…');
  });

  it('puts the running task first and finished ones last', () => {
    const html = popup([
      task({ id: 'done', state: 'done', name: 'Export training data', progress: 100, description: '900 lines in 20260101-000000' }),
      task({ id: 'queued', state: 'queued', name: 'Train a line reader' }),
      task({ id: 'run', state: 'running', name: 'Score Tesseract on exam v1' }),
    ]);
    const order = ['Score Tesseract', 'Train a line reader', 'Export training data'].map((s) => html.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text(html)).toContain('Done');
    expect(text(html)).toContain('Queued');
  });

  it('explains a failure and offers to run it again or drop it', () => {
    const html = popup([task({ state: 'failed', error: 'The trainer exited with code 1.', cancellable: false })]);
    const t = text(html);
    expect(t).toContain('The trainer exited with code 1.');
    expect(t).toContain('Failed');
    expect(html).toContain('Run it again');
    expect(html).toContain('Remove from the queue');
    expect(html).not.toContain('Stop this task');
  });

  it('shows a stepped task’s phase (the trainer’s Python setup)', () => {
    const t = text(popup([task({ kind: 'python', name: 'Set up the trainer’s Python', step: { index: 2, total: 3, label: 'PyTorch (CPU build)' }, progressLabel: 'Step 2 / 3' })]));
    expect(t).toContain('Step 2 of 3');
    expect(t).toContain('PyTorch (CPU build)');
  });

  it('says what the queue is for when it is empty', () => {
    const t = text(popup([]));
    expect(t).toContain('Nothing queued');
    expect(t).toContain('Task queue');
  });

  it('offers to clear finished entries only when there are some', () => {
    expect(text(popup([task({ state: 'done' })]))).toContain('Clear finished');
    expect(text(popup([task({ state: 'running' })]))).not.toContain('Clear finished');
  });
});
