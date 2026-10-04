/**
 * 第四十四轮 §2 + 第四十五轮 §3（review-r43 §4 / review-r44 §3）：桌面 DM 验收/返工按钮
 * 的命令合同——真实 fake 链闭环 + **返工目标固定**。
 *
 * r43 反例：reject 漏传 manifestHash（VALIDATION_INVALID）且绑 pendingReview 而非用户所见。
 * r44 反例（探针 dist/desktop/review-r44-independent/）：打开 A 的意见框后刷新成 B，确认时
 * 重读 state.dmActive → **A 的意见被提交给 B**。
 *
 * 修复合同（r45）：打开意见框时捕获会话身份+task/delivery/revision/hash 快照；确认只审该快照——
 * 输入期间刷新换目标（同会话）不换稿；同任务版本更新由后端 STALE_REVISION 拒（不悄悄套用到
 * 新交付）；跨会话切换明确拒绝并作废（零提交）。accept 为单击操作，按其点击时快照语义验证。
 *
 * 本测试**原样抽取** app.js 的 dm-review-accept / dm-review-reject 处理器源码，在内存库的
 * 真实 fake 链（message.submit → DispatchWorker → 交付 pending → task.review）上执行。
 * 全程 fake/零真实模型调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dmrev2-'));
mkdirSync(join(tmpRoot, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

interface ReviewSnapshot { taskId: string; deliveryId: string; revision: number; manifestHash: string }

/** 原样抽取产品 UI 处理器（锚点法——改源码即改测试对象）。 */
function extractHandler(source: string, startAnchor: string, endAnchor: string): string {
  const a = source.indexOf(startAnchor);
  const b = source.indexOf(endAnchor, a);
  if (a < 0 || b < a) throw new Error(`handler anchors missing: ${startAnchor}`);
  return source.slice(a, b);
}

