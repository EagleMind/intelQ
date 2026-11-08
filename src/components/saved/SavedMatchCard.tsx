import React from 'react';
import { BookmarkCheck, Play, Sparkles } from 'lucide-react';
import type { SavedQuestion } from '../../types/api';
import type { QuestionMatch } from '../../utils/questionMatch';
import { usageLine } from './format';

interface Props {
  matches: QuestionMatch[];
  aiReady: boolean;
  busy: boolean;
  onRun: (q: SavedQuestion) => void;
  onAskAi: () => void;
  onDismiss: () => void;
}

/**
 * "You've asked this before" — shown instead of calling the AI when a typed
 * question matches a saved one. Nothing runs until the user picks.
 */
const SavedMatchCard: React.FC<Props> = ({ matches, aiReady, busy, onRun, onAskAi, onDismiss }) => {
  if (matches.length === 0) return null;
  const [best, ...others] = matches;
  const hasSql = best.question.sql.trim().length > 0;

  return (
    <div className="mb-5 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <BookmarkCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-muted-foreground">You've asked this before</div>
          <div className="text-foreground font-medium break-words">{best.question.question}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {hasSql
              ? `${usageLine(best.question)} · same SQL, same numbers, no AI call`
              : 'Saved without SQL yet: the AI will draft it from this question'}
          </div>

          <div className="flex gap-2 mt-3 flex-wrap">
            <button className="btn btn-primary btn-sm" onClick={() => onRun(best.question)} disabled={busy}>
              <Play className="w-4 h-4 mr-1" />
              {hasSql ? 'Run saved' : 'Use this question'}
            </button>
            {aiReady && hasSql && (
              <button className="btn btn-secondary btn-sm" onClick={onAskAi} disabled={busy}>
                <Sparkles className="w-4 h-4 mr-1" />
                Ask AI anyway
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={onDismiss}>
              Dismiss
            </button>
          </div>

          {others.length > 0 && (
            <div className="mt-3 pt-3 border-t border-primary/20">
              <div className="text-xs text-muted-foreground mb-1">Also close:</div>
              <ul className="space-y-1">
                {others.map(m => (
                  <li key={m.question.id}>
                    <button
                      className="text-sm text-primary hover:underline text-left break-words"
                      onClick={() => onRun(m.question)}
                      disabled={busy}
                    >
                      {m.question.question}
                    </button>
                    <span className="text-xs text-muted-foreground ml-2">{usageLine(m.question)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SavedMatchCard;
