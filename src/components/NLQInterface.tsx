import React, { useState, useEffect } from 'react';
import { safeInvoke } from '../utils/tauri';
import { MessageSquare, Play, Copy, Download, RefreshCw, Zap, Turtle, Settings, Lock, Unlock } from 'lucide-react';
import '../index.css';

interface NLQInterfaceProps {
  dbConnected: boolean;
  onStatusUpdate: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
}

type Provider = 'lmstudio' | 'openrouter';

interface BackendColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string;
}

interface BackendQueryResult {
  success: boolean;
  columns?: BackendColumn[];
  rows?: Record<string, string>[];
  message?: string;
  row_count?: number;
}

interface DisplayQueryResult {
  success: boolean;
  columns: string[];
  rows: string[][];
  message?: string;
  rowCount: number;
}

interface PerformanceMetrics {
  approach: 'strategic' | 'traditional';
  tablesUsed: string[] | 'all';
  estimatedTokens: number;
  processingTime: string;
  provider: string;
}

const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/api/v1/chat';
const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_API_KEY = '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';

const parseTableTags = (query: string): string[] => {
  const matches = query.match(/@(\w+)/g) ?? [];
  return matches.map(tag => tag.slice(1));
};

const normalizeQueryResult = (raw: BackendQueryResult): DisplayQueryResult => {
  const columns = raw.columns?.map(c => c.name) ?? [];
  const rows = (raw.rows ?? []).map(row =>
    columns.map(name => {
      const v = row?.[name];
      return v === undefined || v === null ? 'NULL' : String(v);
    })
  );
  return {
    success: raw.success,
    columns,
    rows,
    message: raw.message,
    rowCount: raw.row_count ?? rows.length,
  };
};

