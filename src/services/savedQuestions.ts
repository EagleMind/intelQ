import { safeInvoke } from '../utils/tauri';
import type {
  QuestionEventKind,
  QuestionStats,
  SavedQuestion,
  SavedQuestionInput,
} from '../types/api';

export const savedQuestionsApi = {
  list: (connectionId: string) =>
    safeInvoke<SavedQuestion[]>('saved_question_list', { connectionId }),

  save: (input: SavedQuestionInput) =>
    safeInvoke<SavedQuestion>('saved_question_save', { input }),

  delete: (id: string) => safeInvoke<void>('saved_question_delete', { id }),

  /** Bump the run count; `alias` records the phrasing that led here. */
  recordRun: (id: string, alias?: string | null) =>
    safeInvoke<SavedQuestion>('saved_question_record_run', { id, alias: alias ?? null }),

  logEvent: (connectionId: string, kind: QuestionEventKind) =>
    safeInvoke<void>('question_event_log', { connectionId, kind }),

  stats: (connectionId: string, days: number) =>
    safeInvoke<QuestionStats>('question_stats', { connectionId, days }),
};
