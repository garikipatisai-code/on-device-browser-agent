// ULID-ish ID generator. Tests rely on monotonic but unique IDs.
let _last = 0;
let _counter = 0;
export function ulid(): string {
  const now = Date.now();
  if (now === _last) {
    _counter += 1;
  } else {
    _last = now;
    _counter = 0;
  }
  const t = now.toString(36).padStart(9, '0');
  const c = _counter.toString(36).padStart(3, '0');
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0');
  return `${t}${c}${r}`;
}

// Deterministic JSON stringify (key-order invariant).
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

// Hash for action-repetition detection.
export function actionHash(toolName: string, args: unknown): string {
  return `${toolName}::${stableStringify(args)}`;
}

// Permissive JSON parse — recovers JSON from prose-wrapped responses.
export function parseJSONPermissive<T = unknown>(input: string): T | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through */
  }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* noop */
    }
  }
  const balanced = findFirstBalanced(s);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch {
      /* noop */
    }
  }
  return null;
}

function findFirstBalanced(s: string): string | null {
  const openIdx = firstAnyOf(s, ['{', '[']);
  if (openIdx < 0) return null;
  const open = s[openIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(openIdx, i + 1);
    }
  }
  return null;
}

function firstAnyOf(s: string, needles: string[]): number {
  let min = -1;
  for (const n of needles) {
    const i = s.indexOf(n);
    if (i >= 0 && (min < 0 || i < min)) min = i;
  }
  return min;
}

// EWMA-smoothed chars/token ratio, seeded at 4.0 (Latin-text default).
export class TokenRatioEstimator {
  private ratio = 4.0;
  private alpha: number;
  constructor(alpha = 0.2) {
    this.alpha = alpha;
  }
  reset(): void {
    this.ratio = 4.0;
  }
  observe(chars: number, tokens: number): void {
    if (chars <= 0 || tokens <= 0) return;
    const r = chars / tokens;
    if (!isFinite(r) || r <= 0) return;
    this.ratio = this.alpha * r + (1 - this.alpha) * this.ratio;
  }
  approxTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / Math.max(1, this.ratio));
  }
  currentRatio(): number {
    return this.ratio;
  }
}
