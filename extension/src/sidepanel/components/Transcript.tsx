import type { SessionTurn } from '@/shared/messages';
import { describeVerdict, renderRich } from '../view/format';

/** Read-only history of every turn in the active session EXCEPT the current/most-recent one —
 *  that turn keeps getting the full RunState/ResultCard/Timeline treatment (see App.tsx), so
 *  duplicating it here would show the same answer twice. No interactivity: past turns are just
 *  scroll-back, not editable/re-runnable. */
export function Transcript({ turns }: { turns: SessionTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <div className="transcript">
      {turns.map((t) => {
        const v = t.verdict != null ? describeVerdict(t.verdict) : null;
        return (
          <div key={t.taskId} className="transcript-turn">
            <div className="transcript-goal">{t.goal}</div>
            {t.summary != null && v != null && (
              <div className="transcript-result">
                <span className={`verdict ${v.tone}`}>{v.label}</span>
                <div className="transcript-summary">{renderRich(t.summary)}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
