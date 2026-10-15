import type { GitStatusEntry } from './types';

/** Index and worktree are distinct readable versions of the same path. */
export const gitEntryKey = (entry: Pick<GitStatusEntry, 'path' | 'staged'>): string => JSON.stringify([entry.path, entry.staged]);
export function selectedGitEntry(entries: GitStatusEntry[], key: string | null): GitStatusEntry | null {
  let previousPath: string | undefined;
  try { const parts: unknown = JSON.parse(key ?? 'null'); if (Array.isArray(parts) && typeof parts[0] === 'string' && typeof parts[1] === 'boolean') previousPath = parts[0]; } catch { /* A different Git tab uses commit/branch identifiers. */ }
  return entries.find(e => gitEntryKey(e) === key)
    ?? entries.find(e => e.path === previousPath)
    ?? entries.find(e => e.state === 'conflicted')
    ?? entries.find(e => !e.staged && !e.userPreExisting)
    ?? entries.find(e => e.staged)
    ?? entries[0]
    ?? null;
}
