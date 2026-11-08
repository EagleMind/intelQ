import React, { useEffect, useMemo, useState } from 'react';
import { BookmarkCheck, FolderOpen, Pencil, Play, Search, Trash2 } from 'lucide-react';
import { useSavedQuestions } from '../../store/SavedQuestionsContext';
import { filterQuestions } from '../../utils/questionMatch';
import type { QuestionStats, SavedQuestion } from '../../types/api';
import { SOURCE_LABEL, usageLine } from './format';

const STATS_DAYS = 30;

interface Props {
  onClose: () => void;
  /** Run through the NLQ guarded execute path (safety analyzer + read-only lock). */
  onRun: (q: SavedQuestion) => void;
  /** Load the SQL into the editor without running it. */
  onOpen: (q: SavedQuestion) => void;
}

const SavedQuestionsPanel: React.FC<Props> = ({ onClose, onRun, onOpen }) => {
  const { questions, available, rename, remove, stats } = useSavedQuestions();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [usage, setUsage] = useState<QuestionStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    stats(STATS_DAYS).then(s => {
      if (!cancelled) setUsage(s);
    });
    return () => {
      cancelled = true;
    };
  }, [stats, questions]);

  const visible = useMemo(() => filterQuestions(query, questions), [query, questions]);

  const commitRename = async () => {
    if (!renaming) return;
    const q = questions.find(x => x.id === renaming.id);
    const name = renaming.name.trim();
    if (!q || !name || name === q.question) {
      setRenaming(null);
      return;
    }
    try {
      await rename(q, name);
      setRenaming(null);
      setError(null);
    } catch (e) {
      setError(`Rename failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doDelete = async (id: string) => {
    try {
      await remove(id);
      setConfirmDelete(null);
      setError(null);
    } catch (e) {
      setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="flex items-center gap-2">
            <BookmarkCheck className="w-5 h-5 text-primary" />
            Saved questions
          </h3>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {usage && (usage.saved_runs > 0 || usage.ai_drafts > 0) && (
            <div className="mb-4 text-sm text-muted-foreground">
              Last {STATS_DAYS} days:{' '}
              <span className="text-foreground font-medium">
                {usage.saved_runs} {usage.saved_runs === 1 ? 'answer' : 'answers'} from saved questions
              </span>{' '}
              · {usage.ai_drafts} new AI {usage.ai_drafts === 1 ? 'draft' : 'drafts'}
            </div>
          )}

          {!available ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              Connect through a saved connection to keep questions for it.
            </div>
          ) : questions.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              Questions you save show up here. Once they have SQL, they run without AI.
              <div className="text-xs mt-1">
                Type a question (or write SQL), then press <span className="text-foreground">Save question</span>.
              </div>
            </div>
          ) : (
            <>
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="w-full bg-surface-inset border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-primary"
                  placeholder="Search saved questions"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  autoFocus
                />
              </div>

              {error && <div className="mb-3 text-sm text-destructive">{error}</div>}

              {visible.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">
                  No saved question matches “{query}”.
                </div>
              ) : (
                <ul className="divide-y divide-border border border-border rounded-lg">
                  {visible.map(q => (
                    <li key={q.id} className="px-3 py-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        {renaming?.id === q.id ? (
                          <input
                            className="w-full bg-surface-inset border border-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-primary"
                            value={renaming.name}
                            onChange={e => setRenaming({ id: q.id, name: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenaming(null);
                            }}
                            onBlur={commitRename}
                            autoFocus
                          />
                        ) : (
                          <div className="text-sm text-foreground font-medium break-words">{q.question}</div>
                        )}
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {usageLine(q)}
                          {q.sql.trim() ? ` · ${SOURCE_LABEL[q.source]}` : ''}
                        </div>
                      </div>

                      {confirmDelete === q.id ? (
                        <div className="flex gap-2 shrink-0">
                          <button className="btn btn-danger btn-sm" onClick={() => doDelete(q.id)}>
                            Delete
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1 shrink-0">
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => onRun(q)}
                            title="Run this saved SQL"
                          >
                            <Play className="w-4 h-4" />
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => onOpen(q)}
                            title="Open the question and its SQL without running it"
                          >
                            <FolderOpen className="w-4 h-4" />
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setRenaming({ id: q.id, name: q.question })}
                            title="Rename"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmDelete(q.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SavedQuestionsPanel;
