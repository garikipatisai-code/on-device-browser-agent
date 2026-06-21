import { useState } from 'react';
import { describeVerdict, formatElapsed } from '../view/format';
import { Icon, type IconName } from './Icon';

/** Heroes the agent's answer when a run finishes: verdict badge + summary + copy + meta. */
export function ResultCard({
  verdict,
  summary,
  steps,
  elapsedMs,
  replans,
}: {
  verdict: string;
  summary: string;
  steps: number | null;
  elapsedMs: number;
  replans: number;
}) {
  const v = describeVerdict(verdict);
  const [copied, setCopied] = useState(false);
  const icon: IconName = v.tone === 'ok' ? 'check' : v.tone === 'error' ? 'x' : 'flag';

  const copy = () => {
    navigator.clipboard?.writeText(summary).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div className="card result">
      <div className="result-head">
        <span className={`verdict ${v.tone}`}>
          <Icon name={icon} size={13} /> {v.label}
        </span>
      </div>
      <div className="result-summary">{summary}</div>
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
