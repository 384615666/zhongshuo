/**
 * r61 P5/G7 集成：hifi store 的草稿/未知信封持久化与文件引用直写（产品模块原样导入——
 * localStorage 用内存桩模拟，模块状态用 vi.resetModules 隔离；不改产品代码）。
 *
 * 覆盖（review-r60 §2/§3/§6）：
 *  - addFileRefToDraft：一次点击一次落账；同文件同版本去重不积压；新版本=新行；身份缺失零写入；
 *  - queueDraftInsert/takeDraftInserts：同文本去重、一次性消费（旧队列不在后续点击批量灌入）；
 *  - initDraftPersistence 往返：正文/提及/意图/已就绪引用/完整未知信封（含 queued）恢复；
 *    在途（uploading）与被移除（removed）项不落盘不复活；持久化失败→状态位如实、内存仍生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存 localStorage 桩（setItem 可注入抛错——测试配额尽/私有模式失败路径）。 */
class MemoryLocalStorage {
  store = new Map<string, string>();
  failing = false;
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { if (this.failing) throw new Error('QuotaExceededError: mock'); this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
}

const stub = new MemoryLocalStorage();

async function freshStore() {
  vi.resetModules();
  const store = await import('../../src/ui/hifi/data/store.ts');
  return store;
}

beforeEach(() => {
  stub.clear();
  stub.failing = false;
  vi.stubGlobal('localStorage', stub);
  vi.stubGlobal('window', { setTimeout: (fn: () => void, _ms: number) => { fn(); return 0; } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hifi 草稿/未知信封持久化与文件引用（r61）', () => {

  it('文件引用：一次落账、同文件同版本去重、新版本加行、身份缺失零写入', async () => {
    const s = await freshStore();
    const r1 = s.addFileRefToDraft('thread:t1', 'conv1', { attachmentId: 'att_a', name: 'a.md', kind: 'text_file', revision: 1, hash: 'h1' });
    expect(r1).toEqual({ ok: true, existed: false });
    const r2 = s.addFileRefToDraft('thread:t1', 'conv1', { attachmentId: 'att_a', name: 'a.md', kind: 'text_file', revision: 1, hash: 'h1' });
    expect(r2).toEqual({ ok: true, existed: true }); // 同文件同版本=已在草稿（不积压）
    const r3 = s.addFileRefToDraft('thread:t1', 'conv1', { attachmentId: 'att_a', name: 'a.md', kind: 'text_file', revision: 2, hash: 'h2' });
    expect(r3.existed).toBe(false); // 新版本=新引用行
    const d = s.getDraftFull('thread:t1');
    expect(d.attachments.map((a) => `${a.attachmentId}@${a.revision}`).sort()).toEqual(['att_a@1', 'att_a@2']);
    // 芯片（uploadItems ready）与草稿 ref 一致——两条 ready
    expect((s.getState().uploadItems['thread:t1'] ?? []).filter((x) => x.status === 'ready').length).toBe(2);
    // 身份缺失：零写入（不凭文件名猜资源身份）
    const before = s.getDraftFull('thread:t2').attachments.length;
    const r4 = s.addFileRefToDraft('thread:t2', 'conv1', { attachmentId: '', name: 'a.md', kind: 'text_file' });
    expect(r4.ok).toBe(false);
    expect(s.getDraftFull('thread:t2').attachments.length).toBe(before);
    expect(s.getState().uploadItems['thread:t2']).toBeUndefined();
  });

  it('摘录队列：同文本去重、一次性消费', async () => {
    const s = await freshStore();
    const text = '> 摘录「a.md」v1：hello';
    expect(s.queueDraftInsert('dm:c1', text)).toEqual({ ok: true, queued: true });
    expect(s.queueDraftInsert('dm:c1', text).queued).toBe(false); // 双击同摘录不重复入队
    const took = s.takeDraftInserts('dm:c1');
    expect(took.length).toBe(1);
    expect(took[0]!.text).toBe(text);
    expect(s.takeDraftInserts('dm:c1')).toEqual([]); // 一次性消费——后续点击不批量灌入
  });

  it('持久化往返：正文/提及/意图/就绪引用/完整未知信封（含 queued）恢复；uploading/removed 不落盘', async () => {
    const s1 = await freshStore();
    s1.initDraftPersistence('C:\\data\\root1|local-user-1');
    expect(s1.getState().draftPersist.mode).toBe('on');
    s1.setDraftFull('thread:t1', { body: '正文草稿', mentions: ['m1'], attachments: [{ name: 'a.md', size: 20, attachmentId: 'att_a', revision: 1, hash: 'h1', kind: 'text_file' }], access: 'plan', sendAs: 'record' });
    s1.addUploadItem({ uploadId: 'u1', draftKey: 'thread:t1', conversationId: 'conv1', name: 'up.png', size: 10, status: 'uploading' });
    s1.addUploadItem({ uploadId: 'u2', draftKey: 'thread:t1', conversationId: 'conv1', name: 'bad.csv', size: 10, status: 'failed', error: 'x' });
    const env = { commandId: 'cmd_abcd1234', method: 'message.submit' as const, params: { target: { kind: 'thread' }, body: '服务已提交、回执丢失', intent: 'default' as const, mentions: [], attachmentRefs: ['att_a'] }, targetLabel: 'thread:t1', at: 12345, revAtSend: 3 };
    const envQ = { ...env, commandId: 'cmd_efgh5678', params: { ...env.params, body: '第二条' } };
    s1.parkUnknownEnvelope('thread:t1', env);
    s1.parkUnknownEnvelope('thread:t1', envQ); // 同键排队（不覆盖）
    const raw = stub.store.get('zs.hifi.persist.C:\\data\\root1|local-user-1')!;
    const snap = JSON.parse(raw) as { uploadItems: Record<string, Array<{ status: string }>> };
    expect(snap.uploadItems['thread:t1']!.some((x) => x.status === 'uploading')).toBe(false); // 在途不持久化
    expect(snap.uploadItems['thread:t1']!.some((x) => x.status === 'failed')).toBe(true);

    // “renderer 崩溃重载”=新模块实例 + 同一 localStorage 命名空间
    const s2 = await freshStore();
    s2.initDraftPersistence('C:\\data\\root1|local-user-1');
    const d = s2.getDraftFull('thread:t1');
    expect(d.body).toBe('正文草稿');
    expect(d.mentions).toEqual(['m1']);
    expect(d.sendAs).toBe('record'); // 仅记录意图不因重载变 AI
    expect(d.attachments[0]!.attachmentId).toBe('att_a');
    const parked = s2.getState().pendingSends['thread:t1'];
    expect(parked?.commandId).toBe('cmd_abcd1234'); // 完整原信封冻结
    expect(parked?.params.attachmentRefs).toEqual(['att_a']); // 资源身份随信封保留
    expect((parked?.queued ?? []).map((q) => q.commandId)).toEqual(['cmd_efgh5678']); // 排队信封同在
    expect(s2.getState().uploadItems['thread:t1']!.some((x) => x.status === 'uploading')).toBe(false); // 在途=重新选择状态
    expect(s2.getState().uploadItems['thread:t1']!.some((x) => x.status === 'failed')).toBe(true);
    // 不同命名空间（数据根/用户隔离）互不串
    const s3 = await freshStore();
    s3.initDraftPersistence('C:\\data\\root2|local-user-1');
    expect(s3.getDraftFull('thread:t1').body).toBe('');
    expect(s3.getState().pendingSends['thread:t1']).toBeUndefined();
  });

  it('持久化失败：内存仍生效 + 状态位如实；恢复可写后自动转清', async () => {
    const s = await freshStore();
    s.initDraftPersistence('ns|u');
    stub.failing = true; // localStorage 突然不可写（配额尽）
    s.setDraftFull('dm:c1', { body: '输入中的正文', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    expect(s.getDraftFull('dm:c1').body).toBe('输入中的正文'); // 内存不丢
    expect(s.getState().draftPersist.error).toContain('持久化失败');
    stub.failing = false;
    s.setDraftFull('dm:c1', { body: '再改一次', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    expect(s.getState().draftPersist.error).toBeNull(); // 恢复可写→状态位转清
  });

  it('写入持续失败（私有模式形态）：mode 保持 on + error 常驻如实（内存仍生效）；identity 失败=off', async () => {
    const s = await freshStore();
    stub.failing = true; // 初始化期首次快照即抛——按写入失败处理（内存态仍可用，不冒充已持久化）
    s.initDraftPersistence('ns|u');
    expect(s.getState().draftPersist.mode).toBe('on');
    expect(s.getState().draftPersist.error).toContain('持久化失败');
    s.setDraftFull('dm:c9', { body: '仍可输入', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    expect(s.getDraftFull('dm:c9').body).toBe('仍可输入');
    // identity 不可用（服务未起/浏览器宿主）：显式降级 off
    s.markPersistenceDegraded('持久化身份不可用（服务未就绪）——草稿仅本次进程内有效');
    expect(s.getState().draftPersist.mode).toBe('off');
  });
});

describe('快照防护与 TTL（r62 P2——review-r61 §3）', () => {
  const rawEnv = (v: number, body: string, cmd: string): string => JSON.stringify({
    v,
    savedAt: Date.now(),
    drafts: { 'thread:t9': { body, mentions: [], attachments: [], access: 'default', sendAs: 'record', rev: 3 } },
    pendingSends: { 'thread:t9': { commandId: cmd, method: 'message.submit', params: { target: { kind: 'thread' }, body: 'already-committed', intent: 'record_only', mentions: [] }, targetLabel: 'thread:t9', at: 123 } },
    uploadItems: {},
  });

  it('未来版本 v2：原件逐字隔离、不覆写、不自动派发、恢复说明如实', async () => {
    const s1 = await freshStore();
    const original = rawEnv(2, 'v2-body', 'cmd_v2_must_not_be_lost');
    stub.store.set('zs.hifi.persist.nsX|u', original);
    s1.initDraftPersistence('nsX|u');
    const qKeys = Array.from(stub.store.keys()).filter((k: string) => k.includes('.quarantine-'));
    expect(qKeys.length).toBe(1);
    expect(stub.store.get(qKeys[0]!)).toBe(original); // 原件逐字保全
    expect(s1.getDraftFull('thread:t9').body).toBe(''); // 不从未知版本恢复
    expect(s1.getState().pendingSends['thread:t9']).toBeUndefined(); // 不解析不派发
    const note = s1.getState().draftPersist.recoveryNote ?? '';
    expect(note).toContain('不受本程序支持');
    expect(note).toContain('隔离');
    expect(s1.getState().draftPersist.error).toBeNull(); // 写入本身正常——与恢复说明分列
  });

  it('损坏 JSON（缺右括号）：同样隔离+空态+说明', async () => {
    const s1 = await freshStore();
    stub.store.set('zs.hifi.persist.nsY|u', rawEnv(1, 'x', 'cmd_corrupt').slice(0, -1));
    s1.initDraftPersistence('nsY|u');
    const qKeys = Array.from(stub.store.keys()).filter((k: string) => k.includes('.quarantine-'));
    expect(qKeys.length).toBe(1);
    expect(s1.getDraftFull('thread:t9').body).toBe('');
    expect((s1.getState().draftPersist.recoveryNote ?? '')).toContain('JSON 损坏');
  });

  it('部分条目损坏：有效条目恢复、损坏计数说明、原件隔离', async () => {
    const s1 = await freshStore();
    const mixed = JSON.stringify({
      v: 1, savedAt: Date.now(),
      drafts: {
        'room:r1': { body: 'good-body', mentions: [], attachments: [], access: 'default', sendAs: 'ai' },
        'room:r2': { body: 123, mentions: [], attachments: [], access: 'default', sendAs: 'ai' }, // body 非串=损坏
      },
      pendingSends: { 'room:r1': { commandId: 'cmd_ok', method: 'message.submit', params: { target: { kind: 'room_root' }, body: 'b', intent: 'default', mentions: [] }, targetLabel: 'room:r1', at: 1 } },
      uploadItems: {},
    });
    stub.store.set('zs.hifi.persist.nsZ|u', mixed);
    s1.initDraftPersistence('nsZ|u');
    expect(s1.getDraftFull('room:r1').body).toBe('good-body');
    expect(s1.getDraftFull('room:r2').body).toBe('');
    expect(s1.getState().pendingSends['room:r1']?.commandId).toBe('cmd_ok'); // 有效账本恢复（无 TTL）
    const note = s1.getState().draftPersist.recoveryNote ?? '';
    expect(note).toContain('损坏草稿 1 条');
    expect(note).toContain('有效部分');
  });

  it('普通草稿 24h 过期（批准约定）：过期不恢复、未过期恢复、未确认账本超龄仍在、过期草稿上传项一并不恢复', async () => {
    const s1 = await freshStore();
    const now = Date.now();
    stub.store.set('zs.hifi.persist.nsT|u', JSON.stringify({
      v: 1, savedAt: now,
      drafts: {
        'dm:old': { body: 'old-draft', mentions: [], attachments: [], access: 'default', sendAs: 'ai', updatedAt: now - 25 * 3600_000 },
        'dm:fresh': { body: 'fresh-draft', mentions: [], attachments: [], access: 'default', sendAs: 'ai', updatedAt: now - 23 * 3600_000 },
        'dm:noStamp': { body: 'fallback-stamp', mentions: [], attachments: [], access: 'default', sendAs: 'ai' }, // 无 updatedAt→回退快照 savedAt=新鲜
      },
      pendingSends: { 'dm:old': { commandId: 'cmd_old_unconfirmed', method: 'message.submit', params: { target: { kind: 'dm' }, body: 'b', intent: 'default', mentions: [] }, targetLabel: 'dm:old', at: now - 48 * 3600_000 } },
      uploadItems: { 'dm:old': [{ uploadId: 'u9', draftKey: 'dm:old', conversationId: 'c', name: 'f.md', size: 10, status: 'ready', attachmentId: 'att9' }] },
    }));
    s1.initDraftPersistence('nsT|u');
    expect(s1.getDraftFull('dm:old').body).toBe(''); // 过期
    expect(s1.getDraftFull('dm:fresh').body).toBe('fresh-draft');
    expect(s1.getDraftFull('dm:noStamp').body).toBe('fallback-stamp');
    expect(s1.getState().pendingSends['dm:old']?.commandId).toBe('cmd_old_unconfirmed'); // 未确认账本不受 TTL
    expect((s1.getState().uploadItems['dm:old'] ?? []).length).toBe(0); // 过期草稿的上传项不复活
    expect((s1.getState().draftPersist.recoveryNote ?? '')).toContain('24 小时过期草稿 1 条');
  });

  it('setDraftFull 盖 updatedAt 戳（新快照可判龄）', async () => {
    const s1 = await freshStore();
    s1.initDraftPersistence('nsW|u');
    const t0 = Date.now();
    s1.setDraftFull('dm:c1', { body: '新鲜', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    const snap = JSON.parse(stub.store.get('zs.hifi.persist.nsW|u')!);
    expect(snap.drafts['dm:c1'].updatedAt).toBeGreaterThanOrEqual(t0);
  });
});
