import { resolveClaudeConfiguration } from '../adapter/claude/configuration.ts';
import { resolveCodexDefaultMetadata } from '../adapter/codex/configuration.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { bindMemberRuntime, memberExecutableStatus, type TemplateConfig } from './memberManagement.ts';

export type DefaultMemberCandidate = {
  kind: 'claude' | 'codex';
  displayName: string;
  config: TemplateConfig;
  reason: string | null;
};

export type DefaultMemberResult = {
  created: Array<{ memberId: string; kind: 'claude' | 'codex'; displayName: string }>;
  existing: Array<{ memberId: string; kind: 'claude' | 'codex'; displayName: string }>;
  skipped: Array<{ kind: 'claude' | 'codex'; reason: string }>;
  removedLegacyPlaceholder: boolean;
};

const modelId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const model = value.trim().replace(/\[[^\]]+\]$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(model) && !model.startsWith('sk-') ? model : null;
};

/** Read only the effective local defaults. No credential, thread, task or prompt is returned. */
export function discoverLocalMemberDefaults(cwd: string): { candidates: DefaultMemberCandidate[]; notes: string[] } {
  const candidates: DefaultMemberCandidate[] = [];
  const notes: string[] = [];

  const claude = resolveClaudeConfiguration(cwd);
  const claudeModel = [
    process.env.ZS_CLAUDE_MODEL,
    claude.restrictedEnv.ANTHROPIC_MODEL,
    claude.configuredModel,
    claude.restrictedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
    claude.restrictedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
    claude.restrictedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ].map(modelId).find((value): value is string => value != null) ?? null;
  const claudeProgram = memberExecutableStatus('claude', 'claude');
  if (claudeModel == null) notes.push('Claude 本机配置未声明可识别的默认模型');
  else if (claudeProgram.status === 'missing') notes.push('Claude 本机配置存在，但没有找到可执行程序');
  else candidates.push({
    kind: 'claude',
    displayName: 'Claude',
    config: { kind: 'claude', model: claudeModel, executable: 'claude', permissionMode: 'bypassPermissions', effort: null },
    reason: claude.reason,
  });

  const codex = resolveCodexDefaultMetadata(cwd);
  const codexProgram = memberExecutableStatus('codex', 'codex');
  if (codex.model == null) notes.push(codex.reason ?? 'Codex 本机配置未声明可识别的默认模型');
  else if (codexProgram.status === 'missing') notes.push('Codex 本机配置存在，但没有找到可执行程序');
  else candidates.push({
    kind: 'codex',
    displayName: 'Codex',
    config: { kind: 'codex', model: codex.model, executable: 'codex', permissionMode: 'bypassPermissions', effort: codex.effort },
    reason: codex.reason,
  });

  return { candidates, notes };
}

function existingKindMember(db: ZhongshuoDatabase, projectId: string, kind: 'claude' | 'codex', displayName: string) {
  return db.prepare(`SELECT pm.id, pm.display_name
    FROM project_members pm
    LEFT JOIN agent_profiles ap ON ap.id=pm.profile_id
    LEFT JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id
    WHERE pm.project_id=? AND pm.principal_type='agent'
      AND (ri.kind=? OR lower(pm.display_name)=lower(?))
    ORDER BY pm.id LIMIT 1`).get(projectId, kind, displayName) as { id: string; display_name: string } | undefined;
}

/** A bootstrap placeholder may only disappear when no durable identity/history row points at it.
 * Room membership is deliberately excluded because bootstrap owns that relation; DM participation
 * and every task/turn/history reference are included so links cannot disappear from the UI. */
function hasDurableMemberReferences(db: ZhongshuoDatabase, memberId: string): boolean {
  const singleReferences = [
    'SELECT 1 FROM messages WHERE author_id=? LIMIT 1',
    'SELECT 1 FROM tasks WHERE owner_member_id=? LIMIT 1',
    "SELECT 1 FROM dm_participants WHERE principal_type='agent' AND principal_id=? LIMIT 1",
    'SELECT 1 FROM conversation_members WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM run_participants WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM agent_turns WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM runtime_sessions WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM runtime_process_registry WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM real_calls WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM thread_agent_followers WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM reminders WHERE owner_member_id=? LIMIT 1',
    'SELECT 1 FROM thread_reply_requests WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM conversation_reply_requests WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM positions WHERE member_id=? LIMIT 1',
    'SELECT 1 FROM ratification_records WHERE member_id=? LIMIT 1',
  ];
  if (singleReferences.some((sql) => db.prepare(sql).get(memberId) != null)) return true;
  return db.prepare('SELECT 1 FROM coordination_messages WHERE source_member_id=? OR target_member_id=? LIMIT 1')
    .get(memberId, memberId) != null;
}

