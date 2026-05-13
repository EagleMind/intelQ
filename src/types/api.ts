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
