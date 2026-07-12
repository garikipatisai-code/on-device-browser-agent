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

/** Lightweight rich rendering: **bold**, ### headings, |tables|, --- rules, and newlines.
 *  No markdown library dependency — the model's summary is well-structured enough to parse
 *  line-by-line. Tables get <table> elements, headings get <h3>, rules get <hr>. */
export function renderRich(text: string): ReactNode {
  const normalized = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  const lines = normalized.split('\n');
  const out: ReactNode[] = [];
  let tableAcc: string[] | null = null;

  const flushTable = (key: string) => {
    if (!tableAcc || tableAcc.length < 2) { tableAcc = null; return; }
    // Skip the separator row (|---|---|)
    const dataRows = tableAcc.filter((r) => !/^\|[\s:-]+(?:\|[\s:-]+)*\|$/.test(r));
    if (dataRows.length === 0) { tableAcc = null; return; }
    const headers = dataRows[0].split('|').map((c) => c.trim()).filter(Boolean);
    out.push(
      <table key={key} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8, marginBottom: 8 }}>
        <thead>
          <tr>{headers.map((h, i) => <th key={i} style={{ border: '1px solid var(--border)', padding: '4px 8px', textAlign: 'left', background: 'var(--bg-muted)' }}>{renderInline(h)}</th>)}</tr>
        </thead>
        <tbody>
          {dataRows.slice(1).map((row, ri) => {
            const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
            return <tr key={ri}>{cells.map((c, ci) => <td key={ci} style={{ border: '1px solid var(--border)', padding: '4px 8px' }}>{renderInline(c)}</td>)}</tr>;
          })}
        </tbody>
      </table>,
    );
    tableAcc = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table row — accumulate
    if (line.startsWith('|') && (line.endsWith('|') || line.endsWith('| '))) {
      if (!tableAcc) tableAcc = [];
      tableAcc.push(line);
      continue;
    }
    flushTable(`t${i}`);

    // Divider
    if (/^---+$/.test(line.trim())) {
      out.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />);
      continue;
    }

    // Heading
    if (line.startsWith('### ')) {
      out.push(<h3 key={i} style={{ margin: '12px 0 4px', fontSize: 13 }}>{renderInline(line.slice(4))}</h3>);
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(<h2 key={i} style={{ margin: '14px 0 4px', fontSize: 14 }}>{renderInline(line.slice(3))}</h2>);
      continue;
    }

    // Regular line
    out.push(
      <div key={i} style={{ minHeight: '1.4em' }}>
        {renderInline(line) || <>&nbsp;</>}
      </div>,
    );
  }
  flushTable('end');

  return out;
}

/** Inline rendering: **bold** and raw text. */
function renderInline(text: string): ReactNode {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}
