import { csvExporter } from './csv';
import { jsonExporter } from './json';
import { sqlExporter } from './sql';
import { triggerDownload } from './download';
import type { Exporter, ExportPayload } from './types';

const registry: Exporter[] = [csvExporter, jsonExporter, sqlExporter];

export const availableExporters = (): Exporter[] => registry.slice();

export function exportAs(format: string, payload: ExportPayload): boolean {
  const exporter = registry.find(e => e.format === format);
  if (!exporter) return false;
  const content = exporter.serialize(payload);
  const base = payload.filenameBase?.trim() || 'query_results';
  triggerDownload(content, `${base}.${exporter.extension}`, exporter.mimeType);
  return true;
}

export type { Exporter, ExportPayload } from './types';
