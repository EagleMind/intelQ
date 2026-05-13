import { safeInvoke } from '../utils/tauri';
import type {
  ConnectionResponse,
  QueryResult,
  SchemaResponse,
  TableDataResponse,
  TablesResponse,
} from '../types/api';

export interface ConnectArgs {
  dbType: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export const api = {
  connect: (args: ConnectArgs) => safeInvoke<ConnectionResponse>('connect_database', args),
  disconnect: () => safeInvoke<ConnectionResponse>('disconnect_database'),
  status: () => safeInvoke<ConnectionResponse>('get_database_status'),
  getTables: () => safeInvoke<TablesResponse>('get_tables'),
  getSchema: () => safeInvoke<SchemaResponse>('get_schema'),
  refreshSchema: () => safeInvoke<SchemaResponse>('refresh_schema'),
  getFilteredSchema: (tables: string[]) =>
    safeInvoke<string>('get_filtered_schema', { tables }),
  execute: (sql_query: string) =>
    safeInvoke<QueryResult>('execute_query', { request: { sql_query } }),
  getTableData: (tableName: string, limit: number, offset: number) =>
    safeInvoke<TableDataResponse>('get_table_data', { tableName, limit, offset }),

  credentialSet: (account: string, secret: string) =>
    safeInvoke<void>('credential_set', { account, secret }),
  credentialGet: (account: string) =>
    safeInvoke<string | null>('credential_get', { account }),
  credentialDelete: (account: string) =>
    safeInvoke<void>('credential_delete', { account }),
};
