/** Small inline icons (no icon font / CDN needed on a LAN). */
const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const CameraIcon = () => (
  <svg {...base}>
    <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13.5" r="3.5" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...base}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);

/** The OCR Lab's own glyphs: task kinds, queue controls, outcomes. */

type IconProps = { size?: number; className?: string; title?: string };

const sized = ({ size = 16, className, title }: IconProps) => ({
  ...base,
  width: size,
  height: size,
  className,
  ...(title ? { 'aria-label': title, role: 'img' as const, 'aria-hidden': undefined } : {}),
});

export const LayersIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 3 3 8l9 5 9-5-9-5z" />
    <path d="m3 13 9 5 9-5" />
    <path d="m3 17.5 9 5 9-5" opacity=".5" />
  </svg>
);

export const TargetIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" />
  </svg>
);

export const DownloadIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
    <path d="M4 18v2h16v-2" />
  </svg>
);

export const SparkIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
  </svg>
);

export const TerminalIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </svg>
);

export const ImportIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 20V9m0 0 4 4m-4-4-4 4" />
    <path d="M4 6V4h16v2" />
  </svg>
);

export const PulseIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M3 12h4l2-5 4 10 2-5h6" />
  </svg>
);

export const ScanIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />
    <path d="M4 12h16" />
  </svg>
);

export const QueueIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M4 6h10M4 12h16M4 18h7" />
    <circle cx="18.5" cy="6" r="1.5" />
    <circle cx="15.5" cy="18" r="1.5" />
  </svg>
);

export const XIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const CheckIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
);

export const AlertIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 4 2.5 20h19L12 4z" />
    <path d="M12 10v4M12 17.5v.5" />
  </svg>
);

export const ClockIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const StopIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export const RefreshIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M20 11a8 8 0 1 0-2.3 6.3" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const PlayIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M7 4.5v15l13-7.5-13-7.5z" />
  </svg>
);

export const ChevronIcon = ({ dir = 'down', ...p }: IconProps & { dir?: 'up' | 'down' | 'right' }) => (
  <svg {...sized(p)} style={{ transform: dir === 'up' ? 'rotate(180deg)' : dir === 'right' ? 'rotate(-90deg)' : undefined }}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const ShieldIcon = (p: IconProps = {}) => (
  <svg {...sized(p)}>
    <path d="M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-3z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
