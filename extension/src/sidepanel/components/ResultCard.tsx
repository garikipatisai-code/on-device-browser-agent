import { Fragment, type ReactNode, useState } from 'react';
import { describeVerdict, formatElapsed } from '../view/format';
import { Icon, type IconName } from './Icon';

/** Lightweight rich rendering of an answer (no markdown dependency): normalize literal "\n"/"\t"
 *  some models emit as text, render **bold**, and keep real newlines (the container is pre-wrap). */
function renderRich(text: string): ReactNode {
  const normalized = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  return normalized.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** Heroes the agent's answer when a run finishes: verdict badge + summary + copy + meta. */
export function ResultCard({
  verdict,
  summary,
  steps,
  elapsedMs,
  replans,
  sources = [],
}: {
  verdict: string;
  summary: string;
  steps: number | null;
  elapsedMs: number;
  replans: number;
  sources?: string[];
}) {
  const v = describeVerdict(verdict);
  const [copied, setCopied] = useState(false);
  const icon: IconName = v.tone === 'ok' ? 'check' : v.tone === 'error' ? 'x' : 'flag';

  const copy = () => {
    navigator.clipboard?.writeText(summary.replace(/\\n/g, '\n')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return u;
    }
  };

  return (
    <div className="card result">
      <div className="result-head">
        <span className={`verdict ${v.tone}`}>
          <Icon name={icon} size={13} /> {v.label}
        </span>
      </div>
      <div className="result-summary">{renderRich(summary)}</div>
      {sources.length > 0 && (
        <div className="result-sources">
          <Icon name="globe" size={12} />
          <span>
            Source: {sources.map((s, i) => (
              <a key={s} href={s} target="_blank" rel="noreferrer" title={s}>
                {host(s)}{i < sources.length - 1 ? ', ' : ''}
              </a>
            ))}
          </span>
        </div>
      )}
      <div className="result-meta">
        {steps != null && steps > 0 && <span>{steps} steps</span>}
        {elapsedMs > 0 && <span>{formatElapsed(elapsedMs)}</span>}
        {replans > 0 && <span>{replans} replans</span>}
        <button className="btn btn-ghost btn-sm copy-btn" onClick={copy} aria-label="Copy answer">
          <Icon name="copy" size={13} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
