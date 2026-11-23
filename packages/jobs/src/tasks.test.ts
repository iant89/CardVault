import { describe, expect, it } from 'vitest';
import { taskKeyOf, toLabTask, type TaskRecord } from './tasks.js';

const record = (o: Partial<TaskRecord> = {}): TaskRecord => ({
  key: 'ocr-train',
  kind: 'train',
  name: 'Train a line reader',
  state: 'running',
  progress: 42,
  progressLabel: '48 / 360 steps',
  detail: 'Epoch 4 of 30',
  etaSeconds: 4800,
  step: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:01:00.000Z',
  finishedAt: null,
  runtimeMs: null,
  error: null,
  result: null,
  retry: null,
  ...o,
});

describe('a stored task as the page shows it', () => {
  it('ticks the runtime of a running task from its start', () => {
    const t = toLabTask(record(), new Date('2026-01-01T00:06:00.000Z').getTime());
    expect(t.runtimeMs).toBe(5 * 60_000);
    expect(t.cancellable).toBe(true);
    expect(t.etaSeconds).toBe(4800);
  });

  it('keeps the final runtime of a finished task and drops the estimate', () => {
    const t = toLabTask(record({ state: 'done', finishedAt: '2026-01-01T00:31:00.000Z', runtimeMs: 30 * 60_000 }), Date.now());
    expect(t.runtimeMs).toBe(30 * 60_000);
    expect(t.etaSeconds).toBeNull();
    expect(t.progress).toBe(100); // a finished task's bar is full, whatever the store said
    expect(t.cancellable).toBe(false);
  });

  it('clamps a percentage and reports an error', () => {
    const t = toLabTask(record({ state: 'failed', progress: 180, error: 'The trainer exited with code 1.' }));
    expect(t.progress).toBe(100);
    expect(t.error).toBe('The trainer exited with code 1.');
  });
});

describe('linking a job to its queue entry', () => {
  it('uses the same keys the processors write', () => {
    expect(taskKeyOf('ocr-evaluate', { evaluationId: 'abc' })).toBe('ocr-evaluate:abc');
    expect(taskKeyOf('ocr-export-dataset')).toBe('ocr-export');
    expect(taskKeyOf('ocr-train-model')).toBe('ocr-train');
    expect(taskKeyOf('ocr-python-setup')).toBe('ocr-python');
    expect(taskKeyOf('ocr-import-harvest')).toBe('ocr-import');
    expect(taskKeyOf('ocr-watch')).toBe('ocr-watch');
    expect(taskKeyOf('ocr-scan-models')).toBe('ocr-rescan');
  });

  it('has no entry for work that is not a lab task', () => {
    expect(taskKeyOf('recover-stale')).toBeNull();
    expect(taskKeyOf('ocr-evaluate', {})).toBeNull();
  });
});
