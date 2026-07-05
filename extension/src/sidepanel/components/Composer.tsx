import { useEffect, useRef, useState } from 'react';
import type { Plan, TaskPhase } from '@/shared/messages';
import { describePhase } from '../view/phase';
import { planProgress } from '../view/result';
import { Icon } from './Icon';

const EXAMPLES = [
  'Find a wireless mouse under $30 and report the top 3',
  'What is the current price of a Raspberry Pi 5 8GB?',
  'Summarize the top Hacker News story right now',
];

type Mode = 'goal' | 'apply' | 'askpage';

interface Props {
  running: boolean;
  goal: string;
  onGoalChange: (v: string) => void;
  onRun: () => void;
  applyUrl: string;
  onApplyUrlChange: (v: string) => void;
  onApply: () => void;
  onAskPage: (question: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  showExamples: boolean;
  /** Below, so a status readout can live right next to the always-reachable Stop button — the
   *  composer is the one part of the page that's guaranteed visible regardless of scroll position
   *  or how long the Activity log has grown, unlike RunState above it. */
  phase: TaskPhase;
  plan: Plan | null;
  eventCount: number;
}

export function Composer({
  running,
  goal,
  onGoalChange,
  onRun,
  applyUrl,
  onApplyUrlChange,
  onApply,
  onAskPage,
  onSteer,
  onStop,
  showExamples,
  phase,
  plan,
  eventCount,
}: Props) {
  const [mode, setMode] = useState<Mode>('goal');
  const [question, setQuestion] = useState('');
  const [steerText, setSteerText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const info = describePhase(phase);
  const progress = planProgress(plan);

  // Auto-grow the goal textarea (1→~4 lines) as the user types.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [goal, mode]);

  const sendSteer = () => {
    const t = steerText.trim();
    if (!t) return;
    onSteer(t);
    setSteerText('');
  };

  // While a task runs, let the user redirect it WITHOUT aborting (Hermes-style "steer").
  const SteerRow = running ? (
    <div className="composer-field steer-row">
      <input
        className="composer-input"
        aria-label="Steer the running task"
        placeholder="Steer the running task — e.g. search each city separately"
        value={steerText}
        onChange={(e) => setSteerText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && steerText.trim()) sendSteer();
        }}
      />
      <button className="btn btn-ghost btn-sm" onClick={sendSteer} disabled={!steerText.trim()} title="Add guidance to the running task">
        <Icon name="cursor" size={13} /> Steer
      </button>
    </div>
  ) : null;

  const StopBtn = (
    <button className="btn btn-danger" onClick={onStop}>
      <Icon name="stop" size={14} /> Stop
    </button>
  );

  // The one status readout guaranteed visible regardless of scroll position — see the Props
  // comment on `phase`/`plan`/`eventCount` above for why it lives here rather than only in
  // RunState. `eventCount` (not just step completion) so a single long-running step still shows
  // real, moving evidence of work instead of sitting silent.
  const StatusLine = running ? (
    <div className="composer-status">
      <span className={`phase ${info.tone}`}>
        <span className="phase-dot" />
        <span className="phase-label">{info.label}</span>
      </span>
      {progress.total > 0 && (
        <span className="composer-status-detail">
          {progress.done} of {progress.total} steps · {eventCount} actions
        </span>
      )}
    </div>
  ) : null;

  if (mode === 'askpage') {
    return (
      <div className="composer card">
        {StatusLine}
        <div className="composer-field">
          <input
            className="composer-input"
            aria-label="Question about this page"
            placeholder="Ask about the page you're on — e.g. what's the key takeaway?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running && question.trim()) onAskPage(question.trim());
            }}
          />
          {running ? (
            StopBtn
          ) : (
            <button className="btn btn-primary" onClick={() => question.trim() && onAskPage(question.trim())} disabled={!question.trim()}>
              <Icon name="eye" size={13} /> Ask
            </button>
          )}
        </div>
        {SteerRow}
        <div className="field-hint">Reads your current tab on-device — the page never leaves your machine.</div>
        <button className="apply-toggle" onClick={() => setMode('goal')} disabled={running}>
          <Icon name="chevron" size={13} /> Back to a goal
        </button>
      </div>
    );
  }

  if (mode === 'apply') {
    return (
      <div className="composer card">
        {StatusLine}
        <div className="composer-field">
          <input
            className="composer-input"
            aria-label="Job URL"
            placeholder="Paste a Greenhouse / Lever job URL"
            value={applyUrl}
            onChange={(e) => onApplyUrlChange(e.target.value)}
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) onApply();
            }}
          />
          {running ? (
            StopBtn
          ) : (
            <button className="btn btn-primary" onClick={onApply} disabled={!applyUrl.trim()}>
              <Icon name="run" size={13} /> Apply
            </button>
          )}
        </div>
        {SteerRow}
        <button className="apply-toggle" onClick={() => setMode('goal')} disabled={running}>
          <Icon name="chevron" size={13} /> Back to a goal
        </button>
      </div>
    );
  }

  return (
    <div className="composer card">
      {StatusLine}
      <div className="composer-field">
        <textarea
          ref={ref}
          rows={1}
          className="composer-input"
          aria-label="Goal"
          placeholder="State a goal — e.g. find a wireless mouse under $30"
          value={goal}
          onChange={(e) => onGoalChange(e.target.value)}
          disabled={running}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !running) {
              e.preventDefault();
              onRun();
            }
          }}
        />
        {running ? (
          StopBtn
        ) : (
          <button className="btn btn-primary" onClick={onRun} disabled={!goal.trim()}>
            <Icon name="run" size={13} /> Run
          </button>
        )}
      </div>

      {SteerRow}

      {showExamples && !running && (
        <div className="chips">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => onGoalChange(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}

      <div className="composer-modes">
        <button className="apply-toggle" onClick={() => setMode('askpage')} disabled={running}>
          <Icon name="eye" size={13} /> Ask about this page
        </button>
        <button className="apply-toggle" onClick={() => setMode('apply')} disabled={running}>
          <Icon name="flag" size={13} /> Apply to a job
        </button>
      </div>
    </div>
  );
}
