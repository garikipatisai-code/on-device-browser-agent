import { useState } from 'react';
import type { TimelineEvent } from '@/shared/messages';
import { Icon, type IconName } from './Icon';

function toolIcon(tool: string): IconName {
  if (tool.includes('search')) return 'search';
  if (tool.includes('aria') || tool.includes('vision')) return 'eye';
  if (tool.includes('open')) return 'globe';
  if (tool.includes('click') || tool.includes('type') || tool.includes('select') || tool.includes('scroll') || tool.includes('upload')) return 'cursor';
  return 'dot';
}

function classify(e: TimelineEvent): { cls: string; icon: IconName } {
  switch (e.kind) {
    case 'planner.plan':
      return { cls: 'role', icon: 'plan' };
    case 'role.start':
    case 'role.end':
      return { cls: 'role', icon: 'dot' };
    case 'tool.call':
      return { cls: 'tool', icon: toolIcon(e.tool) };
    case 'tool.result':
      return e.ok ? { cls: 'ok', icon: 'check' } : { cls: 'bad', icon: 'x' };
    case 'evaluator.verdict':
      return e.verdict === 'PASS' ? { cls: 'ok', icon: 'check' } : { cls: 'bad', icon: 'x' };
    case 'breaker.trip':
      return { cls: 'bad', icon: 'alert' };
    case 'antibot.blocked':
      return { cls: 'bad', icon: 'alert' };
    case 'antibot.resolved':
      return { cls: 'ok', icon: 'check' };
    case 'compaction':
      return { cls: '', icon: 'plan' };
    case 'finish':
      return { cls: 'finish', icon: 'flag' };
    case 'log':
      return { cls: e.level === 'error' ? 'bad' : '', icon: e.level === 'error' ? 'alert' : 'dot' };
    default:
      return { cls: '', icon: 'dot' };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function title(e: TimelineEvent): string {
  switch (e.kind) {
    case 'planner.plan':
      return `Planned ${e.plan.steps.length} steps`;
    case 'role.start':
      return `${cap(e.role)} started`;
    case 'role.end':
      return `${cap(e.role)} · ${(e.ms / 1000).toFixed(1)}s`;
    case 'tool.call':
      return e.tool;
    case 'tool.result':
      return e.tool;
    case 'evaluator.verdict':
      return `Evaluated · ${e.verdict}`;
    case 'breaker.trip':
      return `Circuit breaker · ${e.reason}`;
    case 'antibot.blocked':
      return `Blocked · ${e.label}`;
    case 'antibot.resolved':
      return 'Resolved, continuing';
    case 'compaction':
      return `Compacted (${e.before}→${e.after})`;
    case 'finish':
      return `Finished · ${e.verdict}`;
    case 'log':
      return cap(e.level);
    default:
      return cap((e as TimelineEvent).kind);
  }
}

function body(e: TimelineEvent): string | null {
  switch (e.kind) {
    case 'planner.plan':
      return e.plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
    case 'tool.call':
      return JSON.stringify(e.args);
    case 'tool.result':
      return e.content;
    case 'evaluator.verdict':
      return e.reason;
    case 'antibot.blocked':
      return 'Waiting for you to resolve this in the tab.';
    case 'finish':
      return e.summary;
    case 'log':
      return e.message;
    default:
      return null;
  }
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Event({ e }: { e: TimelineEvent }) {
  const { cls, icon } = classify(e);
  const text = body(e);
  const long = !!text && text.length > 160;
  const [open, setOpen] = useState(false);
  return (
    <div className={`event ${cls}`}>
      <span className="event-icon">
        <Icon name={icon} size={14} />
      </span>
      <div className="event-main">
        <div className="event-title">
          <span className="event-name">{title(e)}</span>
          <span className="event-time">{fmtTs(e.ts)}</span>
        </div>
        {text &&
          (long ? (
            <>
              <button className="detail-toggle" onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide details' : 'Show details'}
              </button>
              {open && <pre>{text}</pre>}
            </>
          ) : (
            <div className="event-body">{text}</div>
          ))}
      </div>
    </div>
  );
}

export function Timeline({
  events,
  open,
  onToggle,
}: {
  events: TimelineEvent[];
  open: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (events.length === 0) return null;

  // Plain-text dump of the whole run, so it can be copied + shared even after the run ends.
  const copyTrace = () => {
    const text = events
      .map((e) => {
        const b = body(e);
        return `${fmtTs(e.ts)}  ${title(e)}${b ? `\n    ${b.replace(/\n/g, '\n    ')}` : ''}`;
      })
      .join('\n');
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div className="activity">
      <div className="activity-head-row">
        <button className={`activity-head ${open ? 'open' : ''}`} onClick={onToggle} aria-expanded={open}>
          <Icon name="plan" size={14} />
          <span>Activity</span>
          <span className="activity-count">{events.length}</span>
          <Icon name="chevron" size={14} className="chev" />
        </button>
        <button className="btn btn-ghost btn-sm copy-btn" onClick={copyTrace} title="Copy the full activity log (every step)" aria-label="Copy activity log">
          <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy steps'}
        </button>
      </div>
      {open && (
        <div className="activity-body">
          {events.map((e, i) => (
            <Event key={i} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}
