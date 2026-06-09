import React, { useMemo, useState } from 'react';
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
} from 'lucide-react';
import { api } from '../services/api';
import { generateSql, parseTableTags, NotSqlRequestError } from '../services/llm';
import { useDb } from '../store/DbContext';
import { useAiSettings } from '../store/AiSettingsContext';
import AiProviderForm from './AiProviderForm';
import { SQLSafetyAnalyzer } from '../utils/sqlSafetyAnalyzer';
import type { QueryResult, Row, TableColumn } from '../types/api';
import '../index.css';

const PAGE_SIZE = 100;

interface PerformanceMetrics {
  approach: 'strategic' | 'traditional';
  tablesUsed: string[] | 'all';
  estimatedTokens: number;
  generationMs: number;
  provider: string;
}

const csvEscape = (v: string) =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

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
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const { config, aiReady } = useAiSettings();

  const [isGenerating, setIsGenerating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState<{ warnings: string[] } | null>(null);

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
        provider: config.provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter',
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
    if (!showSuggestions) return;
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
    if (!generatedSQL) return;
    navigator.clipboard.writeText(generatedSQL);
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
    setGeneratedSQL('');
    setPerformanceMetrics(null);
  };

  // Paginate the rendered rows so huge result sets don't freeze the UI.
  const totalPages = Math.max(1, Math.ceil(queryRows.length / PAGE_SIZE));
  const visibleRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return queryRows.slice(start, start + PAGE_SIZE);
  }, [queryRows, page]);

  const canGenerate =
    dbConnected && aiReady && naturalQuery.trim().length > 0 && !isGenerating;
  const canExecute = dbConnected && generatedSQL.trim().length > 0 && !isExecuting;

  return (
    <div className="h-full flex flex-col bg-card rounded-lg border border-border">
      <div className="px-4 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="m-0 text-foreground text-base font-semibold">Natural Language Query</h3>
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
        {dbConnected && !aiReady && (
          <div className="mb-4 flex items-center gap-3 px-3 py-2 rounded-lg border border-warning/40 bg-warning/10 text-warning text-sm">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span className="flex-1">
              No AI provider configured yet — set one up to turn questions into SQL.
            </span>
            <button className="btn btn-warning btn-sm" onClick={() => setShowSettings(true)}>
              Configure AI
            </button>
          </div>
        )}
        <div className="mb-5">
          <div className="text-sm font-semibold text-muted-foreground mb-2">
            Natural Language Query (use @tablename to tag tables)
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
              <div className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                <span>Generated SQL</span>
                {performanceMetrics && (
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
            </div>
            <div className="bg-surface-inset border border-border rounded-lg p-3">
              <pre className="text-sm text-muted-foreground whitespace-pre-wrap break-words font-mono m-0">
                {generatedSQL}
              </pre>
              {performanceMetrics && (
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
                The generated SQL appears to modify data or schema. You can disable
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
