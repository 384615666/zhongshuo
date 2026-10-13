import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, migrate } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/registry.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
afterEach(() => vi.unstubAllEnvs());
interface Item {
    id: string;
    displayName: string;
    description: string;
    revision: number;
    conversationId: string;
    peerDisplayName: string;
    coordinatorMemberId: string;
}
interface Facts {
    project: {
        id: string;
    };
    items: Item[];
    conversations: Item[];
    memberId: string;
    messageId: string;
    taskId: string;
    conversationId: string;
    id: string;
    name: string;
    description: string;
    revision: number;
    config: {
        kind: 'fake' | 'claude' | 'codex';
        model: string | null;
        executable: string;
        permissionMode: string | null;
    };
    binding: {
        memberId: string;
        permissionMode: string | null;
    };
    imageInput: {
        status: string;
    };
    executableStatus: {
        status: string;
    };
}
interface SqlRow {
    id: string;
    profile_id: string;
    settings_revision: number;
    owner_member_id: string;
    status: string;
    c: number;
}
type Reply = {
    ok: boolean;
    replayed?: boolean;
    data?: Facts;
    error?: {
        code: string;
        message: string;
    };
};
async function fixture(old = false) {
    vi.stubEnv('ZS_ALLOW_FAKE', '1');
    vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
    const root = mkdtempSync(join(tmpdir(), 'zs-r81-')), data = join(root, 'data');
    mkdirSync(data);
    const file = join(data, 'state.sqlite');
    let db: ZhongshuoDatabase;
    if (old) {
        db = new Database(file);
        db.pragma('foreign_keys=ON');
        migrate(db, {}, MIGRATIONS.filter(m => m.id <= 48));
    }
    else
        db = openDatabase(file);
    const deps = { db, localUserId: 'u_local', appDataDir: data, interruptTurn: async () => { } };
    const raw = (method: string, params: unknown, commandId = `r81-${randomUUID()}`) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as Promise<Reply>;
    const cmd = async (method: string, params: unknown, commandId?: string) => { const r = await raw(method, params, commandId); if (!r.ok)
        throw Error(`${r.error?.code}: ${r.error?.message}`); return r.data!; };
    const a = join(root, '项目甲'), b = join(root, '项目乙');
    mkdirSync(a);
    mkdirSync(b);
    const p = (await cmd('project.open', { path: a })).project.id;
    const q = (await cmd('project.open', { path: b })).project.id;
    const member = (await cmd('member.create', { projectId: p, displayName: '同名', description: '分析原件' })).memberId as string;
    await cmd('member.setRuntime', { memberId: member, kind: 'fake', permissionMode: 'plan' });
    const list = async (projectId = p) => (await cmd('member.list', { projectId })).items as Array<{
        id: string;
        displayName: string;
        description: string;
        revision: number;
    }>;
    const row = async (id = member) => (await list()).find(m => m.id === id)!;
    return { db, root, data, file, deps, raw, cmd, p, q, member, list, row };
}
describe('R81 formal member and independent configuration template contracts', () => {
    it('rename CAS preserves exact identity, runtime, DM, task ownership and message text; all live read projections agree', async () => {
        const f = await fixture();
        try {
            const rooms = (await f.cmd('room.list', { projectId: f.p })).items;
            const room = rooms[0]!;
            const dm = await f.cmd('conversation.create', { projectId: f.p, peerMemberId: f.member });
            const submitted = await f.cmd('message.submit', { target: { kind: 'room_root', projectId: f.p, conversationId: room.conversationId, roomId: room.id }, body: '旧正文 @同名 保留', intent: 'default', mentions: [{ kind: 'member', memberId: f.member }] });
            const before = f.db.prepare('SELECT * FROM project_members WHERE id=?').get(f.member) as SqlRow;
            const oldBody = f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(submitted.messageId);
            const rev = (await f.row()).revision;
            const params = { projectId: f.p, memberId: f.member, expectedRevision: rev, displayName: '新名字', description: '中文说明' };
            const first = await f.raw('member.update', params, 'r81-rename-fixed');
            expect(first.ok).toBe(true);
            expect((await f.raw('member.update', params, 'r81-rename-fixed')).replayed).toBe(true);
            expect((await f.raw('member.update', { ...params, description: 'ABA' })).error?.code).toBe('STALE_REVISION');
            expect((await f.raw('member.update', { ...params, projectId: f.q })).error?.code).toBe('RESOURCE_NOT_FOUND');
            const after = f.db.prepare('SELECT * FROM project_members WHERE id=?').get(f.member) as SqlRow;
            expect(after.profile_id).toBe(before.profile_id);
            expect(after.id).toBe(before.id);
            expect(after.settings_revision).toBe(rev + 1);
            expect((await f.cmd('member.list', { projectId: f.p, roomId: room.id })).items.find((m) => m.id === f.member)!.displayName).toBe('新名字');
            expect((await f.cmd('conversation.list', { projectId: f.p })).conversations.find((c) => c.conversationId === dm.conversationId)!.peerDisplayName).toBe('新名字');
            const task = f.db.prepare('SELECT owner_member_id FROM tasks WHERE id=?').get(submitted.taskId) as SqlRow;
            expect(task.owner_member_id).toBe(f.member);
            expect(f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(submitted.messageId)).toEqual(oldBody);
            const second = (await f.cmd('member.create', { projectId: f.p, displayName: '新名字' })).memberId;
            expect(second).not.toBe(f.member);
            expect((await f.list()).filter(m => m.displayName === '新名字')).toHaveLength(2);
            for (const displayName of ['', '   ', 'x'.repeat(61)])
                expect((await f.raw('member.update', { ...params, displayName, expectedRevision: rev + 1 })).ok).toBe(false);
            expect((await f.raw('member.update', { ...params, description: 'x'.repeat(201), expectedRevision: rev + 1 })).ok).toBe(false);
            const worker = new DispatchWorker({ db: f.db, adapter: new FakeRuntimeAdapter(), leaseOwner: 'r81-normal', appDataDir: f.data });
            for (let n = 0; n < 8 && await worker.runOnce(); n++)
                ;
            expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(submitted.taskId) as SqlRow).status).toBe('DONE');
            expect((f.db.prepare('SELECT count(*) c FROM real_calls').get() as SqlRow).c).toBe(0);
        }
        finally {
            f.db.close();
        }
    });
    it('same/cross-project snapshots remain independent after template edit, runtime edit, disable, reload and same-ID unknown replay', async () => {
        const f = await fixture();
        try {
            const saved = await f.cmd('memberTemplate.saveFromMember', { projectId: f.p, memberId: f.member, expectedRevision: (await f.row()).revision, name: '复用模板', description: '配置说明' }, 'r81-save-snapshot');
            const cfg = { kind: 'fake', model: null, executable: 'fake', permissionMode: 'plan' };
            expect(saved.config).toEqual(cfg);
            const p = { projectId: f.p, templateId: saved.id, expectedRevision: 0, displayName: '快照成员', description: '独立' };
            const made = await f.cmd('memberTemplate.createMember', p, 'r81-create-lost-reply');
            const again = await f.raw('memberTemplate.createMember', p, 'r81-create-lost-reply');
            expect(again.replayed).toBe(true);
            expect(again.data!.memberId).toBe(made.memberId);
            const cross = await f.cmd('memberTemplate.createMember', { ...p, projectId: f.q }, 'r81-create-cross');
            expect(cross.memberId).not.toBe(made.memberId);
            const prior = await f.cmd('member.runtime', { memberId: made.memberId });
            const edit = await f.cmd('memberTemplate.update', { templateId: saved.id, expectedRevision: 0, name: '改后模板', description: '仅后续', enabled: true, config: { ...cfg, permissionMode: 'manual' } });
            expect((await f.cmd('member.runtime', { memberId: made.memberId })).binding).toEqual(prior.binding);
            const newMember = await f.cmd('memberTemplate.createMember', { ...p, expectedRevision: edit.revision });
            expect((await f.cmd('member.runtime', { memberId: newMember.memberId })).binding.permissionMode).toBe('manual');
            await f.cmd('member.setRuntime', { memberId: made.memberId, kind: 'fake', permissionMode: 'acceptEdits' });
            expect((await f.cmd('member.runtime', { memberId: cross.memberId })).binding.permissionMode).toBe('plan');
            expect((await f.cmd('member.runtime', { memberId: f.member })).binding.permissionMode).toBe('plan');
            const profiles = f.db.prepare('SELECT profile_id FROM project_members WHERE id IN (?,?,?,?)').all(f.member, made.memberId, cross.memberId, newMember.memberId) as SqlRow[];
            expect(new Set(profiles.map(m => m.profile_id)).size).toBe(4);
            await f.cmd('memberTemplate.update', { templateId: saved.id, expectedRevision: 1, name: edit.name, description: '', enabled: false, config: edit.config });
            expect((await f.raw('memberTemplate.createMember', { ...p, expectedRevision: 2 })).error?.code).toBe('VALIDATION_INVALID');
            expect((await f.raw('memberTemplate.createMember', p)).error?.code).toBe('STALE_REVISION');
            expect((await f.raw('memberTemplate.createMember', p, 'r81-create-lost-reply')).replayed).toBe(true);
            expect((f.db.prepare('SELECT count(*) c FROM runtime_sessions').get() as SqlRow).c).toBe(0);
            expect((f.db.prepare('SELECT count(*) c FROM outbox').get() as SqlRow).c).toBe(0);
            f.db.close();
            const reopened = openDatabase(f.file);
            try {
                expect(reopened.prepare('SELECT enabled,revision FROM member_templates WHERE id=?').get(saved.id)).toEqual({ enabled: 0, revision: 2 });
                expect((reopened.prepare('SELECT count(*) c FROM project_members WHERE id IN (?,?,?)').get(made.memberId, cross.memberId, newMember.memberId) as SqlRow).c).toBe(3);
            }
            finally {
                reopened.close();
            }
        }
        finally {
            if (f.db.open)
                f.db.close();
        }
    });
    it('whitelist excludes secrets/certificates; unavailable executable saves without claiming certification or raising permissions', async () => {
        const f = await fixture();
        try {
            vi.stubEnv('ZS_REAL_DISPATCH_GUARD', undefined);
            const executable = join(f.root, 'does-not-exist.exe');
            await f.cmd('member.setRuntime', { memberId: f.member, kind: 'codex', model: 'gpt-6-luna', executable, permissionMode: 'plan' });
            const saved = await f.cmd('memberTemplate.saveFromMember', { projectId: f.p, memberId: f.member, expectedRevision: (await f.row()).revision, name: '不可用程序模板', description: '' });
            expect(Object.keys(saved.config).sort()).toEqual(['executable', 'kind', 'model', 'permissionMode']);
            expect(JSON.stringify(saved)).not.toContain(f.p);
            const made = await f.cmd('memberTemplate.createMember', { projectId: f.q, templateId: saved.id, expectedRevision: 0, displayName: '不可用但已保存', description: '' });
            const runtime = await f.cmd('member.runtime', { memberId: made.memberId });
            expect(runtime.executableStatus.status).toBe('missing');
            expect(runtime.imageInput.status).toBe('unverified');
            expect(runtime.binding.permissionMode).toBe('plan');
            expect((await f.raw('memberTemplate.update', { templateId: saved.id, expectedRevision: 0, name: '秘密', description: '', enabled: true, config: { ...saved.config, apiKey: 'DO_NOT_COPY' } })).error?.code).toBe('VALIDATION_INVALID');
            const remote = await dispatchDaemonCommand({ ...f.deps, remoteAudit: { deviceId: 'test', authEpoch: 1 } }, { protocolVersion: 1, commandId: 'r81-remote-config', method: 'memberTemplate.list', params: {} }) as Reply;
            expect(remote.error?.code).toBe('PERMISSION_DENIED');
            expect((f.db.prepare('SELECT count(*) c FROM real_calls').get() as SqlRow).c).toBe(0);
        }
        finally {
            f.db.close();
        }
    });
    it('coordinator disable and archived/removed project guards apply to metadata/config/create and replay', async () => {
        const f = await fixture();
        try {
            const room = (await f.cmd('room.list', { projectId: f.p })).items[0]!;
            expect((await f.raw('member.setEnabled', { memberId: room.coordinatorMemberId, enabled: false })).ok).toBe(false);
            const params = { projectId: f.p, memberId: f.member, expectedRevision: (await f.row()).revision, displayName: '保留', description: '' };
            await f.cmd('member.update', params, 'r81-lifecycle-replay');
            const project = (await f.cmd('project.list', {})).items.find((p) => p.id === f.p)!;
            await f.cmd('project.lifecycle', { projectId: f.p, expectedRevision: project.revision, action: 'archive' });
            expect((await f.raw('member.update', params, 'r81-lifecycle-replay')).ok).toBe(false);
            expect((await f.raw('member.setRuntime', { memberId: f.member, kind: 'fake' })).ok).toBe(false);
            expect((await f.raw('member.setEnabled', { memberId: f.member, enabled: false })).ok).toBe(false);
            expect((await f.raw('memberTemplate.saveFromMember', { ...params, name: '只读', description: '' })).ok).toBe(false);
        }
        finally {
            f.db.close();
        }
    });
    it('full independent v48 root copy upgrades with matching backup; old schema reader rejects v49 and backup restores all prior facts', async () => {
        const f = await fixture(true);
        try {
            writeFileSync(join(f.data, 'draft-evidence.json'), 'engineering draft only');
            const before = f.db.prepare('SELECT * FROM project_members ORDER BY id').all();
            f.db.pragma('wal_checkpoint(TRUNCATE)');
            f.db.close();
            const copied = join(f.root, 'full-copy');
            cpSync(f.data, copied, { recursive: true });
            const backup = join(copied, 'backups');
            const upgraded = openDatabase(join(copied, 'state.sqlite'), { backupDir: backup });
            expect(upgraded.pragma('user_version', { simple: true })).toBe(49);
            expect(upgraded.prepare('SELECT * FROM project_members ORDER BY id').all()).toEqual(before);
            expect(readFileSync(join(copied, 'draft-evidence.json'), 'utf8')).toBe('engineering draft only');
            upgraded.close();
            const old = new Database(join(copied, 'state.sqlite'));
            try {
                expect(() => migrate(old, {}, MIGRATIONS.filter(m => m.id <= 48))).toThrow('SCHEMA_VERSION_UNSUPPORTED');
                expect(old.pragma('user_version', { simple: true })).toBe(49);
            }
            finally {
                old.close();
            }
            const saved = join(backup, readdirSync(backup)[0]!);
            const restored = new Database(saved);
            try {
                expect(restored.pragma('user_version', { simple: true })).toBe(48);
                expect(restored.prepare('SELECT * FROM project_members ORDER BY id').all()).toEqual(before);
                expect(() => migrate(restored, {}, MIGRATIONS.filter(m => m.id <= 48))).not.toThrow();
            }
            finally {
                restored.close();
            }
            const original = new Database(f.file, { readonly: true });
            expect(original.pragma('user_version', { simple: true })).toBe(48);
            original.close();
            const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
            expect(hash(join(f.data, 'draft-evidence.json'))).toBe(hash(join(copied, 'draft-evidence.json')));
        }
        finally {
            if (f.db.open)
                f.db.close();
        }
    });
});
