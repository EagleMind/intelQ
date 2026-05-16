import type { Row, TableColumn } from '../../types/api';

export interface ExportPayload {
  columns: TableColumn[];
  rows: Row[];
  filenameBase?: string;
  tableName?: string;
}

export interface Exporter {
  format: string;
  label: string;
  extension: string;
  mimeType: string;
  serialize: (payload: ExportPayload) => string;
}
