import type { Exporter } from './types';

const NUMERIC_RE = /\b(int|integer|bigint|smallint|tinyint|mediumint|numeric|decimal|float|double|real|number)\b/i;
const BOOL_RE = /\b(bool|boolean|bit)\b/i;
const NUMERIC_LITERAL_RE = /^-?\d+(\.\d+)?$/;

const quoteString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

const formatCell = (cell: string | null, dataType: string): string => {
  if (cell === null) return 'NULL';
  if (NUMERIC_RE.test(dataType) && NUMERIC_LITERAL_RE.test(cell)) return cell;
  if (BOOL_RE.test(dataType)) {
    if (cell === '1' || /^true$/i.test(cell)) return 'TRUE';
    if (cell === '0' || /^false$/i.test(cell)) return 'FALSE';
  }
  return quoteString(cell);
};

export const sqlExporter: Exporter = {
  format: 'sql',
  label: 'SQL',
  extension: 'sql',
  mimeType: 'application/sql',
  serialize({ columns, rows, tableName }) {
    const table = tableName?.trim() || 'query_results';
    if (rows.length === 0 || columns.length === 0) {
      return `-- No data to export\n`;
    }
    const colList = columns.map(c => quoteIdent(c.name)).join(', ');
    const valuesLines = rows.map(
      row =>
        `  (${row
          .map((cell, i) => formatCell(cell, columns[i]?.data_type ?? ''))
          .join(', ')})`
    );
    return [
      `-- Exported ${rows.length} row${rows.length === 1 ? '' : 's'} from query results`,
      `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES`,
      valuesLines.join(',\n') + ';',
      '',
    ].join('\n');
  },
};
