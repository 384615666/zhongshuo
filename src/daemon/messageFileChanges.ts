import { createHash } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { humanFacingFile, type MessageFileChange } from '../contracts/messageFileChanges.ts';
import type { SnapshotRegistered } from './generatedFileSnapshots.ts';
import { readStoredContent } from './preimage.ts';

interface FileRow { role: string; path: string; state: string; sha256: string | null; size: number | null; content_ref: string | null }
const pathKey = (value: string): string => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');

/** Read all captured differences, including removed/unsupported files and paths beyond attachment limits. */
export function capturedFileChanges(db: ZhongshuoDatabase, changeSetId: string): Array<{path: string; state: MessageFileChange['state']; before?: FileRow; after?: FileRow}> {
  const rows = db.prepare('SELECT role,path,state,sha256,size,content_ref FROM change_set_files WHERE change_set_id=? ORDER BY path,role').all(changeSetId) as FileRow[];
  const groups = new Map<string, {path: string; before?: FileRow; after?: FileRow}>();
  for (const row of rows) {
    const entry = groups.get(row.path) ?? {path: row.path};
    if (row.role === 'before') entry.before = row; else if (row.role === 'after') entry.after = row;
    groups.set(row.path, entry);
  }
  return [...groups.values()].flatMap(entry => {
    const b = entry.before, a = entry.after;
    if (!a) return [];
    if (b?.state === a.state && b.sha256 === a.sha256 && a.state !== 'unknown') return [];
    const state: MessageFileChange['state'] = !b || b.state === 'unknown' || a.state === 'unknown'
      ? 'unknown' : b.state === 'absent' && a.state === 'present' ? 'added'
        : b.state === 'present' && a.state === 'absent' ? 'removed' : 'modified';
    return [{...entry, state}];
  });
}

function textOf(row: FileRow | undefined, store: string): string | null {
  if (row?.state === 'absent') return '';
  if (!row || row.state !== 'present' || row.size == null || row.size > 256 * 1024 || !row.content_ref || row.sha256 !== row.content_ref) return null;
  const stored = readStoredContent(store, row.content_ref);
  if (!stored.ok || stored.content.length !== row.size || stored.content.includes(0)) return null;
  try { return new TextDecoder('utf-8', {fatal: true}).decode(stored.content); } catch { return null; }
}

/** Exact line counts via bounded LCS; unavailable/large/binary content has no invented counts. */
export function changedLineCounts(before: string | null, after: string | null): {added: number; removed: number} | null {
  if (before == null || after == null) return null;
  const lines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  a = a.slice(start); b = b.slice(start);
  while (a.length && b.length && a.at(-1) === b.at(-1)) { a.pop(); b.pop(); }
  if (a.length * b.length > 250000) return null;
  const dp = new Uint32Array(b.length + 1);
  for (const line of a) {
    let previous = 0;
    for (let j = 1; j <= b.length; j++) {
      const old = dp[j]!;
      dp[j] = line === b[j - 1] ? previous + 1 : Math.max(dp[j]!, dp[j - 1]!);
      previous = old;
    }
  }
  const common = dp[b.length]!;
  return {added: b.length - common, removed: a.length - common};
}

