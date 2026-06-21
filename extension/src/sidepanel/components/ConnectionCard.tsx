import { useState } from 'react';
import { Icon } from './Icon';

/** Shown when Ollama isn't reachable. A browser extension can't start a local process, so this
 *  can't literally launch `ollama serve` — but it makes the dead-end actionable: a one-click copy
 *  of the command, a manual Retry, and background polling that reconnects the moment it comes up. */
export function ConnectionCard({ baseUrl, onRetry }: { baseUrl: string; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText('ollama serve').then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );

  return (
    <div className="card conn-down" role="alert">
      <div className="conn-head">
        <span className="conn-icon">
          <Icon name="alert" size={16} />
        </span>
        <span className="conn-title">Ollama isn't running</span>
      </div>
      <div className="conn-text">
        The agent runs models on your machine via Ollama, but nothing is responding at <code>{baseUrl}</code>.
        Start it and this reconnects automatically. (On macOS, opening the Ollama app also starts it.)
      </div>
      <div className="conn-cmd">
        <code>ollama serve</code>
        <button className="btn btn-ghost btn-sm" onClick={copy} aria-label="Copy command">
          <Icon name="copy" size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="conn-actions">
        <button className="btn btn-primary btn-sm" onClick={onRetry}>
          <Icon name="spinner" size={12} /> Retry now
        </button>
        <span className="conn-hint">Checking every few seconds…</span>
      </div>
    </div>
  );
}
