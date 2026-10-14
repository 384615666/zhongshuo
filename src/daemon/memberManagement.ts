import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveCodexInvocation } from '../adapter/codex/appServerAdapter.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { CLAUDE_ADAPTER_VERSION, claudeCapabilities, resolveClaudeExecutable } from '../adapter/claude/cliAdapter.ts';
const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(200);
const id = z.string().min(1);
const revision = z.number().int().nonnegative();
export const templateConfigSchema = z.strictObject({
    kind: z.enum(['claude', 'codex', 'fake']),
    model: z.string().trim().min(1).max(200).nullable(),
    executable: z.string().trim().min(1).max(1024),
    permissionMode: z.enum(['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']).nullable(),
    effort: z.enum(['none','minimal','low','medium','high','xhigh','max']).nullable().optional(),
});
export type TemplateConfig = z.infer<typeof templateConfigSchema>;
type Fail = (code: string, message: string) => never;
type Runner = <T>(handler: () => T, replayGuard?: () => void) => {
    data: T;
    replayed: boolean;
};
type Member = {
    id: string;
    project_id: string;
    display_name: string;
    description: string | null;
    settings_revision: number;
    profile_id: string | null;
    principal_type: string;
};
type Template = {
    id: string;
    name: string;
    description: string;
    config_json: string;
    revision: number;
    enabled: number;
    created_at: number;
    updated_at: number;
};
/** Filesystem lookup only; finding a program is not a runtime/model capability certification. */
export function memberExecutableStatus(kind: string | null, executable: string | null) {
    if (kind === 'fake')
        return { status: 'found' as const, reason: '独立工程 adapter；不是真实模型认证' };
    if (!executable)
        return { status: 'unknown' as const, reason: '没有明确绑定的程序引用' };
    const file = (p: string) => { try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    } };
    const locate=(program:string)=>{
      if(isAbsolute(program))return file(program);
      if(/[\\/]/.test(program))return null;
      const suffixes=process.platform==='win32'?['',...(process.env.PATHEXT??'.EXE;.CMD;.BAT').split(';')]:[''];
      return(process.env.PATH??'').split(delimiter).filter(Boolean).some(dir=>suffixes.some(ext=>file(join(dir,program+ext))));
    };
    try{
      const entry=kind==='claude'?resolveClaudeExecutable(executable):kind==='codex'?resolveCodexInvocation(executable):{command:executable,args:[]};
      const args='prefixArgs' in entry?entry.prefixArgs:entry.args;
      const present=locate(entry.command);const scripts=args.filter(a=>/\.(js|cjs|mjs)$/i.test(a));
      const found=present!==false&&scripts.every(p=>locate(p)!==false);
      if(!found)return{status:'missing' as const,reason:'当前正式 adapter 的程序或脚本引用不存在或不可读取，请配置后再派工'};
      if(present==null||scripts.some(p=>locate(p)==null))return{status:'unknown' as const,reason:'相对程序路径依赖执行上下文；请保存明确的程序引用'};
      return{status:'found' as const,reason:'已找到正式 adapter 使用的程序引用；未执行或认证模型'};
    }catch{return{status:'missing' as const,reason:'当前正式 adapter 无法解析保存的程序引用；请配置后再派工'};}

}
export function assertMemberProject(db: ZhongshuoDatabase, projectId: string, fail: Fail) {
    const p = db.prepare('SELECT status FROM projects WHERE id=?').get(projectId) as {
        status: string;
    } | undefined;
    if (p == null)
        fail('RESOURCE_NOT_FOUND', '项目不存在');
    if (p.status === 'archived' || p.status === 'removed')
        fail('VALIDATION_INVALID', '项目已归档或移除；请先恢复项目，不能修改成员');
}
function memberOf(db: ZhongshuoDatabase, projectId: string, memberId: string, fail: Fail) {
    const m = db.prepare('SELECT * FROM project_members WHERE id=? AND project_id=?').get(memberId, projectId) as Member | undefined;
    if (m == null)
        fail('RESOURCE_NOT_FOUND', '成员不存在或不属于目标项目；不会按同名查找');
    return m;
}
function templateOf(db: ZhongshuoDatabase, templateId: string, fail: Fail) {
    const t = db.prepare('SELECT * FROM member_templates WHERE id=?').get(templateId) as Template | undefined;
    if (t == null)
        fail('RESOURCE_NOT_FOUND', '配置模板不存在');
    return t;
}
function checkRevision(actual: number, expected: number, fail: Fail) {
    if (actual !== expected)
        fail('STALE_REVISION', '资料或配置版本已变化；请回读并确认，不自动覆盖新版本');
}
function configGuard(config: TemplateConfig, fail: Fail) {
    if (config.kind === 'fake' && process.env.ZS_ALLOW_FAKE !== '1')
        fail('CAPABILITY_UNSUPPORTED', 'fake 配置仅限独立工程环境');
    if (config.kind === 'claude' && config.model == null)
        fail('VALIDATION_INVALID', 'claude 配置必须指定模型 ID');
    if (config.model != null && (/^sk-/i.test(config.model) || /[\r\n\0]/.test(config.model)))
        fail('VALIDATION_INVALID', '模型 ID 不能携带密钥或多行内容');
    if (/[\r\n\0]/.test(config.executable))
        fail('VALIDATION_INVALID', '执行程序引用不能携带多行内容');
    if (process.env.ZS_REAL_DISPATCH_GUARD === '1' && config.kind !== 'fake')
        fail('CAPABILITY_UNSUPPORTED', '工程派发保护下拒绝创建真实渠道绑定；不会为模板绕过保护');
}
/** Same persistence path as member.setRuntime, always a private member profile. No process starts. */
export function bindMemberRuntime(db: ZhongshuoDatabase, memberId: string, config: TemplateConfig) {
    const installationId = `ri_${config.kind}_${createHash('sha256').update(`${config.kind}|${config.executable}`).digest('hex').slice(0, 10)}`;
    const capabilities = { toolCapabilities: config.kind === 'claude' ? claudeCapabilities() : { note: 'codex/fake 能力表随各自 adapter 认证轮登记' }, modelAvailability: config.model == null ? 'not-specified' : 'configured-unverified', permissionAuth: 'unverified' };
    db.prepare(`INSERT INTO runtime_installations (id,kind,executable,version,adapter_version,capabilities_json,detected_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING`).run(installationId, config.kind, config.executable, '', config.kind === 'claude' ? CLAUDE_ADAPTER_VERSION : config.kind === 'codex' ? 'codex-appserver-adapter' : 'fake-adapter', JSON.stringify(capabilities), Date.now());
    const profileId = `ap_${memberId}`;
    db.prepare(`INSERT INTO agent_profiles (id,name,description,runtime_installation_id,settings_json) VALUES (?,?,NULL,?,?)
    ON CONFLICT(id) DO UPDATE SET runtime_installation_id=excluded.runtime_installation_id, settings_json=excluded.settings_json`).run(profileId, `成员 ${memberId} 的 runtime profile`, installationId, JSON.stringify({ model: config.model, permissionMode: config.permissionMode, effort:config.effort??null }));
    db.prepare('UPDATE project_members SET profile_id=?, settings_revision=settings_revision+1 WHERE id=?').run(profileId, memberId);
    return { memberId, installationId, kind: config.kind, model: config.model, permissionMode: config.permissionMode,effort:config.effort??null };
}
function dto(t: Template) { return { id: t.id, name: t.name, description: t.description, config: templateConfigSchema.parse(JSON.parse(t.config_json)), enabled: t.enabled === 1, revision: t.revision, createdAt: t.created_at, updatedAt: t.updated_at }; }
/** Local configuration templates: strict whitelist, CAS, transactions and durable command receipts. */
export function memberManagementCommand(db: ZhongshuoDatabase, method: string, params: unknown, run: Runner, fail: Fail, remote: boolean): {
    data: unknown;
    replayed?: boolean;
} | null {
    if (method !== 'member.update' && !method.startsWith('memberTemplate.'))
        return null;
    if (remote && method.startsWith('memberTemplate.'))
        fail('PERMISSION_DENIED', '配置模板仅限本机可信入口');
    if (method === 'member.update') {
        const p = z.strictObject({ projectId: id, memberId: id, expectedRevision: revision, displayName: name, description }).parse(params);
        const scope = () => { assertMemberProject(db, p.projectId, fail); memberOf(db, p.projectId, p.memberId, fail); };
        scope();
        return run(() => {
            scope();
            const m = memberOf(db, p.projectId, p.memberId, fail);
            checkRevision(m.settings_revision, p.expectedRevision, fail);
            db.prepare('UPDATE project_members SET display_name=?,description=?,settings_revision=settings_revision+1 WHERE id=? AND project_id=?').run(p.displayName, p.description, p.memberId, p.projectId);
            return { projectId: p.projectId, memberId: p.memberId, displayName: p.displayName, description: p.description, revision: m.settings_revision + 1 };
        }, scope);
    }
    if (method === 'memberTemplate.list') {
        const p = z.strictObject({ afterId: id.optional(), limit: z.number().int().min(1).max(100).optional() }).parse(params);
        const limit = p.limit ?? 50;
        const rows = db.prepare('SELECT * FROM member_templates WHERE id > ? ORDER BY id LIMIT ?').all(p.afterId ?? '', limit + 1) as Template[];
        return { data: { items: rows.slice(0, limit).map(dto), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null } };
    }
    if (method === 'memberTemplate.saveFromMember') {
        const p = z.strictObject({ projectId: id, memberId: id, expectedRevision: revision, name, description }).parse(params);
        const scope = () => { assertMemberProject(db, p.projectId, fail); memberOf(db, p.projectId, p.memberId, fail); };
        scope();
        return run(() => {
            scope();
            const m = memberOf(db, p.projectId, p.memberId, fail);
            checkRevision(m.settings_revision, p.expectedRevision, fail);
            if (m.principal_type !== 'agent')
                fail('VALIDATION_INVALID', '只能从 AI 成员保存配置');
            const binding = db.prepare('SELECT ap.settings_json,ri.kind,ri.executable FROM agent_profiles ap JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id WHERE ap.id=?').get(m.profile_id) as {
                settings_json: string;
                kind: string;
                executable: string;
            } | undefined;
            if (binding == null)
                fail('VALIDATION_INVALID', '此成员没有明确的 runtime 绑定；请先为成员保存配置，不能把动态全局默认冒充模板快照');
            const settings = JSON.parse(binding.settings_json) as Record<string, unknown>;
            const config = templateConfigSchema.parse({ kind: binding.kind, executable: binding.executable, model: settings.model ?? null, permissionMode: settings.permissionMode ?? null,...(settings.effort?{effort:settings.effort}:{}) });
            configGuard(config, fail);
            const templateId = `mt_${randomUUID()}`, now = Date.now();
            db.prepare('INSERT INTO member_templates (id,name,description,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(templateId, p.name, p.description, JSON.stringify(config), now, now);
            return dto(templateOf(db, templateId, fail));
        }, scope);
    }
    if (method === 'memberTemplate.update') {
        const p = z.strictObject({ templateId: id, expectedRevision: revision, name, description, enabled: z.boolean(), config: templateConfigSchema }).parse(params);
        configGuard(p.config, fail);
        return run(() => {
            const t = templateOf(db, p.templateId, fail);
            checkRevision(t.revision, p.expectedRevision, fail);
            configGuard(p.config, fail);
            db.prepare('UPDATE member_templates SET name=?,description=?,enabled=?,config_json=?,revision=revision+1,updated_at=? WHERE id=?').run(p.name, p.description, p.enabled ? 1 : 0, JSON.stringify(p.config), Date.now(), p.templateId);
            return dto(templateOf(db, p.templateId, fail));
        });
    }
    if (method === 'memberTemplate.createMember') {
        const p = z.strictObject({ projectId: id, templateId: id, expectedRevision: revision, displayName: name, description }).parse(params);
        const scope = () => { assertMemberProject(db, p.projectId, fail); };
        scope();
        return run(() => {
            scope();
            const t = templateOf(db, p.templateId, fail);
            checkRevision(t.revision, p.expectedRevision, fail);
            if (t.enabled !== 1)
                fail('VALIDATION_INVALID', '模板已停用，不能创建新成员；已有成员不受影响');
            const config = templateConfigSchema.parse(JSON.parse(t.config_json));
            configGuard(config, fail);
            const memberId = `m_${randomUUID()}`;
            db.prepare("INSERT INTO project_members (id,project_id,display_name,description,principal_type,enabled) VALUES (?,?,?,?,'agent',1)").run(memberId, p.projectId, p.displayName, p.description);
            const roomsJoined = db.prepare('INSERT INTO room_members (room_id,member_id) SELECT id,? FROM rooms WHERE project_id=? AND archived_at IS NULL').run(memberId, p.projectId).changes;
            bindMemberRuntime(db, memberId, config);
            return { projectId: p.projectId, memberId, roomsJoined, templateId: t.id, templateRevision: t.revision, revision: 1, configuration: 'saved-unverified', note: '独立成员及配置快照；不自动派发，不成为协调者，不复用会话，能力须按实际配置回读' };
        }, scope);
    }
    fail('VALIDATION_INVALID', '未知配置模板命令');
}
