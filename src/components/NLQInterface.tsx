import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare,
  Play,
  Copy,
  Download,
  RefreshCw,
  Zap,
  Turtle,
  Settings,
  Lock,
  Unlock,
  ShieldAlert,
  Sparkles,
  BookmarkCheck,
  BookmarkPlus,
  Code2,
} from 'lucide-react';
import { api } from '../services/api';
import { generateSql, parseTableTags, NotSqlRequestError } from '../services/llm';
import { useDb } from '../store/DbContext';
import { useAiSettings } from '../store/AiSettingsContext';
import { useSavedQuestions } from '../store/SavedQuestionsContext';
import AiProviderForm from './AiProviderForm';
import SavedMatchCard from './saved/SavedMatchCard';
import SavedQuestionsPanel from './saved/SavedQuestionsPanel';
import HelpCard, { type HelpKind } from './HelpCard';
import { SQLSafetyAnalyzer } from '../utils/sqlSafetyAnalyzer';
import { NEAR_MATCH, type QuestionMatch } from '../utils/questionMatch';
import type { QueryResult, Row, SavedQuestion, SavedQuestionSource, TableColumn } from '../types/api';
import '../index.css';

const PAGE_SIZE = 100;

interface PerformanceMetrics {
  approach: 'strategic' | 'traditional';
  tablesUsed: string[] | 'all';
  estimatedTokens: number;
  generationMs: number;
  provider: string;
}

/**
 * Where the SQL in the editor came from. An AI answer is a *draft*: it is
 * always editable, and Save turns it into a saved question that re-runs
 * without AI.
 */
type DraftOrigin = 'ai' | 'edited' | 'manual' | 'saved';

/** The main input: a question in plain English, or SQL typed by hand. */
type InputMode = 'ask' | 'sql';

/** Context carried through a guarded run so a saved question's usage is recorded. */
interface RunOpts {
  savedId?: string;
  /** The phrasing that led to this saved question, if it differs. */
  alias?: string;
}

const csvEscape = (v: string) =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const cellText = (v: string | null) => (v === null ? 'NULL' : v);

