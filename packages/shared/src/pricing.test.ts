import { describe, expect, it } from 'vitest';
import { summarize, median, withoutOutliers } from './pricing.js';
import { combineSignals, decideConfidence } from './confidence.js';
import { normalizeCollectorNumber, similarity } from './text.js';

const now = new Date('2026-06-01T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

describe('pricing', () => {
  it('separates listed from sold and reports sold median/average', () => {
    const pts = [
      ...[75, 80, 89, 100].map((p) => ({ price: p, observedAt: daysAgo(1), saleType: 'LISTING' })),
      ...[61, 65, 68, 72, 66].map((p, i) => ({ price: p, observedAt: daysAgo(i + 1), saleType: 'SOLD' })),
    ];
    const s = summarize(pts, now);
    expect(s.recentSoldMedian).toBe(66);
    expect(s.recentSoldAverage).toBe(66.4);
    expect(s.marketPrice).toBe(66);
    expect(s.listed.median).toBe(84.5);
  });

  it('computes a 30-day trend', () => {
    const pts = [
      { price: 100, observedAt: daysAgo(40), saleType: 'SOLD' },
      { price: 110, observedAt: daysAgo(5), saleType: 'SOLD' },
    ];
    expect(summarize(pts, now).trend30d).toBe(10);
  });

  it('drops a single abnormal sale', () => {
    expect(withoutOutliers([10, 11, 12, 11, 10, 500])).not.toContain(500);
    expect(median([1, 3, 2])).toBe(2);
  });
});

describe('confidence', () => {
  it('maps thresholds', () => {
    expect(decideConfidence(0.97)).toBe('AUTO_ACCEPT');
    expect(decideConfidence(0.85)).toBe('VERIFY');
    expect(decideConfidence(0.5)).toBe('MANUAL');
  });
  it('rewards agreeing strong signals', () => {
    const c = combineSignals([
      { signal: 'name', score: 0.95, weight: 3 },
      { signal: 'number', score: 1, weight: 3 },
      { signal: 'image', score: 0.92, weight: 2 },
    ]);
    expect(c).toBeGreaterThan(0.95);
  });
});

describe('text', () => {
  it('normalizes collector numbers', () => {
    expect(normalizeCollectorNumber('025/198')).toBe('25');
    expect(normalizeCollectorNumber('#7')).toBe('7');
    expect(similarity('Pikachu', 'Pikachv')).toBeGreaterThan(0.8);
  });
});
