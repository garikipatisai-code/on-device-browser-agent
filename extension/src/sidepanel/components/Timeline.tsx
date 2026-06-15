import type { TimelineEvent } from '@/shared/messages';
import { useEffect, useRef } from 'react';

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function eventClass(e: TimelineEvent): string {
  switch (e.kind) {
    case 'role.start':
    case 'role.end':
    case 'planner.plan':
      return 'role';
    case 'tool.call':
      return 'tool';
    case 'tool.result':
      return e.ok ? 'ok' : 'bad';
    case 'evaluator.verdict':
      return e.verdict === 'PASS' ? 'ok' : 'bad';
    case 'breaker.trip':
      return 'bad';
    case 'finish':
      return 'finish';
    case 'log':
      return e.level === 'error' ? 'bad' : '';
    default:
      return '';
  }
}

function eventTitle(e: TimelineEvent): string {
  switch (e.kind) {
    case 'planner.plan':
      return `Planner produced ${e.plan.steps.length} step plan`;
    case 'role.start':
      return `▶ ${e.role}${e.stepId ? ` (step ${e.stepId.slice(0, 6)})` : ''}`;
    case 'role.end':
      return `■ ${e.role} done (${(e.ms / 1000).toFixed(1)}s)`;
    case 'tool.call':
      return `🔧 ${e.tool}`;
    case 'tool.result':
      return `${e.ok ? '✅' : '❌'} ${e.tool}`;
    case 'evaluator.verdict':
      return `${e.verdict === 'PASS' ? '✅' : '❌'} ${e.verdict}`;
    case 'breaker.trip':
      return `⛔ breaker trip: ${e.reason}`;
    case 'compaction':
      return `📦 compaction (${e.before} → ${e.after} chars)`;
    case 'finish':
      return `🏁 ${e.verdict}`;
    case 'log':
      return `${e.level.toUpperCase()}`;
  }
}

function eventBody(e: TimelineEvent): string | null {
  switch (e.kind) {
    case 'planner.plan':
      return e.plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
    case 'tool.call':
      return JSON.stringify(e.args, null, 2);
    case 'tool.result':
      return e.content;
    case 'evaluator.verdict':
      return e.reason;
    case 'finish':
      return e.summary;
    case 'log':
      return e.message;
    default:
      return null;
  }
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="timeline">
        <div style={{ color: 'var(--fg-mute)', padding: 20, textAlign: 'center' }}>
          No activity yet. State a goal and press Run.
        </div>
      </div>
    );
  }

  return (
    <div className="timeline" ref={ref}>
      {events.map((e, idx) => {
        const body = eventBody(e);
        return (
          <div key={idx} className={`event ${eventClass(e)}`}>
            <div className="event-head">
              <span>{eventTitle(e)}</span>
              <span>{fmtTs(e.ts)}</span>
            </div>
            {body !== null && body !== '' && (
              <div className="event-body">
                {body.length > 200 ? <pre>{body}</pre> : body}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