export function recordMessageFileChanges(input: {
  db: ZhongshuoDatabase; appDataDir: string; projectRoot: string; projectId: string;
  conversationId: string; taskId: string; runId: string; turnId: string; memberId: string;
  messageId: string | null; changeSetId: string | null; declaredFiles: readonly string[];
  registered: readonly SnapshotRegistered[];
}): void {
  if (!input.messageId) return;
  const m = input.db.prepare('SELECT project_id,conversation_id,task_id,author_type,author_id,body_json FROM messages WHERE id=?').get(input.messageId) as {project_id: string; conversation_id: string; task_id: string | null; author_type: string; author_id: string; body_json: string} | undefined;
  if (!m || m.project_id !== input.projectId || m.conversation_id !== input.conversationId || m.task_id !== input.taskId || m.author_type !== 'agent' || m.author_id !== input.memberId) return;
  let turnBound = input.messageId.startsWith(`msg_${input.turnId}_`);
  if (!turnBound && input.messageId.startsWith('msg_delib_')) {
    try { const stage = (JSON.parse(m.body_json) as {collaborationStage?: {turnId?: string; runId?: string}}).collaborationStage; turnBound = stage?.turnId === input.turnId && stage.runId === input.runId; } catch { /* no matching turn metadata */ }
  }
  if (!turnBound) return;
  const ownSet = input.changeSetId == null ? null : input.db.prepare('SELECT id FROM change_sets WHERE id=? AND project_id=? AND task_id=?').get(input.changeSetId, input.projectId, input.taskId);
  const changeSetId = ownSet ? input.changeSetId : null;
  const changes = changeSetId ? capturedFileChanges(input.db, changeSetId) : [];
  const changedKeys = new Set(changes.map(file => pathKey(file.path)));
  const identity = (file: string): string => {
    const absolute = resolve(input.projectRoot, file);
    const rel = relative(input.projectRoot, absolute);
    return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel)) ? rel.replaceAll('\\', '/') : absolute;
  };
  const declared = new Set(input.declaredFiles.map(file => pathKey(identity(file))));
  const registered = new Map(input.registered.map(file => [pathKey(file.sourcePath), file]));
  const candidates = new Map(changes.map(file => [pathKey(file.path), file]));
  for (const file of input.registered) if (!candidates.has(pathKey(file.sourcePath))) candidates.set(pathKey(file.sourcePath), {path: file.sourcePath, state: 'unknown'});
  const insert = input.db.prepare(`INSERT INTO message_file_changes
    (id,project_id,conversation_id,message_id,task_id,run_id,turn_id,change_set_id,path,display_name,state,source,declared,human_facing,before_sha256,after_sha256,size_bytes,added_lines,removed_lines,artifact_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,path) DO NOTHING`);
  input.db.transaction(() => {
    for (const [key, file] of candidates) {
      const artifact = registered.get(key);
      const fromDiff = changedKeys.has(key);
      const isDeclared = declared.has(key);
      const counts = file.state !== 'unknown' ? changedLineCounts(textOf(file.before, join(input.appDataDir, 'preimages', input.projectId)), textOf(file.after, join(input.appDataDir, 'preimages', input.projectId))) : null;
      const id = `mfc_${createHash('sha256').update(`${input.messageId}\0${key}`).digest('hex').slice(0, 24)}`;
      insert.run(id, input.projectId, input.conversationId, input.messageId, input.taskId, input.runId, input.turnId, changeSetId, file.path, basename(file.path), file.state,
        isDeclared ? (fromDiff ? 'declared+diff' : 'declared') : 'diff', Number(isDeclared), Number(humanFacingFile(file.path, isDeclared)),
        file.before?.sha256 ?? null, file.after?.sha256 ?? artifact?.hash ?? null, file.after?.size ?? artifact?.sizeBytes ?? null,
        counts?.added ?? null, counts?.removed ?? null, artifact && (!file.after?.sha256 || file.after.sha256 === artifact.hash) ? artifact.artifactId : null, Date.now());
    }
  })();
}

export function messageFileChanges(db: ZhongshuoDatabase, messageIds: readonly string[]): Map<string, MessageFileChange[]> {
  const result = new Map<string, MessageFileChange[]>();
  if (!messageIds.length) return result;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_file_changes'").get()) return result;
  const rows = db.prepare(`SELECT f.*,a.revision,COALESCE(t.status,'UNKNOWN') execution_status FROM message_file_changes f
    LEFT JOIN artifacts a ON a.id=f.artifact_id LEFT JOIN agent_turns t ON t.id=f.turn_id
    WHERE f.message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY f.human_facing DESC,f.created_at,f.path`).all(...messageIds) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const item: MessageFileChange = {id: r.id as string, projectId: r.project_id as string, conversationId: r.conversation_id as string, taskId: r.task_id as string, changeSetId: r.change_set_id as string | null,
      path: r.path as string, displayName: r.display_name as string, state: r.state as MessageFileChange['state'], declared: r.declared === 1, humanFacing: r.human_facing === 1,
      artifactId: r.artifact_id as string | null, revision: r.revision as number | null, sizeBytes: r.size_bytes as number | null, addedLines: r.added_lines as number | null,
      removedLines: r.removed_lines as number | null, beforeHash: r.before_sha256 as string | null, afterHash: r.after_sha256 as string | null, executionStatus: r.execution_status as string, createdAt: r.created_at as number};
    const list = result.get(r.message_id as string) ?? []; list.push(item); result.set(r.message_id as string, list);
  }
  return result;
}
