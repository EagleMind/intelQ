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
import { sync } from '../services/sync';

interface DbStatus {
  connected: boolean;
  connectionName?: string;
  connectionId?: string;
  connectionDbType?: string;
}

interface DbContextValue {
  status: DbStatus;
  tables: string[];
  schema: string;
  statusMessage: string;
  isLoading: boolean;
  /** True until the initial backend connection probe resolves. */
  initializing: boolean;
  readOnlyLock: boolean;
  setStatusMessage: (m: string) => void;
  setLoading: (b: boolean) => void;
  setReadOnlyLock: (b: boolean) => void;
  markConnected: (name?: string, id?: string, dbType?: string) => Promise<void>;
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
  const [initializing, setInitializing] = useState<boolean>(true);
  const [readOnlyLock, setReadOnlyLockState] = useState<boolean>(true);

  const loadCountRef = useRef(0);
  const setLoading = useCallback((b: boolean) => {
    loadCountRef.current = Math.max(0, loadCountRef.current + (b ? 1 : -1));
    setIsLoading(loadCountRef.current > 0);
  }, []);

  // Load read-only lock from the local SQLite store on mount, migrating any
  // legacy localStorage value.
  useEffect(() => {
    (async () => {
      const legacy = localStorage.getItem('readOnlyLock');
      if (legacy !== null) {
        try {
          if ((await sync.getSetting('readOnlyLock')) === null) {
            await sync.setSetting('readOnlyLock', legacy);
          }
        } catch {
          // ignore
        }
        localStorage.removeItem('readOnlyLock');
      }
      try {
        const raw = await sync.getSetting('readOnlyLock');
        setReadOnlyLockState(raw === null ? true : raw === 'true');
      } catch {
        setReadOnlyLockState(true);
      }
    })();
  }, []);

  const setReadOnlyLock = useCallback((b: boolean) => {
    setReadOnlyLockState(b);
    sync.setSetting('readOnlyLock', b.toString()).catch(() => {
      // best-effort persistence
    });
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
    async (name?: string, id?: string, dbType?: string) => {
      setStatus({ connected: true, connectionName: name, connectionId: id, connectionDbType: dbType });
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
    setStatus({ connected: false, connectionId: undefined, connectionDbType: undefined });
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
      } finally {
        setInitializing(false);
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
      initializing,
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
      initializing,
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
