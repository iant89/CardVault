import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressRing } from './ProgressRing';

const html = (value: number, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ProgressRing, { value, size: 40, stroke: 4, ...extra }));

describe('progress ring', () => {
  it('sweeps the arc to the progress value', () => {
    const half = html(50);
    expect(half).toContain('data-progress="50"');
    // fills exactly half the circumference: the unswept offset is half of it
    expect(half).toMatch(/stroke-dashoffset="[^"]*"/);
    const empty = html(0);
    const full = html(100);
    expect(empty).toContain('data-progress="0"');
    expect(full).toContain('data-progress="100"');
    const offset = (s: string) => Number(/stroke-dashoffset="([\d.]+)"/.exec(s)?.[1]);
    expect(offset(full)).toBeCloseTo(0, 3);
    expect(offset(half)).toBeCloseTo(offset(empty) / 2, 3);
  });

  it('clamps what it is given', () => {
    expect(html(-20)).toContain('data-progress="0"');
    expect(html(400)).toContain('data-progress="100"');
  });

  it('draws no arc when idle, and still shows the track', () => {
    const idle = html(70, { idle: true });
    expect(idle).toContain('p-ring-track');
    expect(idle).not.toContain('p-ring-arc');
  });

  it('renders the centre content and an accessible label', () => {
    const s = renderToStaticMarkup(createElement(ProgressRing, { value: 30, label: 'Training 30%', children: createElement('b', null, '30%') }));
    expect(s).toContain('30%');
    expect(s).toContain('aria-label="Training 30%"');
  });
});
