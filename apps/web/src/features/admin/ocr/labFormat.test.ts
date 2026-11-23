import { describe, expect, it } from 'vitest';
import type { LabTask } from '@cardvault/shared';
import { formatDuration, formatEta, orderTasks, queueSummaryText, taskSubtitle, STATE_LABEL } from './labFormat';

const task = (o: Partial<LabTask>): LabTask => ({
  id: o.id ?? 't',
  kind: 'evaluation',
  name: 'Score a model',
  description: '',
  state: 'queued',
  progress: 0,
  progressLabel: null,
  runtimeMs: null,
  etaSeconds: null,
  step: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  cancellable: false,
  canRetry: false,
  ...o,
});

describe('durations', () => {
  it('reads a runtime the way a person says it', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(400)).toBe('<1s');
    expect(formatDuration(48_000)).toBe('48s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });

  it('rounds a time-until-finished to something honest', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(2)).toBe('almost done');
    expect(formatEta(44)).toBe('~45s left');
    expect(formatEta(150)).toBe('~3 min left');
    expect(formatEta(3 * 3600)).toBe('~3 h left');
    expect(formatEta(3 * 3600 + 600)).toBe('~3 h 10 min left');
  });
});

describe('task lines', () => {
  it('shows why a task failed instead of what it was doing', () => {
    expect(taskSubtitle(task({ state: 'failed', error: 'No Python with torch.', description: 'Training' }))).toBe('No Python with torch.');
    expect(taskSubtitle(task({ state: 'cancelled' }))).toBe('Stopped.');
    expect(taskSubtitle(task({ state: 'running', description: 'Epoch 3 of 30' }))).toBe('Epoch 3 of 30');
    expect(taskSubtitle(task({ state: 'queued', description: '' }))).toBe('Waiting for the worker…');
  });

  it('summarises the queue for the button', () => {
    expect(queueSummaryText(null)).toBe('No tasks in the OCR Lab queue');
    expect(queueSummaryText({ tasks: [], activeId: null, progress: 0, counts: {}, total: 0 })).toBe('No tasks in the OCR Lab queue');
    expect(
      queueSummaryText({ tasks: [task({})], activeId: 't', progress: 0, counts: { running: 1, queued: 2 }, total: 3 }),
    ).toBe('Task queue · 1 running · 2 queued');
    expect(queueSummaryText({ tasks: [task({})], activeId: null, progress: 0, counts: { failed: 1 }, total: 1 })).toBe('Task queue · 1 failed');
  });

  it('puts running work first and finished work last, newest first within a state', () => {
    const a = task({ id: 'done-old', state: 'done', createdAt: '2026-01-01T00:00:00.000Z' });
    const finishedNew = task({ id: 'done-new', state: 'done', createdAt: '2026-01-02T00:00:00.000Z' });
    const waiting = task({ id: 'wait', state: 'queued' });
    const running = task({ id: 'run', state: 'running' });
    expect(orderTasks([a, finishedNew, waiting, running]).map((t) => t.id)).toEqual(['run', 'wait', 'done-new', 'done-old']);
  });

  it('has a label for every state', () => {
    expect(STATE_LABEL).toEqual({ queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' });
  });
});
