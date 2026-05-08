import React, { useState, useEffect } from 'react';
import { safeInvoke } from '../utils/tauri';
import { MessageSquare, Play, Copy, Download, RefreshCw, Zap, Turtle, Settings, Lock, Unlock } from 'lucide-react';
import { SQLSafetyAnalyzer } from '../utils/sqlSafetyAnalyzer';
import '../index.css';

interface NLQInterfaceProps {
  dbConnected: boolean;
  onStatusUpdate: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
}

interface QueryResult {
  success: boolean;
  columns?: string[];
  rows?: any[][];
  message?: string;
  row_count?: number;
}

const NLQInterface: React.FC<NLQInterfaceProps> = ({
  dbConnected,
  onStatusUpdate,
  onLoadingChange
}) => {
  const [naturalQuery, setNaturalQuery] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [schema, setSchema] = useState('');
    const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [performanceMetrics, setPerformanceMetrics] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [provider, setProvider] = useState<'lmstudio' | 'openrouter'>('lmstudio');
  const [lmStudioEndpoint, setLmStudioEndpoint] = useState('http://localhost:1234/api/v1/chat');
  const [openRouterEndpoint, setOpenRouterEndpoint] = useState('https://openrouter.ai/api/v1/chat/completions');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('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');
  const [readOnlyLock, setReadOnlyLock] = useState(true);

  // Load provider settings from localStorage on mount
  useEffect(() => {
    // Load with validation and fallbacks
    const savedProvider = localStorage.getItem('provider') as 'lmstudio' | 'openrouter' || 'lmstudio';
    const savedLmStudioEndpoint = localStorage.getItem('lmStudioEndpoint') || 'http://localhost:1234/api/v1/chat';
    const savedOpenRouterEndpoint = localStorage.getItem('openRouterEndpoint') || 'https://openrouter.ai/api/v1/chat/completions';
    const savedOpenRouterApiKey = localStorage.getItem('openRouterApiKey') || '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';
    const savedReadOnlyLock = localStorage.getItem('readOnlyLock') === 'true';
    
    setProvider(savedProvider);
    setLmStudioEndpoint(savedLmStudioEndpoint);
    setOpenRouterEndpoint(savedOpenRouterEndpoint);
    setOpenRouterApiKey(savedOpenRouterApiKey);
    setReadOnlyLock(savedReadOnlyLock);
  }, []);

  // Save provider settings to localStorage when changed
  const handleSaveSettings = () => {
    localStorage.setItem('provider', provider);
    localStorage.setItem('lmStudioEndpoint', lmStudioEndpoint);
    localStorage.setItem('openRouterEndpoint', openRouterEndpoint);
    localStorage.setItem('openRouterApiKey', openRouterApiKey);
    localStorage.setItem('readOnlyLock', readOnlyLock.toString());
    setShowSettings(false);
    onStatusUpdate('Settings saved');
  };

  // Toggle lock state
  const toggleLock = () => {
    const newLockState = !readOnlyLock;
    setReadOnlyLock(newLockState);
    localStorage.setItem('readOnlyLock', newLockState.toString());
    onStatusUpdate(newLockState ? 'Read-Only mode enabled - database protected from modifications' : 'Read-Only mode disabled - full database access allowed');
  };

  // Switch provider with validation
  const switchProvider = (newProvider: 'lmstudio' | 'openrouter') => {
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
    }
  }, [dbConnected]);

  const loadTables = async () => {
    try {
      const response = await safeInvoke('get_tables', {});
      const result = response as { tables: string[] };
      setAvailableTables(result.tables);
    } catch (error) {
      console.error('Failed to load tables:', error);
    }
  };

  const loadSchema = async () => {
    try {
      onLoadingChange(true);
      onStatusUpdate('Loading database schema...');
      
      const response = await safeInvoke('get_schema', {});
      const result = response as { schema: string };
      setSchema(result.schema);
      onStatusUpdate('Schema loaded successfully');
    } catch (error) {
      onStatusUpdate(`Failed to load schema: ${error}`);
      console.error('Failed to load schema:', error);
    } finally {
      onLoadingChange(false);
    }
  };

  const generateSQL = async () => {
    if (!naturalQuery.trim()) {
      onStatusUpdate('Please enter a natural language query');
      return;
    }

    // Validate OpenRouter configuration if selected
    if (provider === 'openrouter' && !openRouterApiKey.trim()) {
      onStatusUpdate('Please enter OpenRouter API key in settings');
      return;
    }

    // Parse @table tags from the query
    const taggedTables = parseTableTags(naturalQuery);
    
    try {
      onLoadingChange(true);
      onStatusUpdate(`Generating SQL with ${provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter'}...`);
      
      // Prepare the prompt
      const prompt = `You are a SQL expert. Generate a PostgreSQL SQL query based on the following natural language request.

Database Schema:
${schema}

Available Tables: ${availableTables.join(', ')}

Natural Language Query: ${naturalQuery}

${taggedTables.length > 0 ? `Focus on these tables: ${taggedTables.join(', ')}` : ''}

Return only the SQL query without any explanation or markdown formatting.`;

      let response;
      
      if (provider === 'lmstudio') {
        // LM Studio Native API
        response = await fetch(lmStudioEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'local-model',
            input: prompt,
            system_prompt: 'You are a SQL expert. Generate SQL queries based on natural language requests. Return only the SQL query without any explanation or markdown formatting.',
            temperature: 0.1,
            max_output_tokens: 500,
          }),
        });
      } else {
        // OpenRouter API with reasoning
        response = await fetch(openRouterEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openRouterApiKey}`,
            'HTTP-Referer': 'http://localhost:5173',
            'X-OpenRouter-Title': 'IntelQuery',
          },
          body: JSON.stringify({
            model: 'poolside/laguna-m.1:free',
            messages: [
              {
                role: 'system',
                content: 'You are a SQL expert. Generate SQL queries based on natural language requests. Return only the SQL query without any explanation or markdown formatting.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            reasoning: { enabled: true },
            temperature: 0.1,
            max_tokens: 500,
          }),
        });
      }

      if (!response.ok) {
        throw new Error(`${provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter'} API error: ${response.statusText}`);
      }

      const data = await response.json();
      let sqlQuery;
      
      if (provider === 'lmstudio') {
        sqlQuery = data.content?.trim() || data.message?.trim();
      } else {
        sqlQuery = data.choices?.[0]?.message?.content?.trim();
      }
      
      if (sqlQuery) {
        // Clean up the SQL query (remove markdown code blocks if present)
        const cleanedSQL = sqlQuery.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
        setGeneratedSQL(cleanedSQL);
        
        // Set performance metrics
        const approach = taggedTables.length > 0 ? 'strategic' : 'traditional';
        setPerformanceMetrics({
          approach,
          tablesUsed: taggedTables.length > 0 ? taggedTables : 'all',
          estimatedTokens: taggedTables.length > 0 ? 1500 : 3000,
          processingTime: '< 2 seconds',
          provider: provider === 'lmstudio' ? 'LM Studio' : 'OpenRouter'
        });
        
        onStatusUpdate(`SQL generated successfully (${approach} approach)`);
      } else {
        throw new Error('No SQL query returned');
      }
    } catch (error) {
      onStatusUpdate(`SQL generation error: ${error}`);
      console.error('Failed to generate SQL:', error);
    } finally {
      onLoadingChange(false);
    }
  };

  const executeQuery = async () => {
    if (!generatedSQL.trim()) {
      onStatusUpdate('No SQL query to execute');
      return;
    }

    // Check if read-only lock is enabled
    if (readOnlyLock) {
      const safetyAnalysis = SQLSafetyAnalyzer.analyzeQuery(generatedSQL);
      
      if (!safetyAnalysis.isReadOnly) {
        onStatusUpdate('🔒 Query blocked by read-only protection');
        onStatusUpdate(SQLSafetyAnalyzer.getSafetyReport(generatedSQL));
        return;
      }
    }

    try {
      onLoadingChange(true);
      onStatusUpdate('Executing query...');
      
      const response = await safeInvoke('execute_query', {
        sql_query: generatedSQL
      });
      
      const result = response as QueryResult;
      setQueryResult(result);
      
      if (result.success) {
        onStatusUpdate(result.message || 'Query executed successfully');
      } else {
        onStatusUpdate(`Query execution failed: ${result.message}`);
      }
    } catch (error) {
      onStatusUpdate(`Query execution error: ${error}`);
      console.error('Failed to execute query:', error);
    } finally {
      onLoadingChange(false);
    }
  };

  
  const clearResults = () => {
    setQueryResult(null);
    setGeneratedSQL('');
    setPerformanceMetrics(null);
  };

  // @table tagging functions
  const parseTableTags = (query: string): string[] => {
    const pattern = /@(\w+)/g;
    const matches = query.match(pattern) || [];
    return matches.map(tag => tag.substring(1)); // Remove @ symbol
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const position = e.target.selectionStart;
    setNaturalQuery(value);

    // Check if we're typing after @ symbol for auto-completion
    const beforeCursor = value.substring(0, position);
    const atIndex = beforeCursor.lastIndexOf('@');
    
    if (atIndex !== -1) {
      const afterAt = beforeCursor.substring(atIndex + 1);
      const spaceIndex = afterAt.indexOf(' ');
      
      // Only show suggestions if we're in the middle of typing a table name
      if (spaceIndex === -1 && afterAt.length > 0) {
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
      } else {
        setShowSuggestions(false);
      }
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSuggestionSelect = (table: string) => {
    const currentQuery = naturalQuery;
    
    // Find @ symbol and replace everything after it with the selected table
    const atIndex = currentQuery.lastIndexOf('@');
    const beforeAt = currentQuery.substring(0, atIndex);
    const afterAt = currentQuery.substring(atIndex).split(' ').slice(1).join(' ');
    
    const newQuery = `${beforeAt}@${table} ${afterAt}`;
    setNaturalQuery(newQuery);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Navigate suggestions
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        // Navigate suggestions
        return;
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
        return;
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Select first suggestion
        if (filteredSuggestions.length > 0) {
          handleSuggestionSelect(filteredSuggestions[0]);
        }
        return;
      }
    }
  };

  const copySQL = () => {
    if (generatedSQL) {
      navigator.clipboard.writeText(generatedSQL);
      onStatusUpdate('SQL copied to clipboard');
    }
  };

  const exportResults = () => {
    if (queryResult?.columns && queryResult?.rows) {
      const csv = [
        queryResult.columns.join(','),
        ...queryResult.rows.map(row => row.join(','))
      ].join('\n');
      
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'query_results.csv';
      a.click();
      URL.revokeObjectURL(url);
      onStatusUpdate('Results exported to CSV');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#2d2d2d] rounded-lg border border-[#404040]">
      <div className="px-4 py-4 border-b border-[#404040] flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="m-0 text-white text-base font-semibold">Natural Language Query</h3>
          <button 
            className={`btn btn-sm flex items-center gap-2 ${readOnlyLock ? 'btn-success' : 'btn-secondary'}`}
            onClick={toggleLock}
            title={readOnlyLock ? 'Disable read-only mode - allows data modification' : 'Enable read-only mode - protects database from modifications'}
          >
            {readOnlyLock ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            <span>{readOnlyLock ? 'Read-Only' : 'Full Access'}</span>
            {readOnlyLock && <span className="ml-1 px-1.5 py-0.5 bg-[#107c10] text-white text-xs rounded-full">ON</span>}
          </button>
        </div>
        <div className="flex gap-2">
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

      <div className="flex-1 px-4 py-4 overflow-y-auto">
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
            {/* Auto-completion dropdown */}
            {showSuggestions && (
              <div className="absolute bg-[#2d2d2d] border border-[#404040] rounded-lg mt-1 max-h-48 overflow-y-auto z-20 shadow-xl">
                {filteredSuggestions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[#888888]">
                    No matching tables
                  </div>
                ) : (
                  filteredSuggestions.map((table, index) => (
                    <div
                      key={table}
                      className={`px-3 py-2 hover:bg-[#555555] cursor-pointer flex items-center gap-2 transition-colors ${index === 0 ? 'bg-[#3a3a3a]' : ''}`}
                      onClick={() => handleSuggestionSelect(table)}
                    >
                      <MessageSquare size={14} className="text-[#0078d4]" />
                      <span className="text-sm text-[#cccccc]">{table}</span>
                      {index === 0 && (
                        <span className="ml-auto text-xs text-[#888888]">
                          Press Enter to select
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            className="btn btn-primary mt-2"
            onClick={generateSQL}
            disabled={!dbConnected || !naturalQuery.trim()}
          >
            Generate SQL
          </button>
        </div>

        {/* Generated SQL */}
        {generatedSQL && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-[#cccccc]">
                Generated SQL
                {performanceMetrics && (
                  <span className="ml-2 px-2 py-1 rounded-full text-xs font-medium">
                    {performanceMetrics.approach === 'strategic' ? (
                      <span className="text-[#107c10]"><Zap className="w-3 h-3 mr-1 inline" />Fast</span>
                    ) : (
                      <span className="text-[#cccccc]"><Turtle className="w-3 h-3 mr-1 inline" />Traditional</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg p-3">
              <pre className="text-sm text-[#cccccc] whitespace-pre-wrap font-mono">{generatedSQL}</pre>
              {performanceMetrics && (
                <div className="mt-3 pt-3 border-t border-[#404040] text-xs text-[#cccccc]">
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-[#888888]">Approach:</span> {performanceMetrics.approach}</div>
                    <div><span className="text-[#888888]">Tables:</span> {Array.isArray(performanceMetrics.tablesUsed) ? performanceMetrics.tablesUsed.join(', ') : performanceMetrics.tablesUsed}</div>
                    <div><span className="text-[#888888]">Tokens:</span> {performanceMetrics.estimatedTokens.toLocaleString()}</div>
                    <div><span className="text-[#888888]">Time:</span> {performanceMetrics.processingTime}</div>
                  </div>
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <button
                  className="btn btn-success"
                  onClick={executeQuery}
                  disabled={!dbConnected}
                >
                  <Play className="w-4 h-4 mr-2" />
                  Execute Query
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
            <div className="text-sm font-semibold text-[#cccccc] mb-2">
              Query Results
              {queryResult.row_count !== undefined && (
                <span className="ml-2 text-xs text-[#888888]">({queryResult.row_count} rows)</span>
              )}
            </div>
            
            {queryResult.success && queryResult.columns && queryResult.rows ? (
              <div className="bg-[#1e1e1e] border border-[#404040] rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#2d2d2d]">
                      <tr>
                        {queryResult.columns.map(col => (
                          <th key={col} className="px-3 py-2 text-left text-[#cccccc] font-medium">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.rows.map((row, idx) => (
                        <tr key={idx} className="border-t border-[#404040]">
                          {row.map((cell, cellIdx) => (
                            <td key={cellIdx} className="px-3 py-2 text-[#cccccc]">{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                <div className="flex gap-2 p-3 border-t border-[#404040]">
                  <button 
                    className="btn btn-secondary" 
                    onClick={exportResults}
                    disabled={!queryResult?.columns || !queryResult?.rows}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Export CSV
                  </button>
                  <button className="btn btn-secondary" onClick={clearResults}>
                    Clear Results
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-[#d13438] bg-opacity-10 border border-[#d13438] rounded-lg px-4 py-4 text-[#d13438]">
                {queryResult?.message || 'Query execution failed'}
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
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
                  onChange={(e) => setProvider(e.target.value as 'lmstudio' | 'openrouter')}
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
                    onChange={(e) => setLmStudioEndpoint(e.target.value)}
                    placeholder="http://localhost:1234/api/v1/chat"
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
                      onChange={(e) => setOpenRouterEndpoint(e.target.value)}
                      placeholder="https://openrouter.ai/api/v1/chat/completions"
                    />
                    <p className="text-sm text-[#888888] mt-1">
                      Enter the OpenRouter API endpoint
                    </p>
                  </div>
                  <div className="form-group">
                    <label>OpenRouter API Key</label>
                    <input
                      type="password"
                      className="form-input"
                      value={openRouterApiKey}
                      onChange={(e) => setOpenRouterApiKey(e.target.value)}
                      placeholder="sk-or-v1-..."
                    />
                    <p className="text-sm text-[#888888] mt-1">
                      Enter your OpenRouter API key
                    </p>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={() => switchProvider('lmstudio')}
              >
                Use LM Studio
              </button>
              <button 
                className="btn btn-secondary"
                onClick={() => switchProvider('openrouter')}
              >
                Use OpenRouter
              </button>
              <button 
                className="btn btn-primary"
                onClick={handleSaveSettings}
              >
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
