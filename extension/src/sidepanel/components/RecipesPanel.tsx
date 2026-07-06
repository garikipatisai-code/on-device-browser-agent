import { useEffect, useMemo, useState } from 'react';
import type { RecipeView, UserRecipeDraft } from '@/shared/messages';
import { Icon } from './Icon';

interface Props {
  recipes: RecipeView[];
  onRefresh: () => void;
  onSave: (draft: UserRecipeDraft) => void;
  onDelete: (id: string) => void;
}

type EditorState = { id?: string; name: string; whenToUse: string; site: string; stepsText: string };
type Editor = EditorState | null;

const ORIGIN_LABEL: Record<RecipeView['origin'], string> = { builtin: 'Built-in', user: 'Yours', auto: 'Learned' };

/** Turn a recipe's steps back into the editable "one per line + [tool: x]" text. */
function stepsToText(r: RecipeView): string {
  return r.steps.map((s) => `${s.instruction}${s.toolHint ? `  [tool: ${s.toolHint}]` : ''}`).join('\n');
}

const BLANK: EditorState = { name: '', whenToUse: '', site: '*', stepsText: '' };

/** Recipes-as-skills: browse built-in / learned / your recipes, view the exact text the planner
 *  receives, and author/edit your own (guided fields, with a live preview). */
export function RecipesPanel({ recipes, onRefresh, onSave, onDelete }: Props) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [editor, setEditor] = useState<Editor>(null);

  useEffect(() => {
    onRefresh(); // load once when the tab mounts; saves/deletes push fresh lists themselves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(() => recipes.find((r) => r.id === selectedId) ?? recipes[0], [recipes, selectedId]);

  // Live preview while editing: render the draft exactly as the planner will see it.
  const draftPreview = useMemo(() => {
    if (!editor) return '';
    return editor.stepsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, i) => `${i + 1}. ${l}`)
      .join('\n');
  }, [editor]);

  if (editor) {
    const save = () => {
      const draft: UserRecipeDraft = {
        id: editor.id,
        name: editor.name,
        whenToUse: editor.whenToUse,
        site: editor.site,
        stepsText: editor.stepsText,
      };
      onSave(draft);
      setEditor(null);
    };
    return (
      <div className="recipes">
        <div className="card setting-group">
          <h2 className="card-title">
            <Icon name="plan" size={13} /> {editor.id ? 'Edit recipe' : 'New recipe'}
          </h2>
          <div className="field-hint">
            A recipe should be <b>broad but concrete</b>: it should fit a whole class of tasks (any comparison,
            any local search) yet every step must be something the small model can do. Keep it short.
          </div>
          <div className="field">
            <span className="field-label">Name</span>
            <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} placeholder="Compare anything" />
          </div>
          <div className="field">
            <span className="field-label">When to use (one sentence)</span>
            <input
              value={editor.whenToUse}
              onChange={(e) => setEditor({ ...editor, whenToUse: e.target.value })}
              placeholder="comparing several named things on one metric"
            />
          </div>
          <div className="field">
            <span className="field-label">Steps — one per line; optionally end a line with [tool: search | open_result | finish]</span>
            <textarea
              rows={6}
              className="textarea-mono"
              value={editor.stepsText}
              onChange={(e) => setEditor({ ...editor, stepsText: e.target.value })}
              placeholder={'For each item, search one query "<item> <metric>"   [tool: search]\nRead the value from the result snippet\nUse the same basis for all; report which wins   [tool: finish]'}
            />
          </div>
          <div className="field">
            <span className="field-label">Site (optional — defaults to any)</span>
            <input value={editor.site} onChange={(e) => setEditor({ ...editor, site: e.target.value })} placeholder="*" />
          </div>
          {draftPreview && (
            <div className="field">
              <span className="field-label">Preview — what the planner receives</span>
              <pre className="recipe-preview">{draftPreview}</pre>
            </div>
          )}
          <div className="field-hint">
            New or edited recipes start <b>unproven</b>: the first time one actually works it's confirmed; if it
            fails, an edit rolls back to its last good version and a brand-new one is removed.
          </div>
          <div className="recipe-actions">
            <button className="btn" onClick={() => setEditor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={!editor.name.trim() || !editor.whenToUse.trim()}>
              <Icon name="check" size={13} /> Save recipe
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="recipes">
      <div className="card setting-group">
        <div className="row-between">
          <h2 className="card-title" style={{ margin: 0 }}>
            <Icon name="plan" size={13} /> Recipes
          </h2>
          <button className="btn btn-sm btn-primary" onClick={() => setEditor({ ...BLANK })}>
            <Icon name="plus" size={12} /> New
          </button>
        </div>
        <div className="field-hint">
          Recipes are reusable game-plans the agent follows for a kind of task — they make a small model far
          more reliable. Built-in ones are read-only; you can add or edit your own.
        </div>
        {recipes.length > 0 && (
          <select className="recipe-select" value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                [{ORIGIN_LABEL[r.origin]}] {r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {selected && (
        <div className="card setting-group">
          <div className="row-between">
            <span className="field-label">{selected.name}</span>
            <span className={`model-chip ${selected.origin === 'user' && selected.trusted === false ? 'off' : 'on'}`}>
              {ORIGIN_LABEL[selected.origin]}
              {selected.origin === 'user' ? (selected.trusted ? ' · proven' : ' · unproven') : ''}
            </span>
          </div>
          <div className="field-hint">When: {selected.whenToUse}{selected.site && selected.site !== '*' ? ` · on ${selected.site}` : ''}</div>
          <pre className="recipe-preview">{selected.preview}</pre>
          {selected.origin === 'user' ? (
            <div className="recipe-actions">
              <button
                className="btn btn-sm"
                onClick={() =>
                  setEditor({ id: selected.id, name: selected.name, whenToUse: selected.whenToUse, site: selected.site, stepsText: stepsToText(selected) })
                }
              >
                <Icon name="gear" size={12} /> Edit
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => onDelete(selected.id)}>
                <Icon name="x" size={12} /> Delete
              </button>
            </div>
          ) : selected.origin === 'auto' ? (
            <>
              <div className="field-hint">Learned automatically from a clean run — delete it to make the agent re-derive (or rebuild it).</div>
              <div className="recipe-actions">
                <button className="btn btn-sm btn-danger" onClick={() => onDelete(selected.id)}>
                  <Icon name="x" size={12} /> Delete
                </button>
              </div>
            </>
          ) : (
            <div className="field-hint">Built-in recipe (read-only). Use “New” to make your own version.</div>
          )}
        </div>
      )}
    </div>
  );
}
