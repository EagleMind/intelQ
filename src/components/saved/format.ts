import type { SavedQuestion } from '../../types/api';

/** SQLite `datetime('now')` is UTC "YYYY-MM-DD HH:MM:SS". */
function parseSqliteUtc(s: string): Date | null {
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeAgo(s: string | null): string | null {
  if (!s) return null;
  const d = parseSqliteUtc(s);
  if (!d) return null;
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  const days = Math.floor(sec / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
}

/** "ran 12× · last run 3 days ago" / "saved 2 h ago, not re-run yet". */
export function usageLine(q: SavedQuestion): string {
  if (!q.sql.trim()) return 'question only, no SQL yet';
  if (q.run_count === 0) {
    const saved = timeAgo(q.created_at);
    return saved ? `saved ${saved}, not re-run yet` : 'not re-run yet';
  }
  const last = timeAgo(q.last_run_at);
  return `ran ${q.run_count}×${last ? ` · last run ${last}` : ''}`;
}

export const SOURCE_LABEL: Record<SavedQuestion['source'], string> = {
  ai: 'AI draft',
  edited: 'Edited draft',
  manual: 'Your SQL',
};
