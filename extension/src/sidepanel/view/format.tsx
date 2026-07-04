// Pure formatting helpers for the panel.
import { Fragment, type ReactNode } from 'react';

/** Elapsed wall-clock: "0s", "59s", "1m 35s". Never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export interface VerdictInfo {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'mute';
}

/** Map a finish verdict to a display label + semantic tone. */
export function describeVerdict(verdict: string): VerdictInfo {
  switch (verdict) {
    case 'success':
      return { label: 'Success', tone: 'ok' };
    case 'partial':
      return { label: 'Partial', tone: 'warn' };
    case 'blocked':
      return { label: 'Blocked', tone: 'warn' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'aborted':
      return { label: 'Stopped', tone: 'mute' };
    default:
      return { label: verdict ? verdict[0].toUpperCase() + verdict.slice(1) : 'Done', tone: 'mute' };
  }
}

/** Lightweight rich rendering of an answer (no markdown dependency): normalize literal "\n"/"\t"
 *  some models emit as text, render **bold**, and keep real newlines (the container is pre-wrap). */
export function renderRich(text: string): ReactNode {
  const normalized = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  return normalized.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