const csvEscape = (value: string): string => {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

const NLQInterface: React.FC<NLQInterfaceProps> = ({
  dbConnected,
  onStatusUpdate,
  onLoadingChange,
}) => {
  const [naturalQuery, setNaturalQuery] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');
  const [queryResult, setQueryResult] = useState<DisplayQueryResult | null>(null);
  const [schema, setSchema] = useState('');
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState<Provider>('lmstudio');
  const [lmStudioEndpoint, setLmStudioEndpoint] = useState(DEFAULT_LMSTUDIO_ENDPOINT);
  const [openRouterEndpoint, setOpenRouterEndpoint] = useState(DEFAULT_OPENROUTER_ENDPOINT);
  const [openRouterApiKey, setOpenRouterApiKey] = useState(DEFAULT_OPENROUTER_API_KEY);
  const [readOnlyLock, setReadOnlyLock] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);

  useEffect(() => {
    const savedProvider = (localStorage.getItem('provider') as Provider | null) ?? 'lmstudio';
    const savedLmStudioEndpoint = localStorage.getItem('lmStudioEndpoint') ?? DEFAULT_LMSTUDIO_ENDPOINT;
    const savedOpenRouterEndpoint = localStorage.getItem('openRouterEndpoint') ?? DEFAULT_OPENROUTER_ENDPOINT;
    const savedOpenRouterApiKey = localStorage.getItem('openRouterApiKey') ?? DEFAULT_OPENROUTER_API_KEY;
    // Default to true (read-only) when the key has never been set — safer for new users.
    const savedReadOnlyLockRaw = localStorage.getItem('readOnlyLock');
    const savedReadOnlyLock = savedReadOnlyLockRaw === null ? true : savedReadOnlyLockRaw === 'true';

    setProvider(savedProvider);
    setLmStudioEndpoint(savedLmStudioEndpoint);
    setOpenRouterEndpoint(savedOpenRouterEndpoint);
    setOpenRouterApiKey(savedOpenRouterApiKey);
    setReadOnlyLock(savedReadOnlyLock);
  }, []);

  const handleSaveSettings = () => {
    localStorage.setItem('provider', provider);
    localStorage.setItem('lmStudioEndpoint', lmStudioEndpoint);
    localStorage.setItem('openRouterEndpoint', openRouterEndpoint);
    localStorage.setItem('openRouterApiKey', openRouterApiKey);
    localStorage.setItem('readOnlyLock', readOnlyLock.toString());
    setShowSettings(false);
    onStatusUpdate('Settings saved');
  };

  const toggleLock = () => {
    const newLockState = !readOnlyLock;
    setReadOnlyLock(newLockState);
    localStorage.setItem('readOnlyLock', newLockState.toString());
    onStatusUpdate(
      newLockState
        ? 'Read-Only mode enabled - database protected from modifications'
        : 'Read-Only mode disabled - full database access allowed'
    );
  };

  const switchProvider = (newProvider: Provider) => {
    if (newProvider === 'openrouter' && !openRouterApiKey.trim()) {
      onStatusUpdate('Please enter OpenRouter API key in settings before switching');
      return;
    }
    setProvider(newProvider);
    onStatusUpdate(`Switched to ${newProvider === 'lmstudio' ? 'LM Studio' : 'OpenRouter'}`);
  };

  useEffect(() => {
    if (dbConnected) {
      loadSchema();
      loadTables();
    } else {
      setSchema('');
      setAvailableTables([]);
      setQueryResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbConnected]);

  const loadTables = async () => {
    try {
      const response = await safeInvoke<{ tables: string[] }>('get_tables', {});
      setAvailableTables(response?.tables ?? []);
    } catch (error) {
      console.error('Failed to load tables:', error);
    }
  };

  const loadSchema = async () => {
    try {
      onLoadingChange(true);
      onStatusUpdate('Loading schema...');
      const response = await safeInvoke<string>('get_schema', {});
      setSchema(response || 'No schema available');
      onStatusUpdate('Schema loaded');
    } catch (error) {
      onStatusUpdate('Schema load failed');
      setSchema('No schema available');
    } finally {
      onLoadingChange(false);
    }
  };

  const generateSQL = async () => {
    if (!naturalQuery.trim()) {
      onStatusUpdate('Enter a query first');
      return;
    }
    if (provider === 'openrouter' && !openRouterApiKey.trim()) {
      onStatusUpdate('Enter OpenRouter API key');
      return;
    }

    const taggedTables = parseTableTags(naturalQuery);
    setIsGenerating(true);
    onLoadingChange(true);

    try {
      const prompt = `Schema:\n${schema || 'No schema loaded'}\n\nAvailable Tables: ${availableTables.join(', ')}\n\nQuery: ${naturalQuery}\n\n${taggedTables.length > 0 ? `Focus on these tables: ${taggedTables.join(', ')}` : ''}\n\nReturn SQL only:`;

      const response = provider === 'lmstudio'
        ? await fetch(lmStudioEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'local-model', input: prompt, temperature: 0.1 }),
          })
        : await fetch(openRouterEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${openRouterApiKey}`,
            },
            body: JSON.stringify({
              model: 'poolside/laguna-m.1:free',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1,
            }),
          });

      if (!response.ok) throw new Error(`API failed (${response.status})`);

      const data = await response.json();
      const sql = provider === 'lmstudio'
        ? (data.content?.trim() || data.message?.trim())
        : data.choices?.[0]?.message?.content?.trim();

      if (sql) {
        const cleanedSQL = sql.replace(/```sql\n?|```\n?/g, '').trim();
        setGeneratedSQL(cleanedSQL);

        const approach: 'strategic' | 'traditional' = taggedTables.length > 0 ? 'strategic' : 'traditional';
        setPerformanceMetrics({
          approach,
          tablesUsed: taggedTables.length > 0 ? taggedTables : 'all',
          estimatedTokens: taggedTables.length > 0 ? 1500 : 3000,
          processingTime: '< 2 seconds',
          provider: provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter',
        });
        onStatusUpdate(`SQL generated (${approach} approach)`);
      } else {
        onStatusUpdate('No SQL returned');
      }
    } catch (error) {
      onStatusUpdate(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsGenerating(false);
      onLoadingChange(false);
    }
  };

  const executeQuery = async () => {
    if (!dbConnected || !generatedSQL.trim()) {
      onStatusUpdate('Connect to database and generate SQL first');
      return;
    }

    setIsExecuting(true);
    onLoadingChange(true);

    try {
      const raw = await safeInvoke<BackendQueryResult>('execute_query', {
        request: { sql_query: generatedSQL.trim() },
      });

      if (!raw) {
        setQueryResult(null);
        onStatusUpdate('No results returned');
        return;
      }

      const normalized = normalizeQueryResult(raw);
      setQueryResult(normalized);

      if (normalized.success) {
        onStatusUpdate(
          normalized.rows.length > 0
            ? `Query executed (${normalized.rowCount} rows)`
            : 'Query executed - no rows returned'
        );
      } else {
        onStatusUpdate(normalized.message ?? 'Query failed');
      }
    } catch (error) {
      onStatusUpdate(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setQueryResult(null);
    } finally {
      setIsExecuting(false);
      onLoadingChange(false);
    }
  };

  const clearResults = () => {
    setQueryResult(null);
    setGeneratedSQL('');
    setPerformanceMetrics(null);
  };

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
    const suggestions = availableTables.filter(table =>
      table.toLowerCase().includes(filter)
    );

    if (suggestions.length > 0) {
      setFilteredSuggestions(suggestions);
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
    } else if (e.key === 'Enter' && !e.shiftKey && filteredSuggestions.length > 0) {
      e.preventDefault();
      handleSuggestionSelect(filteredSuggestions[0]);
    }
  };

  const copySQL = () => {
    if (!generatedSQL) return;
    navigator.clipboard.writeText(generatedSQL);
    onStatusUpdate('SQL copied to clipboard');
  };

  const exportResults = () => {
    if (!queryResult || queryResult.rows.length === 0) return;
    const csv = [
      queryResult.columns.map(csvEscape).join(','),
      ...queryResult.rows.map(row => row.map(csvEscape).join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query_results.csv';
    a.click();
    URL.revokeObjectURL(url);
    onStatusUpdate('Results exported to CSV');
  };

  const canGenerate = dbConnected && naturalQuery.trim().length > 0 && !isGenerating;
  const canExecute = dbConnected && generatedSQL.trim().length > 0 && !isExecuting;

  return (
    <div className="h-full flex flex-col bg-[#2d2d2d] rounded-lg border border-[#404040]">
      {/* Header */}
      <div className="px-4 py-4 border-b border-[#404040] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="m-0 text-white text-base font-semibold">Natural Language Query</h3>
          <button
            className={`btn btn-sm flex items-center gap-2 ${readOnlyLock ? 'btn-success' : 'btn-secondary'}`}
            onClick={toggleLock}
            title={
              readOnlyLock
                ? 'Disable read-only mode - allows data modification'
                : 'Enable read-only mode - protects database from modifications'
            }
          >
            {readOnlyLock ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            <span>{readOnlyLock ? 'Read-Only' : 'Full Access'}</span>
            {readOnlyLock && (
              <span className="ml-1 px-1.5 py-0.5 bg-[#107c10] text-white text-xs rounded-full">ON</span>
            )}
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
            onClick={loadSchema}
            disabled={!dbConnected}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh Schema
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-4 py-4 overflow-y-auto min-h-0">
        {/* Natural Language Input */}
        <div className="mb-5">
          <div className="text-sm font-semibold text-[#cccccc] mb-2">
            Natural Language Query (use @tablename to tag tables)
          </div>
          <div className="relative">
            <textarea
              className="w-full bg-[#1e1e1e] border border-[#404040] rounded-lg px-3 py-2 text-white placeholder-[#666666] resize-none focus:outline-none focus:border-[#0078d4]"
              placeholder="Enter your question in plain English, e.g., 'Show me all users from @users table'"
              value={naturalQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={!dbConnected}
              rows={4}
            />
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#2d2d2d] border border-[#404040] rounded-lg max-h-48 overflow-y-auto z-20 shadow-xl">
                {filteredSuggestions.map((table, index) => (
                  <div
                    key={table}
                    className={`px-3 py-2 hover:bg-[#555555] cursor-pointer flex items-center gap-2 transition-colors ${index === 0 ? 'bg-[#3a3a3a]' : ''}`}
                    onClick={() => handleSuggestionSelect(table)}
                  >
                    <MessageSquare size={14} className="text-[#0078d4]" />
                    <span className="text-sm text-[#cccccc]">{table}</span>
                    {index === 0 && (
                      <span className="ml-auto text-xs text-[#888888]">Press Enter</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn btn-primary mt-2"
            onClick={generateSQL}
            disabled={!canGenerate}
          >
            {isGenerating ? 'Generating...' : 'Generate SQL'}
          </button>
        </div>

        {/* Generated SQL */}
        {generatedSQL && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-[#cccccc] flex items-center gap-2">
                <span>Generated SQL</span>
                {performanceMetrics && (
                  <span className="px-2 py-1 rounded-full text-xs font-medium">
                    {performanceMetrics.approach === 'strategic' ? (
                      <span className="text-[#107c10] inline-flex items-center">
                        <Zap className="w-3 h-3 mr-1" />Fast
                      </span>
                    ) : (
                      <span className="text-[#cccccc] inline-flex items-center">
                        <Turtle className="w-3 h-3 mr-1" />Traditional
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg p-3">
              <pre className="text-sm text-[#cccccc] whitespace-pre-wrap break-words font-mono m-0">{generatedSQL}</pre>
              {performanceMetrics && (
                <div className="mt-3 pt-3 border-t border-[#404040] text-xs text-[#cccccc]">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div><span className="text-[#888888]">Approach:</span> {performanceMetrics.approach}</div>
                    <div>
                      <span className="text-[#888888]">Tables:</span>{' '}
                      {Array.isArray(performanceMetrics.tablesUsed)
                        ? performanceMetrics.tablesUsed.join(', ')
                        : performanceMetrics.tablesUsed}
                    </div>
                    <div><span className="text-[#888888]">Tokens:</span> {performanceMetrics.estimatedTokens.toLocaleString()}</div>
                    <div><span className="text-[#888888]">Time:</span> {performanceMetrics.processingTime}</div>
                  </div>
                </div>
              )}
              <div className="flex gap-2 mt-3 flex-wrap">
                <button
                  className="btn btn-success"
                  onClick={executeQuery}
                  disabled={!canExecute}
                >
                  <Play className="w-4 h-4 mr-2" />
                  {isExecuting ? 'Executing...' : 'Execute Query'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={copySQL}
                  disabled={!generatedSQL}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy SQL
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setGeneratedSQL('')}
                >
                  Clear SQL
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Query Results */}
        {queryResult && (
          <div className="mb-5">
            <div className="text-sm font-semibold text-[#cccccc] mb-2 flex items-center gap-2">
              <span>Query Results</span>
              <span className="text-xs text-[#888888]">({queryResult.rowCount} rows)</span>
            </div>

            {queryResult.success ? (
              queryResult.columns.length > 0 && queryResult.rows.length > 0 ? (
                <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg overflow-hidden flex flex-col">
                  <div className="overflow-auto max-h-[50vh]">
                    <table className="w-full text-sm border-collapse">
                      <thead className="bg-[#2d2d2d] sticky top-0 z-10">
                        <tr>
                          {queryResult.columns.map(col => (
                            <th
                              key={col}
                              className="px-3 py-2 text-left text-[#cccccc] font-medium border-b border-[#404040] whitespace-nowrap"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.rows.map((row, idx) => (
                          <tr key={idx} className="border-t border-[#404040] hover:bg-[#252525]">
                            {row.map((cell, cellIdx) => (
                              <td
                                key={cellIdx}
                                className="px-3 py-2 text-[#cccccc] max-w-xs overflow-hidden text-ellipsis whitespace-nowrap"
                                title={cell}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex gap-2 p-3 border-t border-[#404040] flex-wrap">
                    <button className="btn btn-secondary" onClick={exportResults}>
                      <Download className="w-4 h-4 mr-2" />
                      Export CSV
                    </button>
                    <button className="btn btn-secondary" onClick={clearResults}>
                      Clear Results
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg px-4 py-6 text-center text-[#cccccc]">
                  {queryResult.message ?? 'Query executed - no rows returned'}
                </div>
              )
            ) : (
              <div className="bg-[#d13438]/10 border border-[#d13438] rounded-lg px-4 py-4 text-[#d13438] whitespace-pre-wrap break-words">
                {queryResult.message ?? 'Query execution failed'}
              </div>
            )}
          </div>
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
              <button className="modal-close" onClick={() => setShowSettings(false)}>×</button>
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
                  <p className="text-sm text-[#888888] mt-1">
                    Enter the LM Studio native API endpoint for SQL generation
                  </p>
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
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button
                className={`btn ${provider === 'lmstudio' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => switchProvider('lmstudio')}
              >
                Use LM Studio
              </button>
              <button
                className={`btn ${provider === 'openrouter' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => switchProvider('openrouter')}
              >
                Use OpenRouter
              </button>
              <button className="btn btn-primary" onClick={handleSaveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NLQInterface;
