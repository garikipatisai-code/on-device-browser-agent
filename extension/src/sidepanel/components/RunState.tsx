import type { Plan, TaskPhase } from '@/shared/messages';
import { describePhase } from '../view/phase';
import { formatElapsed } from '../view/format';
import { planProgress } from '../view/result';
import { Icon } from './Icon';

/** Live status while the agent works: friendly phase + elapsed + a step-completion progress
 *  meter + the plan as a checklist. */
export function RunState({
  phase,
  plan,
  elapsedMs,
}: {
  phase: TaskPhase;
  plan: Plan | null;
  elapsedMs: number;
}) {
  const info = describePhase(phase);
  const progress = planProgress(plan);
  return (
    <div className="card runstate">
      <div className={`phase ${info.tone}`}>
        <span className="phase-dot" />
        <span className="phase-label">{info.label}</span>
        {info.busy && (
          <span className="elapsed">
            <Icon name="spinner" size={12} /> {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>

      {progress.total > 0 && (
        <div
          className="progress-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={`${progress.done} of ${progress.total} steps complete`}
        >
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }}>
              {progress.activeIndex !== -1 && <span className="progress-fill-pulse" />}
            </div>
          </div>
          <span className="progress-label">
            {progress.done} of {progress.total} steps
          </span>
        </div>
      )}

      {plan && plan.steps.length > 0 && (
        <ul className="plan" aria-label="Plan progress">
          {plan.steps.map((s) => (
            <li key={s.id} className={`plan-step ${s.status}`}>
              <span className={`step-marker ${s.status}`}>
                {s.status === 'completed' && <Icon name="check" size={11} />}
                {s.status === 'failed' && <Icon name="x" size={11} />}
                {s.status === 'active' && <Icon name="spinner" size={13} />}
              </span>
              <span className="step-text">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