describe('第四十五轮 §3：DM 返工目标固定（真实 fake 链 + 原样产品处理器）', () => {
  it('打开时快照固定：刷新换目标不换稿；版本更新后端拒；跨会话明确作废零提交；accept 按快照语义', async () => {
    const db = openDatabase(':memory:');
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    const appDir = join(tmpRoot, 'app');
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
    const raw = async (method: string, params: unknown) =>
      await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmrev-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: never; error?: { code: string; message: string } };

    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1');
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Guide A','agent',1)`).run();

    // 真实 fake 链：DM 消息 → 任务 → 执行完成 → REVIEW + 第 1 版待验收交付。
    const cv = await raw('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: '返工目标固定' });
    expect(cv.ok).toBe(true);
    const conversationId = (cv.data as unknown as { conversationId: string }).conversationId;
    const submitted = await raw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId }, body: '起草清单', intent: 'default', mentions: [] });
    expect(submitted.ok).toBe(true);
    const taskId = (submitted.data as unknown as { taskId: string }).taskId;
    const worker = () => new DispatchWorker({ db, adapter, leaseOwner: 'w-dmrev', appDataDir: appDir });
    await worker().runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('REVIEW');

    const deliveryRow = () => db.prepare('SELECT id, revision, manifest_hash, review_status FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId) as { id: string; revision: number; manifest_hash: string; review_status: string };
    const snapOf = (d: { id: string; revision: number; manifest_hash: string }): ReviewSnapshot => ({ taskId, deliveryId: d.id, revision: d.revision, manifestHash: d.manifest_hash });
    const d1 = deliveryRow();
    expect(d1.revision).toBe(1);
    expect(d1.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    const seen1 = snapOf(d1);

    // ---------- 处理器原样抽取与执行支架 ----------
    const source = readFileSync(join(repoRoot, 'src', 'ui', 'renderer', 'app.js'), 'utf8');
    const rejectCode = extractHandler(source, "el('dm-review-reject').onclick =", "el('dm-stop-btn').onclick");
    const acceptCode = extractHandler(source, "el('dm-review-accept').onclick =", "el('dm-review-reject').onclick");

    const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
    const backendErrors: Array<string> = [];
    const uiErrors: Array<string> = [];
    interface HandlerControls {
      controls: Array<{ tag: string; value: string; onclick?: () => void; removed?: boolean }>;
      trigger: { onclick?: () => void };
      state: { openDmId: string | null; dmActive: { currentReview: ReviewSnapshot | null; pendingReview: ReviewSnapshot | null } | null };
    }
    /** reject 两步交互：open() 挂意见框；confirm(note) 提交；两步之间可 mutate state（模拟轮询刷新/切会话）。 */
    const mountReject = (state: HandlerControls['state']) => {
      const controls: Array<{ tag: string; value: string; onclick?: () => void; removed?: boolean }> = [];
      const rowStub = {
        querySelector: (s: string) => {
          if (s === '.git-row') return { append: (...v: Array<{ tag: string; value: string; onclick?: () => void; removed?: boolean }>) => controls.push(...v) };
          if (s === '#dm-review-note-input') return controls.find((c) => c.tag === 'input' && !c.removed) ?? null;
          return null;
        },
      };
      const trigger: { onclick?: () => void } = {};
      const context = vm.createContext({
        state,
        document: { createElement: (tag: string) => ({ tag, value: '', removed: false, focus: () => {}, remove() { this.removed = true; } }) },
        el: (id: string) => (id === 'dm-review-row' ? rowStub : trigger),
        command: async (method: string, params: Record<string, unknown>) => {
          emitted.push({ method, params });
          const r = await raw(method, params);
          if (!r.ok) { backendErrors.push(`${r.error?.code}: ${r.error?.message}`); throw new Error(r.error?.message ?? 'failed'); }
          return r.data;
        },
        showError: (msg: string) => { uiErrors.push(String(msg)); },
        renderDm: async () => {},
      });
      vm.runInContext(rejectCode, context);
      return { controls, trigger, state };
    };
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // ---------- ① 常规返工：打开时快照提交（manifestHash 随三重绑定） ----------
    {
      const h = mountReject({ openDmId: conversationId, dmActive: { currentReview: seen1, pendingReview: seen1 } });
      h.trigger.onclick?.();
      expect(h.controls.filter((c) => !c.removed).map((c) => c.tag)).toEqual(['input', 'button']); // 意见框挂上
      const input = h.controls.find((c) => c.tag === 'input')!;
      input.value = '请补风险一节';
      h.controls.find((c) => c.tag === 'button')!.onclick!();
      await settle();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.params).toMatchObject({ taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: d1.manifest_hash, decision: 'changes_requested', note: '请补风险一节' });
      expect(backendErrors).toHaveLength(0); // 真实后端接受（不再是 schema 拒绝）
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');
      expect((db.prepare('SELECT review_status, review_note FROM task_deliveries WHERE id = ?').get(d1.id) as { review_status: string; review_note: string })).toMatchObject({ review_status: 'changes_requested', review_note: '请补风险一节' });
      expect(input.removed).toBe(true); // 成功后意见框移除（不残留）
    }

    // ---------- ② 输入期间「刷新换目标」（同会话定位漂移）：确认仍只审打开时快照 ----------
    await raw('task.redispatch', { taskId, reason: '返工跟进（②）' });
    await worker().runOnce();
    const d2 = deliveryRow();
    expect(d2.revision).toBe(2);
    const seen2 = snapOf(d2);
    {
      // 打开时目标=第 2 版；输入期间 renderDm 刷新把 currentReview 换成诱饵（另一交付快照）。
      const decoy: ReviewSnapshot = { taskId, deliveryId: 'delivery_decoy', revision: 99, manifestHash: 'e'.repeat(64) };
      const h = mountReject({ openDmId: conversationId, dmActive: { currentReview: seen2, pendingReview: seen2 } });
      h.trigger.onclick?.();
      h.state.dmActive = { currentReview: decoy, pendingReview: decoy }; // 轮询刷新/定位消费——r44 探针反例形态
      const input = h.controls.find((c) => c.tag === 'input')!;
      input.value = '对第二版的意见（打开时快照）';
      h.controls.find((c) => c.tag === 'button')!.onclick!();
      await settle();
      expect(emitted[1]!.params).toMatchObject({ deliveryId: d2.id, deliveryRevision: 2, manifestHash: d2.manifest_hash, note: '对第二版的意见（打开时快照）' }); // 不换稿
      expect(emitted[1]!.params.deliveryId).not.toBe('delivery_decoy'); // 诱饵从未被提交
      expect(backendErrors).toHaveLength(0);
      expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d2.id) as { review_status: string }).review_status).toBe('changes_requested'); // 意见落在打开时目标上
    }

    // ---------- ③ 输入期间版本更新：确认审旧快照 → 后端 STALE_REVISION 拒，新版本零误审 ----------
    await raw('task.redispatch', { taskId, reason: '返工跟进（③）' });
    await worker().runOnce();
    const d3 = deliveryRow();
    expect(d3.revision).toBe(3);
    const seen3 = snapOf(d3);
    {
      // 打开时目标=第 3 版；输入期间产生第 4 版（redispatch+执行）且刷新 currentReview=第 4 版。
      const h = mountReject({ openDmId: conversationId, dmActive: { currentReview: seen3, pendingReview: seen3 } });
      h.trigger.onclick?.();
      await raw('task.redispatch', { taskId, reason: '输入期间版本更新' });
      await worker().runOnce();
      const d4 = deliveryRow();
      expect(d4.revision).toBe(4);
      h.state.dmActive = { currentReview: snapOf(d4), pendingReview: snapOf(d4) };
      h.controls.find((c) => c.tag === 'input')!.value = '针对第三版的意见';
      h.controls.find((c) => c.tag === 'button')!.onclick!();
      await settle();
      // 提交目标=打开时第 3 版快照（非刷新后的第 4 版）——旧意见不自动套用到新交付。
      expect(emitted[2]!.params).toMatchObject({ deliveryId: d3.id, deliveryRevision: 3, manifestHash: d3.manifest_hash });
      expect(backendErrors[0]).toContain('STALE_REVISION'); // 后端按版本绑定拒（第 3 版已处理）
      expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d4.id) as { review_status: string }).review_status).toBe('pending'); // 第 4 版零误审
      expect(uiErrors.some((m) => m.includes('第 3 版快照'))).toBe(true); // UI 如实标注快照版本
    }

    // ---------- ④ 跨 DM 切换：明确作废、零提交 ----------
    {
      const d4 = deliveryRow();
      const h = mountReject({ openDmId: conversationId, dmActive: { currentReview: snapOf(d4), pendingReview: snapOf(d4) } });
      h.trigger.onclick?.();
      h.state.openDmId = 'conv_other'; // 用户切到另一会话后点确认
      h.controls.find((c) => c.tag === 'input')!.value = '写给原会话的意见';
      const before = emitted.length;
      h.controls.find((c) => c.tag === 'button')!.onclick!();
      await settle();
      expect(emitted.length).toBe(before); // 零提交
      expect(uiErrors.some((m) => m.includes('作废'))).toBe(true); // 明确拒绝+作废
      expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d4.id) as { review_status: string }).review_status).toBe('pending'); // 目标交付不动
      expect(h.controls.find((c) => c.tag === 'input')!.removed).toBe(true); // 意见框作废移除
    }

    // ---------- ⑤ accept（单击）：按点击时快照语义 → 第 4 版 DONE ----------
    {
      const d4 = deliveryRow();
      const trigger: { onclick?: () => void } = {};
      const context = vm.createContext({
        state: { openDmId: conversationId, dmActive: { currentReview: snapOf(d4), pendingReview: null } },
        el: () => trigger, // 抽取段首 el('dm-review-accept').onclick 赋值须落到同一 trigger 对象
        command: async (method: string, params: Record<string, unknown>) => {
          emitted.push({ method, params });
          const r = await raw(method, params);
          if (!r.ok) { backendErrors.push(`${r.error?.code}`); throw new Error(r.error?.message ?? 'failed'); }
          return r.data;
        },
        showError: (msg: string) => { uiErrors.push(String(msg)); },
        renderDm: async () => {},
      });
      vm.runInContext(acceptCode, context);
      trigger.onclick?.();
      await settle();
      expect(emitted[emitted.length - 1]!.params).toMatchObject({ taskId, deliveryId: d4.id, deliveryRevision: 4, manifestHash: d4.manifest_hash, decision: 'accept' });
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
      expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d4.id) as { review_status: string }).review_status).toBe('accepted');
    }

    // 全链审计：每次 review 都有正式记录；无对诱饵/新版本的误审副作用。
    const reviews = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.reviewRecorded' AND task_id = ? ORDER BY seq`).all(taskId) as Array<{ payload_json: string }>;
    expect(reviews).toHaveLength(3); // ①第1版 changes_requested + ②第2版 changes_requested + ⑤第4版 accept（③被拒不产生、④零提交）
    expect(JSON.parse(reviews[0]!.payload_json)).toMatchObject({ decision: 'changes_requested', deliveryRevision: 1 });
    expect(JSON.parse(reviews[1]!.payload_json)).toMatchObject({ decision: 'changes_requested', deliveryRevision: 2 });
    expect(JSON.parse(reviews[2]!.payload_json)).toMatchObject({ decision: 'accept', deliveryRevision: 4 });

    void adapter.closeAllSessions().catch(() => {});
    db.close();
  }, 120_000);
});
