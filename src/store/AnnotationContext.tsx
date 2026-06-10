import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { annotationApi } from '../services/annotations';
import { useDb } from './DbContext';
import type { Annotation } from '../types/api';
import { makeAnnotationId } from '../types/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnnotationMode = 'virtual' | 'native';

interface AnnotationContextValue {
  // Data
  annotations: Map<string, Annotation>;
  tablesWithAnnotations: Set<string>;
  tableAnnotation: (tableName: string) => Annotation | undefined;
  columnAnnotation: (tableName: string, columnName: string) => Annotation | undefined;
  annotationsForTable: (tableName: string) => Annotation[];

  // Operations
  mode: AnnotationMode;
  setMode: (m: AnnotationMode) => void;
  saving: boolean;
  save: (
    tableName: string,
    scope: 'table' | 'column',
    body: string,
    columnName?: string
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportAnnotations: (format: string) => Promise<string>;
  fetchNative: () => Promise<{ imported: number }>;
  refresh: () => Promise<void>;
  nativeUnsupportedReason: string | null;

  // Panel state
  isPanelOpen: boolean;
  panelTable: string | undefined;
  openPanel: (tableName?: string) => void;
  closePanel: () => void;
}

const Ctx = createContext<AnnotationContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const AnnotationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status } = useDb();
  const connectionId = status.connectionId;
  const dbType = status.connectionDbType ?? '';

  const [annotations, setAnnotations] = useState<Map<string, Annotation>>(new Map());
  const [mode, setMode] = useState<AnnotationMode>('virtual');
  const [saving, setSaving] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [panelTable, setPanelTable] = useState<string | undefined>(undefined);

  // Track which connection's annotations are loaded to avoid stale cache.
  const loadedForRef = useRef<string | undefined>(undefined);

  const nativeUnsupportedReason = useMemo((): string | null => {
    if (!status.connected) return 'No active connection';
    if (dbType === 'sqlite') return "SQLite doesn't support saving annotations directly in the database — use Local annotations instead";
    return null;
  }, [status.connected, dbType]);

  // ---------------------------------------------------------------------------
  // Load annotations whenever the active connection changes.
  // ---------------------------------------------------------------------------
  const load = useCallback(async (connId: string) => {
    try {
      const records = await annotationApi.getAll(connId);
      const map = new Map<string, Annotation>();
      for (const r of records) map.set(r.id, r);
      setAnnotations(map);
      loadedForRef.current = connId;
    } catch (e) {
      console.warn('Failed to load annotations', e);
    }
  }, []);

  useEffect(() => {
    if (connectionId && connectionId !== loadedForRef.current) {
      load(connectionId);
    } else if (!connectionId) {
      setAnnotations(new Map());
      loadedForRef.current = undefined;
    }
  }, [connectionId, load]);

  // ---------------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------------

  const tablesWithAnnotations = useMemo(() => {
    const s = new Set<string>();
    for (const ann of annotations.values()) s.add(ann.table_name);
    return s;
  }, [annotations]);

  const tableAnnotation = useCallback(
    (tableName: string) => {
      if (!connectionId) return undefined;
      const id = makeAnnotationId(connectionId, tableName, 'table');
      return annotations.get(id);
    },
    [annotations, connectionId]
  );

  const columnAnnotation = useCallback(
    (tableName: string, columnName: string) => {
      if (!connectionId) return undefined;
      const id = makeAnnotationId(connectionId, tableName, 'column', columnName);
      return annotations.get(id);
    },
    [annotations, connectionId]
  );

  const annotationsForTable = useCallback(
    (tableName: string) =>
      Array.from(annotations.values()).filter(a => a.table_name === tableName),
    [annotations]
  );

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  const save = useCallback(
    async (
      tableName: string,
      scope: 'table' | 'column',
      body: string,
      columnName?: string
    ) => {
      if (!connectionId) return;
      setSaving(true);
      try {
        const id = makeAnnotationId(connectionId, tableName, scope, columnName);
        const record: Annotation = {
          id,
          connection_id: connectionId,
          scope,
          table_name: tableName,
          column_name: columnName ?? null,
          body,
          mode,
          created_at: '',
          updated_at: '',
        };

        await annotationApi.save(record);

        // If native mode is active and the DB supports it, also write the COMMENT.
        if (mode === 'native' && !nativeUnsupportedReason) {
          await annotationApi.applyNative(record);
        }

        // Update local cache optimistically.
        setAnnotations(prev => {
          const next = new Map(prev);
          next.set(id, { ...record, updated_at: new Date().toISOString() });
          return next;
        });
      } finally {
        setSaving(false);
      }
    },
    [connectionId, mode, nativeUnsupportedReason]
  );

  const remove = useCallback(
    async (id: string) => {
      await annotationApi.delete(id);
      setAnnotations(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    },
    []
  );

  const exportAnnotations = useCallback(
    async (format: string) => {
      if (!connectionId) return '';
      return annotationApi.export(connectionId, format, dbType);
    },
    [connectionId, dbType]
  );

  const fetchNative = useCallback(async () => {
    if (!connectionId) return { imported: 0 };
    const fetched = await annotationApi.fetchNative(connectionId);
    let imported = 0;
    for (const record of fetched) {
      await annotationApi.save(record);
      setAnnotations(prev => {
        const next = new Map(prev);
        next.set(record.id, record);
        return next;
      });
      imported++;
    }
    return { imported };
  }, [connectionId]);

  const refresh = useCallback(async () => {
    if (connectionId) await load(connectionId);
  }, [connectionId, load]);

  // ---------------------------------------------------------------------------
  // Panel state
  // ---------------------------------------------------------------------------

  const openPanel = useCallback((tableName?: string) => {
    setPanelTable(tableName);
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setIsPanelOpen(false);
  }, []);

  const value = useMemo<AnnotationContextValue>(
    () => ({
      annotations,
      tablesWithAnnotations,
      tableAnnotation,
      columnAnnotation,
      annotationsForTable,
      mode,
      setMode,
      saving,
      save,
      remove,
      exportAnnotations,
      fetchNative,
      refresh,
      nativeUnsupportedReason,
      isPanelOpen,
      panelTable,
      openPanel,
      closePanel,
    }),
    [
      annotations,
      tablesWithAnnotations,
      tableAnnotation,
      columnAnnotation,
      annotationsForTable,
      mode,
      saving,
      save,
      remove,
      exportAnnotations,
      fetchNative,
      refresh,
      nativeUnsupportedReason,
      isPanelOpen,
      panelTable,
      openPanel,
      closePanel,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useAnnotations = (): AnnotationContextValue => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnnotations must be used inside <AnnotationProvider>');
  return ctx;
};
