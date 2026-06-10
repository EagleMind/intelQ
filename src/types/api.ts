// Shapes returned by Tauri commands. Keep in sync with src-tauri/src/lib.rs.

export interface TableColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string | null;
}

export type CellValue = string | null;
export type Row = CellValue[];

export interface QueryResult {
  success: boolean;
  columns?: TableColumn[];
  rows?: Row[];
  message?: string;
  row_count?: number;
}

export interface TableDataResponse {
  columns: TableColumn[];
  rows: Row[];
  total_rows: number;
  limit: number;
  offset: number;
}

export interface SchemaResponse {
  schema: string;
  tables: string[];
}

export interface TablesResponse {
  tables: string[];
}

export interface ConnectionResponse {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string;
  connection_id: string;
  scope: 'table' | 'column';
  table_name: string;
  column_name?: string | null;
  body: string;
  mode: 'virtual' | 'native';
  created_at: string;
  updated_at: string;
}

export function makeAnnotationId(
  connectionId: string,
  tableName: string,
  scope: 'table' | 'column',
  columnName?: string
): string {
  return `${connectionId}:${tableName}:${columnName ?? ''}:${scope}`;
}
