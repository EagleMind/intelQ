import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../services/api';

interface DbStatus {
  connected: boolean;
  connectionName?: string;
}

interface DbContextValue {
  status: DbStatus;
  tables: string[];
  schema: string;
  statusMessage: string;
  isLoading: boolean;
  readOnlyLock: boolean;
  setStatusMessage: (m: string) => void;
  setLoading: (b: boolean) => void;
  setReadOnlyLock: (b: boolean) => void;
  markConnected: (name?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshSchema: () => Promise<void>;
}

const Ctx = createContext<DbContextValue | null>(null);

export const DbProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<DbStatus>({ connected: false });
  const [tables, setTables] = useState<string[]>([]);
  const [schema, setSchema] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [readOnlyLock, setReadOnlyLockState] = useState<boolean>(true);

  const loadCountRef = useRef(0);
  const setLoading = useCallback((b: boolean) => {
    loadCountRef.current = Math.max(0, loadCountRef.current + (b ? 1 : -1));
    setIsLoading(loadCountRef.current > 0);
  }, []);

  // Load read-only lock from storage on mount.
  useEffect(() => {
    const raw = localStorage.getItem('readOnlyLock');
    setReadOnlyLockState(raw === null ? true : raw === 'true');
  }, []);

  const setReadOnlyLock = useCallback((b: boolean) => {
    setReadOnlyLockState(b);
    localStorage.setItem('readOnlyLock', b.toString());
  }, []);

  const loadSchemaAndTables = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.getSchema();
      setSchema(resp.schema || '');
      setTables(resp.tables || []);
    } catch (e) {
      setStatusMessage(`Schema load failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [setLoading]);

  const markConnected = useCallback(
    async (name?: string) => {
      setStatus({ connected: true, connectionName: name });
      await loadSchemaAndTables();
    },
    [loadSchemaAndTables]
  );

  const disconnect = useCallback(async () => {
    try {
      await api.disconnect();
    } catch {
      // ignore
    }
    setStatus({ connected: false });
    setTables([]);
    setSchema('');
  }, []);

  const refreshSchema = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.refreshSchema();
      setSchema(resp.schema || '');
      setTables(resp.tables || []);
      setStatusMessage('Schema refreshed');
    } catch (e) {
      setStatusMessage(`Schema refresh failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [setLoading]);

  // On mount: probe whether the backend still has a live connection.
  useEffect(() => {
    (async () => {
      try {
        const resp = await api.status();
        if (resp.success) {
          await markConnected();
        }
      } catch {
        // ignore — backend not ready or no connection
      }
    })();
  }, [markConnected]);

  const value = useMemo<DbContextValue>(
    () => ({
      status,
      tables,
      schema,
      statusMessage,
      isLoading,
      readOnlyLock,
      setStatusMessage,
      setLoading,
      setReadOnlyLock,
      markConnected,
      disconnect,
      refreshSchema,
    }),
    [
      status,
      tables,
      schema,
      statusMessage,
      isLoading,
      readOnlyLock,
      setLoading,
      setReadOnlyLock,
      markConnected,
      disconnect,
      refreshSchema,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useDb = (): DbContextValue => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDb must be used inside <DbProvider>');
  return ctx;
};
