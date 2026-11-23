import type { ReactNode } from 'react';

export interface ProgressRingProps {
  /** 0–100 */
  value: number;
  /** ring diameter in px */
  size?: number;
  /** ring thickness in px */
  stroke?: number;
  /** centre content: an icon, the number, anything that fits */
  children?: ReactNode;
  /** the colour of the swept arc (defaults to the accent gradient's first stop) */
  color?: string;
  /** a soft second colour for a gradient sweep; omit for a flat arc */
  colorTo?: string;
  /** dim the unfilled track further (over a busy background) */
  track?: string;
  /** an idle ring (coarse dashed track, no arc): the queue is empty */
  idle?: boolean;
  className?: string;
  /** accessible label; the ring itself is decorative */
  label?: string;
}

/**
 * A circular progress indicator.
 *
 * Drawn with a single stroked circle: `stroke-dasharray` is the circumference
 * and `stroke-dashoffset` the unfilled part, rotated a quarter turn so the fill
 * starts at twelve o'clock and runs clockwise. The gradient is per-instance, so
 * two rings on a page cannot share the wrong colours.
 */
export function ProgressRing({
  value,
  size = 34,
  stroke = 3,
  children,
  color = 'var(--accent)',
  colorTo,
  track = 'rgba(148,163,196,.22)',
  idle = false,
  className,
  label,
}: ProgressRingProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const id = `ring-${Math.round(size)}-${stroke}-${Math.round(pct)}`;
  return (
    <span
      className={`p-ring${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
      data-progress={Math.round(pct)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {colorTo && (
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={colorTo} />
            </linearGradient>
          </defs>
        )}
        <circle
          className="p-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={track}
          strokeWidth={stroke}
          strokeDasharray={idle ? `${stroke} ${stroke * 2}` : undefined}
        />
        {!idle && (
          <circle
            className="p-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colorTo ? `url(#${id})` : color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct / 100)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      {children != null && <span className="p-ring-center">{children}</span>}
    </span>
  );
}