/** Stable IDs plus an immediate transaction make reopen and concurrent calls duplicate-free.
 * Existing members are never renamed, rebound, enabled or removed. */
export function ensureDefaultMembers(db: ZhongshuoDatabase, projectId: string, candidates: DefaultMemberCandidate[], transaction = true): DefaultMemberResult {
  const result: DefaultMemberResult = { created: [], existing: [], skipped: [], removedLegacyPlaceholder: false };
  const project = db.prepare('SELECT status FROM projects WHERE id=?').get(projectId) as { status: string } | undefined;
  if (project == null || project.status !== 'active') {
    for (const candidate of candidates) result.skipped.push({ kind: candidate.kind, reason: '项目不存在或不可编辑' });
    return result;
  }
  const execute = (): void => {
    const usable = candidates.filter((candidate) => {
      if (candidate.config.kind !== candidate.kind || candidate.config.model == null) {
        result.skipped.push({ kind: candidate.kind, reason: '本机默认配置不完整' });
        return false;
      }
      if (candidate.reason != null) {
        result.skipped.push({ kind: candidate.kind, reason: candidate.reason });
        return false;
      }
      if (process.env.ZS_REAL_DISPATCH_GUARD === '1') {
        result.skipped.push({ kind: candidate.kind, reason: '真实派发防护已开启，未自动创建真实渠道成员' });
        return false;
      }
      return true;
    });
    for (const candidate of usable) {
      const existing = existingKindMember(db, projectId, candidate.kind, candidate.displayName);
      if (existing != null) {
        result.existing.push({ memberId: existing.id, kind: candidate.kind, displayName: existing.display_name });
        continue;
      }
      const memberId = `m_default_${candidate.kind}_${projectId}`;
      const inserted = db.prepare(`INSERT OR IGNORE INTO project_members
        (id, project_id, display_name, description, principal_type, enabled)
        VALUES (?, ?, ?, ?, 'agent', 1)`)
        .run(memberId, projectId, candidate.displayName, '由本机默认配置自动添加，可随时修改').changes;
      if (inserted === 0) {
        const owner = db.prepare('SELECT project_id FROM project_members WHERE id=?').get(memberId) as { project_id: string } | undefined;
        if (owner?.project_id === projectId) {
          result.existing.push({ memberId, kind: candidate.kind, displayName: candidate.displayName });
          continue;
        }
        result.skipped.push({ kind: candidate.kind, reason: '稳定成员标识已被占用' });
        continue;
      }
      bindMemberRuntime(db, memberId, candidate.config);
      db.prepare(`INSERT OR IGNORE INTO room_members (room_id, member_id)
        SELECT id, ? FROM rooms WHERE project_id=? AND archived_at IS NULL`).run(memberId, projectId);
      result.created.push({ memberId, kind: candidate.kind, displayName: candidate.displayName });
    }

    const kinds = new Set([...result.created.map((item) => item.kind), ...result.existing.map((item) => item.kind)]);
    if (kinds.has('claude') && kinds.has('codex')) {
      const placeholderId = `m_default_${projectId}_0`;
      const placeholder = db.prepare(`SELECT id,description,settings_revision FROM project_members
        WHERE id=? AND project_id=? AND principal_type='agent' AND profile_id IS NULL AND display_name='执行成员'`)
        .get(placeholderId, projectId) as { id: string; description: string | null; settings_revision: number } | undefined;
      const untouched = placeholder != null
        && placeholder.settings_revision === 0
        && (placeholder.description == null || placeholder.description.trim() === '')
        && db.prepare('SELECT 1 FROM daemon_state WHERE key=?').get(`appearance:avatar:member:${placeholder.id}`) == null;
      if (placeholder != null && untouched && !hasDurableMemberReferences(db, placeholder.id)) {
        const claude = result.created.find((item) => item.kind === 'claude')
          ?? result.existing.find((item) => item.kind === 'claude');
        if (claude != null) {
          db.prepare('UPDATE rooms SET coordinator_member_id=?, revision=revision+1 WHERE project_id=? AND coordinator_member_id=?')
            .run(claude.memberId, projectId, placeholder.id);
          db.prepare('DELETE FROM room_members WHERE member_id=?').run(placeholder.id);
          result.removedLegacyPlaceholder = db.prepare('DELETE FROM project_members WHERE id=? AND project_id=?').run(placeholder.id, projectId).changes > 0;
        }
      }
    }
  };
  if (transaction) db.transaction(execute).immediate();
  else execute();
  return result;
}
