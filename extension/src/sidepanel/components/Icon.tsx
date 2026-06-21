// Inline-SVG icon set — no icon library (keeps the extension dependency-free) and crisper
// than emoji (which render inconsistently across platforms). 16px stroke icons by default.

export type IconName =
  | 'spark' | 'run' | 'stop' | 'check' | 'dot' | 'spinner'
  | 'plan' | 'globe' | 'cursor' | 'search' | 'eye' | 'flag'
  | 'alert' | 'gear' | 'gauge' | 'copy' | 'lock' | 'plus' | 'chevron' | 'x';

const STROKE: Record<string, string> = {
  check: 'M4 12.5l5 5L20 6',
  dot: '', // drawn as a circle below
  spinner: 'M12 3a9 9 0 1 0 9 9',
  plan: 'M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18',
  cursor: 'M5 3l15 8-6.5 1.6L11 19z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20.5 20.5L16 16',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  flag: 'M5 21V4M5 4h12l-2.2 4L17 12H5',
  alert: 'M12 3l9.5 17H2.5zM12 10v4.5M12 18h.01',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5',
  gauge: 'M3.5 14a8.5 8.5 0 0 1 17 0M12 14l4-3.5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  spark: 'M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4z',
};

const FILLED = new Set(['run', 'stop', 'dot', 'spark']);

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    focusable: false as const,
  };
  if (name === 'run') {
    return (
      <svg {...common} fill="currentColor" className={className}>
        <path d="M7 4.5l13 7.5-13 7.5z" />
      </svg>
    );
  }
  if (name === 'stop') {
    return (
      <svg {...common} fill="currentColor" className={className}>
        <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
      </svg>
    );
  }
  if (name === 'dot') {
    return (
      <svg {...common} fill="currentColor" className={className}>
        <circle cx="12" cy="12" r="5" />
      </svg>
    );
  }
  if (name === 'spark') {
    return (
      <svg {...common} fill="currentColor" className={className}>
        <path d={STROKE.spark} />
      </svg>
    );
  }
  return (
    <svg
      {...common}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={name === 'spinner' ? `spin ${className ?? ''}` : className}
    >
      <path d={STROKE[name]} />
    </svg>
  );
}
