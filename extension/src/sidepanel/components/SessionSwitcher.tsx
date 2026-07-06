import type { Session } from '@/shared/messages';
import { Icon } from './Icon';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** GPT-style chat switcher: pick a past session, start a new one, or delete the active one.
 *  Modeled on RecipesPanel's list pattern (select + row-between actions). */
export function SessionSwitcher({ sessions, activeSessionId, onNew, onSelect, onDelete }: Props) {
  const active = sessions.find((s) => s.id === activeSessionId);
  return (
    <div className="card session-switcher">
      <div className="row-between">
        <select
          className="recipe-select"
          aria-label="Chat session"
          value={activeSessionId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
        >
          {!active && <option value="">New chat</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || 'New chat'}
            </option>
          ))}
        </select>
        <div className="session-actions">
          <button className="btn btn-sm" onClick={onNew}>
            <Icon name="plus" size={12} /> New chat
          </button>
          {active && (
            <button className="btn btn-sm btn-danger" onClick={() => onDelete(active.id)}>
              <Icon name="x" size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
