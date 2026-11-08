import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { savedQuestionsApi } from '../services/savedQuestions';
import { useDb } from './DbContext';
import type { QuestionStats, SavedQuestion, SavedQuestionSource } from '../types/api';
import { findMatches as matchQuestions, STRONG_MATCH, type QuestionMatch } from '../utils/questionMatch';

// ---------------------------------------------------------------------------
// Saved questions for the active connection. An AI answer is a draft; once
// saved it re-runs the same SQL with no AI call.
// ---------------------------------------------------------------------------

export interface SaveQuestionArgs {
  /** Pass to update an existing saved question. */
  id?: string;
  question: string;
  sql: string;
  source: SavedQuestionSource;
}

interface SavedQuestionsContextValue {
  questions: SavedQuestion[];
  /** False when there is no connection id to scope questions to. */
  available: boolean;
  save: (args: SaveQuestionArgs) => Promise<SavedQuestion>;
  remove: (id: string) => Promise<void>;
  rename: (q: SavedQuestion, name: string) => Promise<SavedQuestion>;
  /** Record a successful run; `alias` is the phrasing that led to it, if different. */
  recordRun: (id: string, alias?: string) => Promise<void>;
  /** Count one new AI draft toward the reuse metric. */
  logAiDraft: () => void;
  stats: (days: number) => Promise<QuestionStats | null>;
  findMatches: (text: string, minScore?: number) => QuestionMatch[];
  getById: (id: string) => SavedQuestion | undefined;
}

const Ctx = createContext<SavedQuestionsContextValue | null>(null);

export const SavedQuestionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status } = useDb();
  const connectionId = status.connectionId;

  const [questions, setQuestions] = useState<SavedQuestion[]>([]);
  const loadedForRef = useRef<string | undefined>(undefined);

  const load = useCallback(async (connId: string) => {
    try {
      const list = await savedQuestionsApi.list(connId);
      setQuestions(list);
      loadedForRef.current = connId;
    } catch (e) {
      console.warn('Failed to load saved questions', e);
    }
  }, []);

  useEffect(() => {
    if (connectionId && connectionId !== loadedForRef.current) {
      load(connectionId);
    } else if (!connectionId) {
      setQuestions([]);
      loadedForRef.current = undefined;
    }
  }, [connectionId, load]);

  const upsertLocal = useCallback((q: SavedQuestion) => {
    setQuestions(prev => [q, ...prev.filter(p => p.id !== q.id)]);
  }, []);

  const save = useCallback(
    async ({ id, question, sql, source }: SaveQuestionArgs) => {
      if (!connectionId) throw new Error('Saved questions need a saved connection');
      const saved = await savedQuestionsApi.save({
        id: id ?? null,
        connection_id: connectionId,
        question,
        sql,
        source,
        aliases: null,
      });
      upsertLocal(saved);
      return saved;
    },
    [connectionId, upsertLocal]
  );

  const rename = useCallback(
    async (q: SavedQuestion, name: string) => {
      const saved = await savedQuestionsApi.save({
        id: q.id,
        connection_id: q.connection_id,
        question: name,
        sql: q.sql,
        source: q.source,
        // Keep the old name findable as a phrasing.
        aliases: [...q.aliases, q.question],
      });
      setQuestions(prev => prev.map(p => (p.id === saved.id ? saved : p)));
      return saved;
    },
    []
  );

  const remove = useCallback(async (id: string) => {
    await savedQuestionsApi.delete(id);
    setQuestions(prev => prev.filter(p => p.id !== id));
  }, []);

  const recordRun = useCallback(
    async (id: string, alias?: string) => {
      try {
        const updated = await savedQuestionsApi.recordRun(id, alias);
        upsertLocal(updated);
      } catch (e) {
        console.warn('Failed to record saved-question run', e);
      }
    },
    [upsertLocal]
  );

  const logAiDraft = useCallback(() => {
    if (!connectionId) return;
    savedQuestionsApi.logEvent(connectionId, 'ai_draft').catch(e => {
      console.warn('Failed to log AI draft', e);
    });
  }, [connectionId]);

  const stats = useCallback(
    async (days: number) => {
      if (!connectionId) return null;
      try {
        return await savedQuestionsApi.stats(connectionId, days);
      } catch {
        return null;
      }
    },
    [connectionId]
  );

  const findMatches = useCallback(
    (text: string, minScore = STRONG_MATCH) => matchQuestions(text, questions, minScore),
    [questions]
  );

  const getById = useCallback((id: string) => questions.find(q => q.id === id), [questions]);

  const value = useMemo<SavedQuestionsContextValue>(
    () => ({
      questions,
      available: !!connectionId,
      save,
      remove,
      rename,
      recordRun,
      logAiDraft,
      stats,
      findMatches,
      getById,
    }),
    [questions, connectionId, save, remove, rename, recordRun, logAiDraft, stats, findMatches, getById]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useSavedQuestions = (): SavedQuestionsContextValue => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSavedQuestions must be used inside <SavedQuestionsProvider>');
  return ctx;
};
