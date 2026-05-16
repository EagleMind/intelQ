import type { Exporter } from './types';

const cellText = (v: string | null) => (v === null ? 'NULL' : v);

const escapeCell = (v: string) =>
  /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export const csvExporter: Exporter = {
  format: 'csv',
  label: 'CSV',
  extension: 'csv',
  mimeType: 'text/csv',
  serialize({ columns, rows }) {
    return [
      columns.map(c => escapeCell(c.name)).join(','),
      ...rows.map(row => row.map(c => escapeCell(cellText(c))).join(',')),
    ].join('\n');
  },
};
