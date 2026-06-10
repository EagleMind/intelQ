import { safeInvoke } from '../utils/tauri';
import type { Annotation } from '../types/api';

export const annotationApi = {
  save: (record: Annotation) =>
    safeInvoke<void>('annotation_save', { record }),

  getAll: (connectionId: string) =>
    safeInvoke<Annotation[]>('annotation_get_all', { connectionId }),

  delete: (id: string) =>
    safeInvoke<void>('annotation_delete', { id }),

  export: (connectionId: string, format: string, dbType: string) =>
    safeInvoke<string>('annotation_export', { connectionId, format, dbType }),

  applyNative: (record: Annotation) =>
    safeInvoke<void>('annotation_apply_native', { record }),

  fetchNative: (connectionId: string) =>
    safeInvoke<Annotation[]>('annotation_fetch_native', { connectionId }),
};
