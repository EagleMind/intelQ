import type { Exporter } from './types';

export const jsonExporter: Exporter = {
  format: 'json',
  label: 'JSON',
  extension: 'json',
  mimeType: 'application/json',
  serialize({ columns, rows }) {
    const data = rows.map(row => {
      const obj: Record<string, string | null> = {};
      columns.forEach((c, i) => {
        obj[c.name] = row[i] ?? null;
      });
      return obj;
    });
    return JSON.stringify(data, null, 2);
  },
};
