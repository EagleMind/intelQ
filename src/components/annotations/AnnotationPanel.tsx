import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, RefreshCw, FileText, Tag } from 'lucide-react';
import { useAnnotations } from '../../store/AnnotationContext';
import { useDb } from '../../store/DbContext';
import AnnotationEditor from './AnnotationEditor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseColumnsFromSchema(schema: string, tableName: string): string[] {
  const lines = schema.split('\n');
  let inTable = false;
  const cols: string[] = [];
  for (const line of lines) {
    if (line.startsWith(`Table: ${tableName}`)) { inTable = true; continue; }
    if (inTable) {
      if (line.startsWith('Table:')) break;
      const m = line.match(/^\s+-\s+(\S+)/);
      if (m) cols.push(m[1]);
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Export dialog (inlined — no extra file)
// ---------------------------------------------------------------------------

const FORMATS = [
  { id: 'json',     label: 'JSON',     note: 'Full backup, re-importable'         },
  { id: 'sql',      label: 'SQL',      note: 'Ready to run on your database'      },
  { id: 'markdown', label: 'Markdown', note: 'Readable doc for your team'         },
  { id: 'csv',      label: 'CSV',      note: 'Open in Excel or Google Sheets'     },
] as const;

type ExportFormat = (typeof FORMATS)[number]['id'];

const ExportPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { exportAnnotations } = useAnnotations();
  const [format, setFormat] = useState<ExportFormat>('json');
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    exportAnnotations(format).then(text => {
      if (!cancelled) { setPreview(text); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [format, exportAnnotations]);

  const handleDownload = () => {
    const ext = format === 'markdown' ? 'md' : format;
    const blob = new Blob([preview], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(preview).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex gap-2 flex-wrap">
        {FORMATS.map(f => (
          <button
            key={f.id}
            className={`px-3 py-2 rounded text-sm border transition-colors ${
              format === f.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-foreground border-border hover:border-primary/50'
            }`}
            onClick={() => setFormat(f.id)}
          >
            <div className="font-semibold">{f.label}</div>
            <div className="text-xs opacity-60">{f.note}</div>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Generating…
          </div>
        ) : (
          <pre className="text-xs font-mono bg-muted/30 border border-border rounded p-3 whitespace-pre-wrap break-all h-full overflow-auto">
            {preview || '— no annotations yet —'}
          </pre>
        )}
      </div>

      <div className="flex gap-2 justify-end border-t border-border pt-3">
        <button className="btn btn-secondary btn-sm" onClick={onClose}>
          Back
        </button>
        <button className="btn btn-secondary btn-sm" onClick={handleCopy} disabled={!preview}>
          Copy
        </button>
        <button className="btn btn-primary btn-sm" onClick={handleDownload} disabled={!preview}>
          <Download className="w-3 h-3 mr-1" />
          Download
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Column row
// ---------------------------------------------------------------------------

const ColumnRow: React.FC<{ tableName: string; columnName: string }> = ({
  tableName,
  columnName,
}) => {
  const { columnAnnotation } = useAnnotations();
  const [expanded, setExpanded] = useState(false);
  const existing = columnAnnotation(tableName, columnName);

  return (
    <div className="border-b border-border last:border-0">
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 cursor-pointer"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-xs font-mono text-foreground flex-1">{columnName}</span>
        {existing ? (
          <span className="text-xs text-muted-foreground truncate max-w-[180px]">
            {existing.body}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/40 italic">no annotation yet</span>
        )}
        <span className="text-xs text-muted-foreground">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-muted/10">
          <AnnotationEditor
            tableName={tableName}
            scope="column"
            columnName={columnName}
            onSaved={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

const AnnotationPanel: React.FC = () => {
  const { status, tables, schema } = useDb();
  const {
    tablesWithAnnotations,
    mode,
    setMode,
    fetchNative,
    nativeUnsupportedReason,
    isPanelOpen,
    panelTable,
    closePanel,
  } = useAnnotations();

  const [selectedTable, setSelectedTable] = useState<string | undefined>(panelTable);
  const [tableSearch, setTableSearch] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync initial table selection from context.
  useEffect(() => {
    if (isPanelOpen) setSelectedTable(panelTable ?? tables[0]);
  }, [isPanelOpen, panelTable, tables]);

  const filteredTables = useMemo(
    () =>
      tables.filter(t =>
        tableSearch ? t.toLowerCase().includes(tableSearch.toLowerCase()) : true
      ),
    [tables, tableSearch]
  );

  const columns = useMemo(
    () => (selectedTable ? parseColumnsFromSchema(schema, selectedTable) : []),
    [schema, selectedTable]
  );

  const handleFetchNative = useCallback(async () => {
    setFetchStatus('Fetching…');
    try {
      const { imported } = await fetchNative();
      setFetchStatus(`Imported ${imported} annotation${imported !== 1 ? 's' : ''} from DB`);
      setTimeout(() => setFetchStatus(null), 3000);
    } catch (e) {
      setFetchStatus(`Error: ${e}`);
    }
  }, [fetchNative]);

  if (!isPanelOpen) return null;

  return (
    <div className="modal-overlay" onClick={closePanel}>
      <div
        ref={panelRef}
        className="modal"
        style={{ maxWidth: '860px', width: '92vw', height: '82vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <Tag className="w-5 h-5 text-primary" />
              <h3>Database Annotations</h3>
              {status.connectionName && (
                <span className="text-sm text-muted-foreground">— {status.connectionName}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowExport(v => !v)}
                title="Export annotations"
              >
                <Download className="w-3 h-3 mr-1" />
                Export
              </button>
              <button className="modal-close" onClick={closePanel}>×</button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground" style={{ marginLeft: '28px' }}>
            Add plain-language descriptions to your tables and columns — what they store, what the values mean, and any business rules worth remembering. Annotations stay with your connection and help you (and the AI) understand your data at a glance.
          </p>
        </div>

        {/* Mode selector */}
        <div className="px-4 py-3 border-b border-border bg-muted/20">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground mb-2">Where should annotations be saved?</p>
              <div className="flex gap-2">
                {/* Option A — Local annotations */}
                <button
                  className={`flex-1 text-left px-3 py-2 rounded border text-xs transition-colors ${
                    mode === 'virtual'
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-card hover:border-muted-foreground'
                  }`}
                  onClick={() => setMode('virtual')}
                >
                  <div className="flex items-center gap-1.5 font-semibold text-foreground mb-0.5">
                    {mode === 'virtual' && <span className="text-primary text-sm">✓</span>}
                    📝 Local annotations
                  </div>
                  <p className="text-muted-foreground leading-snug">
                    Stored in IntelQuery only. Your database is never changed.
                  </p>
                </button>

                {/* Option B — Write to database */}
                <button
                  className={`flex-1 text-left px-3 py-2 rounded border text-xs transition-colors ${
                    nativeUnsupportedReason
                      ? 'border-border bg-card opacity-50 cursor-not-allowed'
                      : mode === 'native'
                      ? 'border-warning bg-warning/5'
                      : 'border-border bg-card hover:border-muted-foreground'
                  }`}
                  onClick={() => !nativeUnsupportedReason && setMode('native')}
                  disabled={!!nativeUnsupportedReason}
                >
                  <div className="flex items-center gap-1.5 font-semibold text-foreground mb-0.5">
                    {mode === 'native' && <span className="text-warning text-sm">✓</span>}
                    🏷️ Write to database
                  </div>
                  <p className="text-muted-foreground leading-snug">
                    {nativeUnsupportedReason
                      ? nativeUnsupportedReason
                      : 'Annotations are saved inside your database and visible to everyone.'}
                  </p>
                </button>
              </div>
            </div>

            {/* Import existing descriptions button */}
            {!nativeUnsupportedReason && (
              <div className="flex flex-col items-end gap-1 shrink-0 mt-5">
                <button
                  className="btn btn-secondary btn-sm whitespace-nowrap"
                  onClick={handleFetchNative}
                  title="Read descriptions already stored in your database and bring them into IntelQuery"
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Import existing
                </button>
                {fetchStatus && (
                  <span className="text-xs text-muted-foreground">{fetchStatus}</span>
                )}
              </div>
            )}
          </div>

          {/* Warning banner — shown only when write-to-database mode is active */}
          {mode === 'native' && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-warning/10 border border-warning/40 rounded text-xs">
              <span className="text-warning text-base leading-none mt-0.5">⚠</span>
              <div className="text-foreground">
                <span className="font-semibold">This will modify your database directly.</span>
                {' '}When you save a note here, it writes a description field into your database
                schema. This is a permanent change that requires write access to the database,
                and will be visible to anyone connected to it.
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left — table list */}
          <div className="w-52 shrink-0 border-r border-border flex flex-col">
            <div className="p-2 border-b border-border">
              <input
                type="text"
                className="search-input text-xs w-full"
                placeholder="Search tables…"
                value={tableSearch}
                onChange={e => setTableSearch(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {filteredTables.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-6">
                  {tables.length === 0 ? 'No tables found' : 'No match'}
                </div>
              )}
              {filteredTables.map(t => (
                <div
                  key={t}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${
                    t === selectedTable
                      ? 'bg-primary/10 text-primary border-r-2 border-primary'
                      : 'hover:bg-accent text-foreground'
                  }`}
                  onClick={() => { setSelectedTable(t); setShowExport(false); }}
                >
                  <span className="flex-1 truncate">{t}</span>
                  {tablesWithAnnotations.has(t) && (
                    <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right — editor */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {showExport ? (
              <div className="flex-1 p-4 flex flex-col overflow-hidden">
                <ExportPanel onClose={() => setShowExport(false)} />
              </div>
            ) : selectedTable ? (
              <>
                {/* Table annotation */}
                <div className="p-4 border-b border-border">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">{selectedTable}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                      table
                    </span>
                  </div>
                  <AnnotationEditor tableName={selectedTable} scope="table" />
                </div>

                {/* Column list */}
                <div className="flex-1 overflow-y-auto">
                  <div className="px-3 py-2 text-xs text-muted-foreground font-medium border-b border-border bg-muted/10 sticky top-0">
                    Columns ({columns.length})
                  </div>
                  {columns.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-8">
                      No columns found — connect to a database first
                    </div>
                  ) : (
                    columns.map(col => (
                      <ColumnRow key={col} tableName={selectedTable} columnName={col} />
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Select a table to annotate
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnnotationPanel;
