import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare,
  Play,
  Copy,
  RefreshCw,
  Zap,
  Turtle,
  Settings,
  Lock,
  Unlock,
  ShieldAlert,
} from 'lucide-react';
import ExportDropdown from './ExportDropdown';
import { api } from '../services/api';
import {
  generateSql,
  parseTableTags,
  NotSqlRequestError,
  type LlmConfig,
  type Provider,
} from '../services/llm';
import { useDb } from '../store/DbContext';
import { SQLSafetyAnalyzer } from '../utils/sqlSafetyAnalyzer';
import type { QueryResult, Row, TableColumn } from '../types/api';
import '../index.css';

const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/api/v1/chat';
const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEYRING_ACCOUNT = 'openrouter_api_key';

const PAGE_SIZE = 100;

interface PerformanceMetrics {
  approach: 'strategic' | 'traditional';
  tablesUsed: string[] | 'all';
  estimatedTokens: number;
  generationMs: number;
  provider: string;
}

const cellText = (v: string | null) => (v === null ? 'NULL' : v);

const formatMs = (ms: number): string => {
  if (ms < 1) return '< 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

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

  const [naturalQuery, setNaturalQuery] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');
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
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [provider, setProvider] = useState<Provider>('lmstudio');
  const [lmStudioEndpoint, setLmStudioEndpoint] = useState(DEFAULT_LMSTUDIO_ENDPOINT);
  const [openRouterEndpoint, setOpenRouterEndpoint] = useState(DEFAULT_OPENROUTER_ENDPOINT);
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState<{ warnings: string[] } | null>(null);

  // Load settings on mount (with migration of legacy localStorage API key into keychain).
  useEffect(() => {
    (async () => {
      setProvider((localStorage.getItem('provider') as Provider | null) ?? 'lmstudio');
      setLmStudioEndpoint(localStorage.getItem('lmStudioEndpoint') ?? DEFAULT_LMSTUDIO_ENDPOINT);
      setOpenRouterEndpoint(localStorage.getItem('openRouterEndpoint') ?? DEFAULT_OPENROUTER_ENDPOINT);

      const legacy = localStorage.getItem('openRouterApiKey');
      if (legacy) {
        try {
          await api.credentialSet(OPENROUTER_KEYRING_ACCOUNT, legacy);
        } catch (e) {
          console.warn('Failed to migrate API key into keyring:', e);
        }
        localStorage.removeItem('openRouterApiKey');
      }
      try {
        const key = await api.credentialGet(OPENROUTER_KEYRING_ACCOUNT);
        setOpenRouterApiKey(key ?? '');
      } catch (e) {
        console.warn('Failed to load API key:', e);
      }
    })();
  }, []);

  const saveSettings = async () => {
    localStorage.setItem('provider', provider);
    localStorage.setItem('lmStudioEndpoint', lmStudioEndpoint);
    localStorage.setItem('openRouterEndpoint', openRouterEndpoint);
    try {
      if (openRouterApiKey.trim()) {
        await api.credentialSet(OPENROUTER_KEYRING_ACCOUNT, openRouterApiKey);
      } else {
        await api.credentialDelete(OPENROUTER_KEYRING_ACCOUNT);
      }
      setShowSettings(false);
      setStatusMessage('Settings saved');
    } catch (e) {
      setStatusMessage(`Failed to save settings: ${e}`);
    }
  };

  const toggleLock = () => {
    const next = !readOnlyLock;
    setReadOnlyLock(next);
    setStatusMessage(
      next
        ? 'Read-only mode enabled — write queries will be blocked'
        : 'Read-only mode disabled — full access'
    );
  };

  const handleGenerate = async () => {
    if (!naturalQuery.trim()) {
      setStatusMessage('Enter a query first');
      return;
    }
    const taggedTables = parseTableTags(naturalQuery);

    setIsGenerating(true);
    setLoading(true);
    const t0 = performance.now();
    try {
      // Server-side schema filtering: when @tags are present, only the relevant
      // tables are rendered into the prompt. Cuts token usage on large DBs.
      const promptSchema = taggedTables.length > 0
        ? await api.getFilteredSchema(taggedTables)
        : schema;

      const config: LlmConfig = {
        provider,
        lmStudioEndpoint,
        openRouterEndpoint,
        openRouterApiKey,
      };

      const sql = await generateSql({
        naturalQuery,
        schema: promptSchema,
        taggedTables,
        config,
      });
      const generationMs = performance.now() - t0;
      setGeneratedSQL(sql);

      const approach: 'strategic' | 'traditional' =
        taggedTables.length > 0 ? 'strategic' : 'traditional';
      setPerformanceMetrics({
        approach,
        tablesUsed: taggedTables.length > 0 ? taggedTables : 'all',
        estimatedTokens: taggedTables.length > 0 ? 1500 : 3000,
        generationMs,
        provider: provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter',
      });
      setStatusMessage(`SQL generated in ${formatMs(generationMs)} (${approach})`);
    } catch (e) {
      if (e instanceof NotSqlRequestError) {
        setGeneratedSQL('');
        setPerformanceMetrics(null);
        setStatusMessage(
          `Not a SQL request (${e.reason}). Ask about your tables, columns, or data.`
        );
      } else {
        setStatusMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setIsGenerating(false);
      setLoading(false);
    }
  };

  const runQuery = async (sql: string) => {
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
    } catch (e) {
      const executionMs = performance.now() - t0;
      setQueryColumns([]);
      setQueryRows([]);
      setQueryMeta({ success: false, message: String(e), rowCount: 0, executionMs });
      setStatusMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExecuting(false);
      setLoading(false);
    }
  };

  const handleExecute = () => {
    if (!dbConnected || !generatedSQL.trim()) {
      setStatusMessage('Connect to database and generate SQL first');
      return;
    }
    const analysis = SQLSafetyAnalyzer.analyzeQuery(generatedSQL);
    if (readOnlyLock && !analysis.isReadOnly) {
      setPendingDestructive({ warnings: analysis.warnings });
      return;
    }
    runQuery(generatedSQL);
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
    if (!showSuggestions) return;
    if (e.key === 'Escape') setShowSuggestions(false);
    else if (e.key === 'Enter' && !e.shiftKey && filteredSuggestions.length > 0) {
      e.preventDefault();
      handleSuggestionSelect(filteredSuggestions[0]);
    }
  };

  const copySQL = () => {
    if (!generatedSQL) return;
    navigator.clipboard.writeText(generatedSQL);
    setStatusMessage('SQL copied to clipboard');
  };

  const handleExported = (format: string) => {
    setStatusMessage(`Results exported as ${format.toUpperCase()}`);
  };

  const clearResults = () => {
    setQueryRows([]);
    setQueryColumns([]);
    setQueryMeta(null);
    setGeneratedSQL('');
    setPerformanceMetrics(null);
  };

  // Paginate the rendered rows so huge result sets don't freeze the UI.
  const totalPages = Math.max(1, Math.ceil(queryRows.length / PAGE_SIZE));
  const visibleRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return queryRows.slice(start, start + PAGE_SIZE);
  }, [queryRows, page]);

  const canGenerate = dbConnected && naturalQuery.trim().length > 0 && !isGenerating;
  const canExecute = dbConnected && generatedSQL.trim().length > 0 && !isExecuting;

  return (
    <div className="h-full flex flex-col bg-[#2d2d2d] rounded-lg border border-[#404040]">
      <div className="px-4 py-4 border-b border-[#404040] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="m-0 text-white text-base font-semibold">Natural Language Query</h3>
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
        <div className="mb-5">
          <div className="text-sm font-semibold text-[#cccccc] mb-2">
            Natural Language Query (use @tablename to tag tables)
          </div>
          <div className="relative">
            <textarea
              className="w-full bg-[#1e1e1e] border border-[#404040] rounded-lg px-3 py-2 text-white placeholder-[#666666] resize-none focus:outline-none focus:border-[#0078d4]"
              placeholder="e.g., 'Show me all users from @users created last week'"
              value={naturalQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={!dbConnected}
              rows={4}
            />
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#2d2d2d] border border-[#404040] rounded-lg max-h-48 overflow-y-auto z-20 shadow-xl">
                {filteredSuggestions.map((table, idx) => (
                  <div
                    key={table}
                    className={`px-3 py-2 hover:bg-[#555555] cursor-pointer flex items-center gap-2 ${idx === 0 ? 'bg-[#3a3a3a]' : ''}`}
                    onClick={() => handleSuggestionSelect(table)}
                  >
                    <MessageSquare size={14} className="text-[#0078d4]" />
                    <span className="text-sm text-[#cccccc]">{table}</span>
                    {idx === 0 && (
                      <span className="ml-auto text-xs text-[#888888]">Press Enter</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn btn-primary mt-2"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            {isGenerating ? 'Generating...' : 'Generate SQL'}
          </button>
        </div>

        {generatedSQL && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-[#cccccc] flex items-center gap-2">
                <span>Generated SQL</span>
                {performanceMetrics && (
                  <span className="px-2 py-1 rounded-full text-xs font-medium">
                    {performanceMetrics.approach === 'strategic' ? (
                      <span className="text-[#107c10] inline-flex items-center">
                        <Zap className="w-3 h-3 mr-1" />Filtered
                      </span>
                    ) : (
                      <span className="text-[#cccccc] inline-flex items-center">
                        <Turtle className="w-3 h-3 mr-1" />Full schema
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg p-3">
              <pre className="text-sm text-[#cccccc] whitespace-pre-wrap break-words font-mono m-0">
                {generatedSQL}
              </pre>
              {performanceMetrics && (
                <div className="mt-3 pt-3 border-t border-[#404040] text-xs text-[#cccccc] grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <span className="text-[#888888]">Approach:</span>{' '}
                    {performanceMetrics.approach}
                  </div>
                  <div>
                    <span className="text-[#888888]">Tables:</span>{' '}
                    {Array.isArray(performanceMetrics.tablesUsed)
                      ? performanceMetrics.tablesUsed.join(', ')
                      : performanceMetrics.tablesUsed}
                  </div>
                  <div>
                    <span className="text-[#888888]">Tokens (est):</span>{' '}
                    {performanceMetrics.estimatedTokens.toLocaleString()}
                  </div>
                  <div>
                    <span className="text-[#888888]">Provider:</span>{' '}
                    {performanceMetrics.provider}
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[#888888]">Generated in:</span>{' '}
                    <span className="text-white font-medium">
                      {formatMs(performanceMetrics.generationMs)}
                    </span>
                  </div>
                </div>
              )}
              <div className="flex gap-2 mt-3 flex-wrap">
                <button
                  className="btn btn-success"
                  onClick={handleExecute}
                  disabled={!canExecute}
                >
                  <Play className="w-4 h-4 mr-2" />
                  {isExecuting ? 'Executing...' : 'Execute Query'}
                </button>
                <button className="btn btn-secondary" onClick={copySQL}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy SQL
                </button>
                <button className="btn btn-secondary" onClick={() => setGeneratedSQL('')}>
                  Clear SQL
                </button>
              </div>
            </div>
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
            allRows={queryRows}
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage(p => Math.max(0, p - 1))}
            onNext={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            onExported={handleExported}
            onClear={clearResults}
          />
        )}

        {!dbConnected && (
          <div className="text-center text-[#cccccc] py-8">
            Connect to a database to use natural language queries
          </div>
        )}
      </div>

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
              <div className="form-group">
                <label>Provider</label>
                <select
                  className="form-input"
                  value={provider}
                  onChange={e => setProvider(e.target.value as Provider)}
                >
                  <option value="lmstudio">LM Studio</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </div>

              {provider === 'lmstudio' ? (
                <div className="form-group">
                  <label>LM Studio Endpoint</label>
                  <input
                    type="text"
                    className="form-input"
                    value={lmStudioEndpoint}
                    onChange={e => setLmStudioEndpoint(e.target.value)}
                    placeholder={DEFAULT_LMSTUDIO_ENDPOINT}
                  />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label>OpenRouter Endpoint</label>
                    <input
                      type="text"
                      className="form-input"
                      value={openRouterEndpoint}
                      onChange={e => setOpenRouterEndpoint(e.target.value)}
                      placeholder={DEFAULT_OPENROUTER_ENDPOINT}
                    />
                  </div>
                  <div className="form-group">
                    <label>OpenRouter API Key</label>
                    <input
                      type="password"
                      className="form-input"
                      value={openRouterApiKey}
                      onChange={e => setOpenRouterApiKey(e.target.value)}
                      placeholder="sk-or-v1-..."
                    />
                    <p className="text-xs text-[#888888] mt-1">
                      Stored in your OS keychain, not localStorage.
                    </p>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={saveSettings}>
                Save
              </button>
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
                <ShieldAlert className="w-5 h-5 text-[#d13438]" />
                Read-only mode blocked this query
              </h3>
              <button className="modal-close" onClick={() => setPendingDestructive(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="text-sm text-[#cccccc]">
                The generated SQL appears to modify data or schema. You can disable
                read-only mode to run it.
              </p>
              <ul className="mt-3 text-sm text-[#cccccc] list-disc pl-5 space-y-1">
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
                  const sql = generatedSQL;
                  setPendingDestructive(null);
                  runQuery(sql);
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
  allRows: Row[];
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  onExported: (format: string) => void;
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
    allRows,
    page,
    totalPages,
    onPrev,
    onNext,
    onExported,
    onClear,
  }) => {
    if (!success) {
      return (
        <div className="mb-5">
          <div className="text-sm font-semibold text-[#cccccc] mb-2 flex items-center gap-2">
            <span>Query Results</span>
            <span className="text-xs text-[#888888]">
              (failed after {formatMs(executionMs)})
            </span>
          </div>
          <div className="bg-[#d13438]/10 border border-[#d13438] rounded-lg px-4 py-4 text-[#d13438] whitespace-pre-wrap break-words">
            {message ?? 'Query execution failed'}
          </div>
        </div>
      );
    }
    if (rowCount === 0 || columns.length === 0) {
      return (
        <div className="mb-5">
          <div className="text-sm font-semibold text-[#cccccc] mb-2 flex items-center gap-2">
            <span>Query Results</span>
            <span className="text-xs text-[#888888]">
              (no rows · {formatMs(executionMs)})
            </span>
          </div>
          <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg px-4 py-6 text-center text-[#cccccc]">
            {message ?? 'Query executed - no rows returned'}
          </div>
        </div>
      );
    }

    return (
      <div className="mb-5">
        <div className="text-sm font-semibold text-[#cccccc] mb-2 flex items-center gap-2">
          <span>Query Results</span>
          <span className="text-xs text-[#888888]">
            ({rowCount} rows · {formatMs(executionMs)} · page {page + 1} of {totalPages})
          </span>
        </div>
        <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg overflow-hidden">
          <div className="overflow-auto max-h-[50vh]">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-[#2d2d2d] sticky top-0 z-10">
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.name}
                      className="px-3 py-2 text-left text-[#cccccc] font-medium border-b border-[#404040] whitespace-nowrap"
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, idx) => (
                  <tr key={idx} className="border-t border-[#404040] hover:bg-[#252525]">
                    {row.map((cell, cellIdx) => (
                      <td
                        key={cellIdx}
                        className={`px-3 py-2 max-w-xs overflow-hidden text-ellipsis whitespace-nowrap ${cell === null ? 'text-[#666666] italic' : 'text-[#cccccc]'}`}
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
          <div className="flex items-center justify-between p-3 border-t border-[#404040] flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <button
                className="btn btn-secondary btn-sm"
                onClick={onPrev}
                disabled={page === 0}
              >
                Previous
              </button>
              <span className="text-xs text-[#888888]">
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
              <ExportDropdown
                payload={{ columns, rows: allRows }}
                onExported={onExported}
              />
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