const formatMs = (ms: number): string => {
  if (ms < 1) return '< 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const isSubmitKey = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

const NLQInterface: React.FC = () => {
  const {
    status,
    tables: availableTables,
    schema,
    refreshSchema,
    readOnlyLock,
    setReadOnlyLock,
    setStatusMessage,
    setLoading,
  } = useDb();
  const dbConnected = status.connected;

  const saved = useSavedQuestions();

  const [inputMode, setInputMode] = useState<InputMode>('ask');
  const [naturalQuery, setNaturalQuery] = useState('');
  const [sqlDraft, setSqlDraft] = useState('');
  const [draftOrigin, setDraftOrigin] = useState<DraftOrigin | null>(null);
  /** The saved question being worked on (kept while its SQL is edited or drafted). */
  const [loadedSavedId, setLoadedSavedId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [matchOffer, setMatchOffer] = useState<{ text: string; matches: QuestionMatch[] } | null>(null);
  const [help, setHelp] = useState<{ kind: HelpKind; text: string; near: QuestionMatch[] } | null>(null);
  const [showSaved, setShowSaved] = useState(false);

  const [queryColumns, setQueryColumns] = useState<TableColumn[]>([]);
  const [queryRows, setQueryRows] = useState<Row[]>([]);
  const [queryMeta, setQueryMeta] = useState<{
    success: boolean;
    message?: string;
    rowCount: number;
    executionMs: number;
  } | null>(null);
  const [page, setPage] = useState(0);

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const { config, aiReady } = useAiSettings();

  const [isGenerating, setIsGenerating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState<{
    warnings: string[];
    sql: string;
    opts?: RunOpts;
  } | null>(null);

  const loadedSaved = loadedSavedId ? saved.getById(loadedSavedId) : undefined;

  // The saved question being worked on was deleted (or the connection
  // changed): keep the text and SQL, but treat them as unsaved again.
  useEffect(() => {
    if (loadedSavedId && !loadedSaved) {
      setLoadedSavedId(null);
      setDraftOrigin(o => (o === 'saved' ? 'edited' : o));
    }
  }, [loadedSavedId, loadedSaved]);

  const toggleLock = () => {
    const next = !readOnlyLock;
    setReadOnlyLock(next);
    setStatusMessage(
      next
        ? 'Read-only mode enabled — write queries will be blocked'
        : 'Read-only mode disabled — full access'
    );
  };

  const clearCards = () => {
    setMatchOffer(null);
    setHelp(null);
  };

  /** Put SQL in the editor. */
  const loadDraft = (sql: string, origin: DraftOrigin, savedId: string | null = null) => {
    setSqlDraft(sql);
    setDraftOrigin(origin);
    setLoadedSavedId(savedId);
    setSaveName(null);
    if (origin !== 'ai') setPerformanceMetrics(null);
  };

  const clearDraft = () => {
    setSqlDraft('');
    setDraftOrigin(inputMode === 'sql' ? 'manual' : null);
    setLoadedSavedId(null);
    setSaveName(null);
    setPerformanceMetrics(null);
  };

  /** Flip the main input between "ask in English" and "write SQL". Both keep their text. */
  const switchMode = (mode: InputMode) => {
    clearCards();
    setSaveName(null);
    setShowSuggestions(false);
    if (mode === 'sql' && draftOrigin === null) setDraftOrigin('manual');
    if (mode === 'ask' && draftOrigin === 'manual' && !sqlDraft.trim()) setDraftOrigin(null);
    setInputMode(mode);
  };

  // ---------------------------------------------------------------------------
  // Ask: saved questions first, the AI only when nothing matches.
  // ---------------------------------------------------------------------------

  const generateWithAi = async (text: string, keepSavedId: string | null = null) => {
    const taggedTables = parseTableTags(text);

    setIsGenerating(true);
    setLoading(true);
    const t0 = performance.now();
    try {
      // Server-side schema filtering: when @tags are present, only the relevant
      // tables are rendered into the prompt. Cuts token usage on large DBs.
      const promptSchema = taggedTables.length > 0
        ? await api.getFilteredSchema(taggedTables)
        : schema;

      const sql = await generateSql({
        naturalQuery: text,
        schema: promptSchema,
        taggedTables,
        config,
      });
      const generationMs = performance.now() - t0;
      loadDraft(sql, 'ai', keepSavedId);
      saved.logAiDraft();

      const approach: 'strategic' | 'traditional' =
        taggedTables.length > 0 ? 'strategic' : 'traditional';
      setPerformanceMetrics({
        approach,
        tablesUsed: taggedTables.length > 0 ? taggedTables : 'all',
        estimatedTokens: taggedTables.length > 0 ? 1500 : 3000,
        generationMs,
        provider:
          config.provider === 'lmstudio' ? 'LM Studio'
          : config.provider === 'claude' ? 'Claude Code'
          : 'OpenRouter',
      });
      setStatusMessage(`SQL draft ready in ${formatMs(generationMs)} — edit it, run it, or save it`);
    } catch (e) {
      if (e instanceof NotSqlRequestError) {
        setHelp({ kind: e.reason, text, near: saved.findMatches(text, NEAR_MATCH).slice(0, 3) });
        setStatusMessage(`Not a SQL request (${e.reason})`);
      } else {
        setStatusMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setIsGenerating(false);
      setLoading(false);
    }
  };

  const handleAsk = async (opts: { skipSaved?: boolean } = {}) => {
    const text = naturalQuery.trim();
    if (!text) {
      setStatusMessage('Enter a question first');
      return;
    }
    clearCards();

    if (!opts.skipSaved) {
      const matches = saved.findMatches(text);
      if (matches.length > 0) {
        setMatchOffer({ text, matches: matches.slice(0, 3) });
        setStatusMessage('Found a saved question that answers this');
        return;
      }
    }

    if (!aiReady) {
      setHelp({ kind: 'no_ai', text, near: saved.findMatches(text, NEAR_MATCH).slice(0, 3) });
      setStatusMessage('No saved question matches and no AI provider is set up');
      return;
    }

    await generateWithAi(text);
  };

  // ---------------------------------------------------------------------------
  // Run: every path (AI draft, edited draft, your SQL, saved question) goes
  // through executeGuarded so the safety analyzer + read-only lock always run.
  // ---------------------------------------------------------------------------

  const runQuery = async (sql: string): Promise<boolean> => {
    setIsExecuting(true);
    setLoading(true);
    setPage(0);
    const t0 = performance.now();
    try {
      const raw: QueryResult = await api.execute(sql.trim());
      const executionMs = performance.now() - t0;
      const cols = raw.columns ?? [];
      const rows = raw.rows ?? [];
      setQueryColumns(cols);
      setQueryRows(rows);
      setQueryMeta({
        success: raw.success,
        message: raw.message,
        rowCount: raw.row_count ?? rows.length,
        executionMs,
      });
      setStatusMessage(
        raw.success
          ? `Query executed in ${formatMs(executionMs)} (${raw.row_count ?? rows.length} rows)`
          : raw.message ?? 'Query failed'
      );
      return raw.success;
    } catch (e) {
      const executionMs = performance.now() - t0;
      setQueryColumns([]);
      setQueryRows([]);
      setQueryMeta({ success: false, message: String(e), rowCount: 0, executionMs });
      setStatusMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setIsExecuting(false);
      setLoading(false);
    }
  };

  const runAndRecord = async (sql: string, opts?: RunOpts) => {
    const ok = await runQuery(sql);
    if (ok && opts?.savedId) await saved.recordRun(opts.savedId, opts.alias);
  };

  const executeGuarded = (sql: string, opts?: RunOpts) => {
    if (!dbConnected || !sql.trim()) {
      setStatusMessage('Connect to a database and write or generate SQL first');
      return;
    }
    const analysis = SQLSafetyAnalyzer.analyzeQuery(sql);
    if (readOnlyLock && !analysis.isReadOnly) {
      setPendingDestructive({ warnings: analysis.warnings, sql, opts });
      return;
    }
    void runAndRecord(sql, opts);
  };

  const handleExecute = () => {
    const opts: RunOpts | undefined =
      draftOrigin === 'saved' && loadedSavedId ? { savedId: loadedSavedId } : undefined;
    executeGuarded(sqlDraft, opts);
  };

  /** Run a saved question. One saved without SQL yet goes to the AI with its question. */
  const runSaved = (q: SavedQuestion, phrasing?: string) => {
    clearCards();
    setShowSaved(false);
    if (!phrasing) setNaturalQuery(q.question);

    if (!q.sql.trim()) {
      setNaturalQuery(q.question);
      setInputMode('ask');
      setLoadedSavedId(q.id);
      if (!aiReady) {
        setHelp({ kind: 'no_ai', text: q.question, near: [] });
        return;
      }
      void generateWithAi(q.question, q.id);
      return;
    }

    loadDraft(q.sql, 'saved', q.id);
    const alias = phrasing && !sameText(phrasing, q.question) ? phrasing : undefined;
    executeGuarded(q.sql, { savedId: q.id, alias });
  };

  /** Open a saved question (its question and its SQL) without running it. */
  const openSaved = (q: SavedQuestion) => {
    setShowSaved(false);
    clearCards();
    setNaturalQuery(q.question);
    if (q.sql.trim()) {
      loadDraft(q.sql, 'saved', q.id);
    } else {
      loadDraft('', inputMode === 'sql' ? 'manual' : 'saved', q.id);
      if (inputMode === 'ask') setDraftOrigin(null);
    }
    setStatusMessage(`Opened saved question “${q.question}”`);
  };

  const handleSqlChange = (value: string) => {
    setSqlDraft(value);
    if (draftOrigin === 'ai' || draftOrigin === 'saved') setDraftOrigin('edited');
    else if (draftOrigin === null) setDraftOrigin('manual');
  };

  // ---------------------------------------------------------------------------
  // Save: the question, plus its SQL when there is any.
  // ---------------------------------------------------------------------------

  const hasSql = sqlDraft.trim().length > 0;
  const hasQuestion = naturalQuery.trim().length > 0;
  /** Something to save that differs from what is already saved. */
  const isDirty = loadedSaved
    ? sqlDraft.trim() !== loadedSaved.sql.trim()
    : hasSql || hasQuestion;
  const canSave = saved.available && isDirty && (hasSql || hasQuestion);

  const sourceFor = (target?: SavedQuestion): SavedQuestionSource => {
    switch (draftOrigin) {
      case 'ai':
        return 'ai';
      case 'edited':
        return 'edited';
      case 'manual':
        return 'manual';
      default:
        return target?.source ?? 'ai';
    }
  };

  const startSave = () => {
    setSaveName(loadedSaved?.question ?? naturalQuery.trim());
  };

  const commitSave = async (mode: 'new' | 'update') => {
    const name = (saveName ?? '').trim();
    if (!name) {
      setStatusMessage('Give the question a name first');
      return;
    }
    setIsSaving(true);
    try {
      const target = mode === 'update' ? loadedSaved : undefined;
      const result = await saved.save({
        id: target?.id,
        question: name,
        sql: sqlDraft.trim(),
        source: sourceFor(target),
      });
      setLoadedSavedId(result.id);
      if (result.sql) setDraftOrigin('saved');
      setSaveName(null);
      setStatusMessage(
        !result.sql
          ? `Saved “${result.question}” — it gets its SQL the first time it's answered`
          : target
            ? `Updated saved question “${result.question}”`
            : `Saved “${result.question}” — it now runs without AI`
      );
    } catch (e) {
      setStatusMessage(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Suggestions for @table tags
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const position = e.target.selectionStart;
    setNaturalQuery(value);

    const beforeCursor = value.substring(0, position);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex === -1) {
      setShowSuggestions(false);
      return;
    }
    const afterAt = beforeCursor.substring(atIndex + 1);
    if (afterAt.includes(' ') || afterAt.length === 0) {
      setShowSuggestions(false);
      return;
    }
    const filter = afterAt.toLowerCase();
    const matches = availableTables.filter(t => t.toLowerCase().includes(filter));
    if (matches.length > 0) {
      setFilteredSuggestions(matches);
      setActiveSuggestion(0);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSuggestionSelect = (table: string) => {
    const atIndex = naturalQuery.lastIndexOf('@');
    if (atIndex === -1) return;
    const beforeAt = naturalQuery.substring(0, atIndex);
    const afterAt = naturalQuery.substring(atIndex).split(' ').slice(1).join(' ');
    setNaturalQuery(`${beforeAt}@${table} ${afterAt}`);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions) {
      if (isSubmitKey(e) && canAsk) {
        e.preventDefault();
        void handleAsk();
      }
      return;
    }
    if (e.key === 'Escape') {
      setShowSuggestions(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestion(i => (i + 1) % filteredSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestion(i => (i - 1 + filteredSuggestions.length) % filteredSuggestions.length);
    } else if (e.key === 'Enter' && !e.shiftKey && filteredSuggestions.length > 0) {
      e.preventDefault();
      handleSuggestionSelect(filteredSuggestions[activeSuggestion]);
    }
  };

  const copySQL = () => {
    if (!sqlDraft) return;
    navigator.clipboard.writeText(sqlDraft);
    setStatusMessage('SQL copied to clipboard');
  };

  const exportResults = () => {
    if (queryRows.length === 0) return;
    const csv = [
      queryColumns.map(c => csvEscape(c.name)).join(','),
      ...queryRows.map(row => row.map(c => csvEscape(cellText(c))).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query_results.csv';
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage('Results exported');
  };

  const clearResults = () => {
    setQueryRows([]);
    setQueryColumns([]);
    setQueryMeta(null);
    clearDraft();
  };

  // Paginate the rendered rows so huge result sets don't freeze the UI.
  const totalPages = Math.max(1, Math.ceil(queryRows.length / PAGE_SIZE));
  const visibleRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return queryRows.slice(start, start + PAGE_SIZE);
  }, [queryRows, page]);

  const canAsk = dbConnected && hasQuestion && !isGenerating;
  const canExecute = dbConnected && hasSql && !isExecuting;

  const draftLabel = (() => {
    switch (draftOrigin) {
      case 'ai':
        return loadedSaved ? `SQL drafted by AI for “${loadedSaved.question}”` : 'SQL drafted by AI — edit it if needed';
      case 'edited':
        return loadedSaved ? `Edited SQL for “${loadedSaved.question}”` : 'Edited SQL';
      case 'saved':
        return loadedSaved ? `Saved question: ${loadedSaved.question}` : 'Saved question';
      default:
        return loadedSaved ? `SQL for “${loadedSaved.question}”` : 'Your SQL';
    }
  })();

  // ---------------------------------------------------------------------------
  // Render pieces
  // ---------------------------------------------------------------------------

  const saveButton = canSave && saveName === null && (
    <button
      className="btn btn-secondary"
      onClick={startSave}
      title={hasSql ? 'Keep this question and its SQL — next time it runs without AI' : 'Keep this question for later'}
    >
      <BookmarkPlus className="w-4 h-4 mr-2" />
      {loadedSaved ? 'Save changes' : 'Save question'}
    </button>
  );

  const saveForm = saveName !== null && (
    <div className="mt-3 pt-3 border-t border-border">
      <label className="text-xs text-muted-foreground block mb-1">
        Name this question (how you'd ask it){hasSql ? ' — its SQL is saved with it' : ''}
      </label>
      <input
        className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
        value={saveName}
        onChange={e => setSaveName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commitSave(loadedSaved ? 'update' : 'new');
          if (e.key === 'Escape') setSaveName(null);
        }}
        placeholder="e.g., Weekly German orders"
        autoFocus
      />
      <div className="flex gap-2 mt-2 flex-wrap">
        {loadedSaved ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => commitSave('update')} disabled={isSaving}>
              Update saved
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => commitSave('new')} disabled={isSaving}>
              Save as new
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => commitSave('new')} disabled={isSaving}>
            Save
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => setSaveName(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const modeSwitch = (
    <button
      className="text-xs text-muted-foreground hover:text-foreground hover:underline inline-flex items-center gap-1 disabled:opacity-50"
      onClick={() => switchMode(inputMode === 'ask' ? 'sql' : 'ask')}
      disabled={!dbConnected}
      title={inputMode === 'ask' ? 'Advanced: type SQL yourself' : 'Go back to asking in plain English'}
    >
      {inputMode === 'ask' ? <Code2 className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
      {inputMode === 'ask' ? 'Write SQL instead' : 'Ask in plain English instead'}
    </button>
  );

  /** The SQL editor — always editable. Main input in SQL mode, the draft below the question in ask mode. */
  const sqlEditor = (
    <div className="bg-surface-inset border border-border rounded-lg p-3">
      <textarea
        className="w-full bg-transparent text-sm text-foreground font-mono resize-y focus:outline-none min-h-[7rem] placeholder:text-muted-foreground/70"
        value={sqlDraft}
        onChange={e => handleSqlChange(e.target.value)}
        onKeyDown={e => {
          if (isSubmitKey(e) && canExecute) {
            e.preventDefault();
            handleExecute();
          }
        }}
        placeholder="SELECT ..."
        spellCheck={false}
        disabled={!dbConnected}
        autoFocus={inputMode === 'sql'}
      />
      {draftOrigin === 'ai' && performanceMetrics && (
        <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <span className="text-muted-foreground">Approach:</span>{' '}
            {performanceMetrics.approach}
          </div>
          <div>
            <span className="text-muted-foreground">Tables:</span>{' '}
            {Array.isArray(performanceMetrics.tablesUsed)
              ? performanceMetrics.tablesUsed.join(', ')
              : performanceMetrics.tablesUsed}
          </div>
          <div>
            <span className="text-muted-foreground">Tokens (est):</span>{' '}
            {performanceMetrics.estimatedTokens.toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">Provider:</span>{' '}
            {performanceMetrics.provider}
          </div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">Generated in:</span>{' '}
            <span className="text-foreground font-medium">
              {formatMs(performanceMetrics.generationMs)}
            </span>
          </div>
        </div>
      )}
      <div className="flex gap-2 mt-3 flex-wrap items-center">
        <button className="btn btn-success" onClick={handleExecute} disabled={!canExecute} title="Ctrl+Enter">
          <Play className="w-4 h-4 mr-2" />
          {isExecuting ? 'Running...' : 'Run'}
        </button>
        {saveButton}
        <button className="btn btn-secondary" onClick={copySQL} disabled={!hasSql}>
          <Copy className="w-4 h-4 mr-2" />
          Copy SQL
        </button>
        <button className="btn btn-secondary" onClick={clearDraft} disabled={!hasSql && inputMode === 'sql'}>
          Clear
        </button>
        {inputMode === 'sql' && <span className="ml-auto">{modeSwitch}</span>}
      </div>
      {saveForm}
      {!saved.available && (hasSql || hasQuestion) && (
        <div className="mt-2 text-xs text-muted-foreground">
          Connect through a saved connection to keep questions for later.
        </div>
      )}
    </div>
  );

  const showDraftBelow = inputMode === 'ask' && draftOrigin !== null;

  return (
    <div className="h-full flex flex-col bg-card rounded-lg border border-border">
      <div className="px-4 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="m-0 text-foreground text-base font-semibold">Ask your data</h3>
          <button
            className={`btn btn-sm flex items-center gap-2 ${readOnlyLock ? 'btn-success' : 'btn-secondary'}`}
            onClick={toggleLock}
            title={
              readOnlyLock
                ? 'Disable to allow writes (INSERT/UPDATE/DELETE/DDL).'
                : 'Enable to block any write/DDL.'
            }
          >
            {readOnlyLock ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            <span>{readOnlyLock ? 'Read-Only' : 'Full Access'}</span>
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn btn-secondary btn-sm flex items-center gap-2"
            onClick={() => setShowSaved(true)}
            disabled={!dbConnected}
            title="Questions you saved — the ones with SQL run without AI"
          >
            <BookmarkCheck className="w-4 h-4" />
            <span>Saved{saved.questions.length > 0 ? ` (${saved.questions.length})` : ''}</span>
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowSettings(true)}
            title="AI Provider Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={refreshSchema}
            disabled={!dbConnected}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh Schema
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 overflow-y-auto min-h-0">
        {dbConnected && !aiReady && inputMode === 'ask' && (
          <div className="mb-4 flex items-center gap-3 px-3 py-2 rounded-lg border border-warning/40 bg-warning/10 text-warning text-sm">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span className="flex-1">
              No AI provider configured yet — set one up to turn new questions into SQL.
              Saved questions and your own SQL still work.
            </span>
            <button className="btn btn-warning btn-sm" onClick={() => setShowSettings(true)}>
              Configure AI
            </button>
          </div>
        )}

        {inputMode === 'ask' ? (
          <div className="mb-5">
            <div className="text-sm font-semibold text-muted-foreground mb-2">
              Ask a question in plain English (type @ to pick a table)
            </div>
            <div className="relative">
              <textarea
                className="w-full bg-surface-inset border border-border rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground/70 resize-none focus:outline-none focus:border-primary"
                placeholder="e.g., 'Show me all users from @users created last week'"
                value={naturalQuery}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={!dbConnected}
                rows={4}
              />
              {showSuggestions && filteredSuggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg max-h-48 overflow-y-auto z-20 shadow-xl">
                  {filteredSuggestions.map((table, idx) => (
                    <div
                      key={table}
                      className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${idx === activeSuggestion ? 'bg-accent' : 'hover:bg-secondary'}`}
                      onMouseEnter={() => setActiveSuggestion(idx)}
                      onClick={() => handleSuggestionSelect(table)}
                    >
                      <MessageSquare size={14} className="text-primary" />
                      <span className="text-sm text-muted-foreground">{table}</span>
                      {idx === activeSuggestion && (
                        <span className="ml-auto text-xs text-muted-foreground">Press Enter</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <button
                className="btn btn-primary"
                onClick={() => handleAsk()}
                disabled={!canAsk}
                title="Checks your saved questions first, then asks the AI (Ctrl+Enter)"
              >
                {isGenerating ? 'Drafting SQL...' : 'Ask'}
              </button>
              {/* Before any SQL exists, Save sits here; afterwards it moves next to Run. */}
              {!showDraftBelow && saveButton}
              <span className="ml-auto">{modeSwitch}</span>
            </div>
            {!showDraftBelow && saveForm}
          </div>
        ) : (
          <div className="mb-5">
            <div className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
              {draftOrigin === 'saved' ? (
                <BookmarkCheck className="w-4 h-4 text-primary shrink-0" />
              ) : (
                <Code2 className="w-4 h-4 shrink-0" />
              )}
              <span className="truncate">{draftLabel}</span>
            </div>
            {sqlEditor}
          </div>
        )}

        {inputMode === 'ask' && matchOffer && (
          <SavedMatchCard
            matches={matchOffer.matches}
            aiReady={aiReady}
            busy={isExecuting || isGenerating}
            onRun={q => runSaved(q, matchOffer.text)}
            onAskAi={() => handleAsk({ skipSaved: true })}
            onDismiss={() => setMatchOffer(null)}
          />
        )}

        {inputMode === 'ask' && help && (
          <HelpCard
            kind={help.kind}
            near={help.near}
            onRunSaved={q => runSaved(q, help.text)}
            onWriteSql={() => switchMode('sql')}
            onConfigureAi={() => setShowSettings(true)}
            onDismiss={() => setHelp(null)}
          />
        )}

        {showDraftBelow && (
          <div className="mb-5">
            <div className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2 min-w-0">
              {draftOrigin === 'saved' ? (
                <BookmarkCheck className="w-4 h-4 text-primary shrink-0" />
              ) : draftOrigin === 'ai' ? (
                <Sparkles className="w-4 h-4 shrink-0" />
              ) : (
                <Code2 className="w-4 h-4 shrink-0" />
              )}
              <span className="truncate">{draftLabel}</span>
              {draftOrigin === 'ai' && performanceMetrics && (
                <span className="px-2 py-1 rounded-full text-xs font-medium">
                  {performanceMetrics.approach === 'strategic' ? (
                    <span className="text-success inline-flex items-center">
                      <Zap className="w-3 h-3 mr-1" />Filtered
                    </span>
                  ) : (
                    <span className="text-muted-foreground inline-flex items-center">
                      <Turtle className="w-3 h-3 mr-1" />Full schema
                    </span>
                  )}
                </span>
              )}
            </div>
            {sqlEditor}
          </div>
        )}

        {queryMeta && (
          <ResultsBlock
            success={queryMeta.success}
            message={queryMeta.message}
            rowCount={queryMeta.rowCount}
            executionMs={queryMeta.executionMs}
            columns={queryColumns}
            visibleRows={visibleRows}
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage(p => Math.max(0, p - 1))}
            onNext={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            onExport={exportResults}
            onClear={clearResults}
          />
        )}

        {!dbConnected && (
          <div className="text-center text-muted-foreground py-8">
            Connect to a database to start asking questions
          </div>
        )}
      </div>

      {showSaved && (
        <SavedQuestionsPanel
          onClose={() => setShowSaved(false)}
          onRun={q => runSaved(q)}
          onOpen={openSaved}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>AI Provider Settings</h3>
              <button className="modal-close" onClick={() => setShowSettings(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <AiProviderForm
                saveLabel="Save"
                onSaved={() => setShowSettings(false)}
                onCancel={() => setShowSettings(false)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Destructive query confirmation */}
      {pendingDestructive && (
        <div className="modal-overlay" onClick={() => setPendingDestructive(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-destructive" />
                Read-only mode blocked this query
              </h3>
              <button className="modal-close" onClick={() => setPendingDestructive(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="text-sm text-muted-foreground">
                This SQL appears to modify data or schema. You can disable
                read-only mode to run it.
              </p>
              <ul className="mt-3 text-sm text-muted-foreground list-disc pl-5 space-y-1">
                {pendingDestructive.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPendingDestructive(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setReadOnlyLock(false);
                  const { sql, opts } = pendingDestructive;
                  setPendingDestructive(null);
                  void runAndRecord(sql, opts);
                }}
              >
                Disable lock & run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ResultsBlockProps {
  success: boolean;
  message?: string;
  rowCount: number;
  executionMs: number;
  columns: TableColumn[];
  visibleRows: Row[];
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  onExport: () => void;
  onClear: () => void;
}

const ResultsBlock = React.memo<ResultsBlockProps>(
  ({
    success,
    message,
    rowCount,
    executionMs,
    columns,
    visibleRows,
    page,
    totalPages,
    onPrev,
    onNext,
    onExport,
    onClear,
  }) => {
    if (!success) {
      return (
        <div className="mb-5">
          <div className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
            <span>Query Results</span>
            <span className="text-xs text-muted-foreground">
              (failed after {formatMs(executionMs)})
            </span>
          </div>
          <div className="bg-destructive/10 border border-destructive rounded-lg px-4 py-4 text-destructive whitespace-pre-wrap break-words">
            {message ?? 'Query execution failed'}
          </div>
        </div>
      );
    }
    if (rowCount === 0 || columns.length === 0) {
      return (
        <div className="mb-5">
          <div className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
            <span>Query Results</span>
            <span className="text-xs text-muted-foreground">
              (no rows · {formatMs(executionMs)})
            </span>
          </div>
          <div className="bg-surface-inset border border-border rounded-lg px-4 py-6 text-center text-muted-foreground">
            {message ?? 'Query executed - no rows returned'}
          </div>
        </div>
      );
    }

    return (
      <div className="mb-5">
        <div className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
          <span>Query Results</span>
          <span className="text-xs text-muted-foreground">
            ({rowCount} rows · {formatMs(executionMs)} · page {page + 1} of {totalPages})
          </span>
        </div>
        <div className="bg-surface-inset border border-border rounded-lg overflow-hidden">
          <div className="overflow-auto max-h-[50vh]">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-card sticky top-0 z-10">
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.name}
                      className="px-3 py-2 text-left text-muted-foreground font-medium border-b border-border whitespace-nowrap"
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, idx) => (
                  <tr key={idx} className="border-t border-border hover:bg-accent">
                    {row.map((cell, cellIdx) => (
                      <td
                        key={cellIdx}
                        className={`px-3 py-2 max-w-xs overflow-hidden text-ellipsis whitespace-nowrap ${cell === null ? 'text-muted-foreground/60 italic' : 'text-muted-foreground'}`}
                        title={cellText(cell)}
                      >
                        {cellText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between p-3 border-t border-border flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <button
                className="btn btn-secondary btn-sm"
                onClick={onPrev}
                disabled={page === 0}
              >
                Previous
              </button>
              <span className="text-xs text-muted-foreground">
                {page + 1} / {totalPages}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={onNext}
                disabled={page >= totalPages - 1}
              >
                Next
              </button>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={onExport}>
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </button>
              <button className="btn btn-secondary" onClick={onClear}>
                Clear Results
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
ResultsBlock.displayName = 'ResultsBlock';

export default NLQInterface;
