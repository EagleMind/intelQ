import React from 'react';
import { Code2, Info, Settings } from 'lucide-react';
import type { RefusalReason } from '../services/llm';
import type { SavedQuestion } from '../types/api';
import type { QuestionMatch } from '../utils/questionMatch';

/** Plain-language explanation plus something to try next, per refusal reason. */
const REFUSAL_HELP: Record<RefusalReason, { title: string; tip: string }> = {
  greeting: {
    title: 'Hi! Ask a question about your data to get started.',
    tip: "For example: 'How many orders were placed last week?'",
  },
  off_topic: {
    title: "That doesn't look like a question about this database.",
    tip: 'Ask about tables, columns or the data in them. Type @ to pick a table.',
  },
  prompt_injection: {
    title: "That request can't be turned into a query.",
    tip: 'Describe the data you want to see, in your own words.',
  },
  abusive: {
    title: "That request can't be turned into a query.",
    tip: 'Describe the data you want to see, in your own words.',
  },
  out_of_schema: {
    title: "The AI couldn't find that data in this database.",
    tip: 'Check the table list on the left, then tag the right one with @table.',
  },
  ambiguous: {
    title: 'The question can be read more than one way.',
    tip: "Name the table with @table, or add a time range like 'last week'.",
  },
  non_sql_task: {
    title: 'That task needs more than a database query.',
    tip: 'Ask for the data itself — e.g. a list, a count or a total.',
  },
  malformed: {
    title: "The AI's answer wasn't usable SQL.",
    tip: 'Try again, or rephrase with a table name (@table).',
  },
};

export type HelpKind = RefusalReason | 'no_ai';

interface Props {
  kind: HelpKind;
  near: QuestionMatch[];
  onRunSaved: (q: SavedQuestion) => void;
  onWriteSql: () => void;
  onConfigureAi: () => void;
  onDismiss: () => void;
}

/**
 * Shown when the AI refuses or isn't set up — never a dead end: offers close
 * saved questions, a hint, and the hand-written SQL fallback.
 */
const HelpCard: React.FC<Props> = ({ kind, near, onRunSaved, onWriteSql, onConfigureAi, onDismiss }) => {
  const help =
    kind === 'no_ai'
      ? {
          title: 'No saved question matches, and no AI provider is set up.',
          tip: 'Pick from your saved questions, write SQL yourself, or set up AI.',
        }
      : REFUSAL_HELP[kind];

  return (
    <div className="mb-5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <Info className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-foreground font-medium">{help.title}</div>
          <div className="text-sm text-muted-foreground mt-0.5">{help.tip}</div>

          {near.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-muted-foreground mb-1">Did you mean one of your saved questions?</div>
              <ul className="space-y-1">
                {near.map(m => (
                  <li key={m.question.id}>
                    <button
                      className="text-sm text-primary hover:underline text-left break-words"
                      onClick={() => onRunSaved(m.question)}
                    >
                      {m.question.question}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 mt-3 flex-wrap">
            <button className="btn btn-secondary btn-sm" onClick={onWriteSql}>
              <Code2 className="w-4 h-4 mr-1" />
              Write SQL instead
            </button>
            {kind === 'no_ai' && (
              <button className="btn btn-warning btn-sm" onClick={onConfigureAi}>
                <Settings className="w-4 h-4 mr-1" />
                Set up AI
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HelpCard;
