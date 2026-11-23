import { describe, expect, it } from 'vitest';
import { etaFromEpochs, etaFromPace, percent, ratio, summarizeQueue, isTaskActive, type LabTask } from './tasks.js';

const task = (o: Partial<LabTask>): LabTask => ({
  id: 't',
  kind: 'evaluation',
  name: 'Task',
  description: '',
  state: 'queued',
  progress: 0,
  progressLabel: null,
  runtimeMs: null,
  etaSeconds: null,
  step: null,
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  startedAt: null,
  finishedAt: null,
  error: null,
  cancellable: false,
  canRetry: false,
  ...o,
});

describe('progress maths', () => {
  it('clamps percent to whole 0–100, and treats a missing total as 0', () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 0)).toBe(0);
    expect(percent(-3, 10)).toBe(0);
    expect(percent(500, 200)).toBe(100);
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(NaN, 10)).toBe(0);
  });

  it('ratio never divides by zero', () => {
    expect(ratio(1, 0)).toBe(0);
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(9, 4)).toBe(1);
  });
});

describe('time until finished', () => {
  it('has no estimate before the first unit is done', () => {
    expect(etaFromPace(0, 100, 5000)).toBeNull();
    expect(etaFromEpochs(0, 30, 5000)).toBeNull();
  });

  it('extrapolates from the pace so far', () => {
    // 10 of 20 groups in 40 s → 10 left at 4 s each
    expect(etaFromPace(10, 20, 40_000)).toBe(40);
    // 30 of 30 is finished: nothing left, not a negative
    expect(etaFromPace(30, 30, 90_000)).toBe(0);
    expect(etaFromPace(40, 30, 90_000)).toBe(0);
  });

  it('a training run costs about what the epochs so far cost', () => {
    // 2 of 10 epochs in 6 min → 8 left at 3 min each
    expect(etaFromEpochs(2, 10, 6 * 60_000)).toBe(8 * 180);
    expect(etaFromEpochs(10, 10, 60_000)).toBe(0);
    expect(etaFromEpochs(3, 10, 0)).toBeNull();
  });
});

describe('the queue summary', () => {
  it('counts states and follows the running task', () => {
    const q = summarizeQueue([
      task({ id: 'a', state: 'done', progress: 100 }),
      task({ id: 'b', state: 'running', progress: 42 }),
      task({ id: 'c', state: 'queued' }),
      task({ id: 'd', state: 'running', progress: 10 }),
    ]);
    expect(q.counts).toEqual({ done: 1, running: 2, queued: 1 });
    expect(q.activeId).toBe('b'); // the first running one
    expect(q.progress).toBe(42);
    expect(q.total).toBe(4);
  });

  it('shows no progress for a queue that is only waiting', () => {
    const q = summarizeQueue([task({ state: 'queued' })]);
    expect(q.activeId).toBe('t');
    expect(q.progress).toBe(0);
    expect(isTaskActive({ state: 'queued' })).toBe(true);
    expect(isTaskActive({ state: 'done' })).toBe(false);
  });

  it('is empty and quiet with nothing in it', () => {
    expect(summarizeQueue([])).toEqual({ tasks: [], activeId: null, progress: 0, counts: {}, total: 0 });
  });
});
