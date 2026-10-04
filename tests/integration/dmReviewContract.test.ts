/**
 * 第四十四轮 §2（review-r43 §4）：桌面 DM 返工/验收按钮的命令合同——真实 fake 链闭环。
 *
 * 复核反例（dist/desktop/review-r43/dm-review-contract-result.json）：产品 reject 处理器
 * 漏传必填 manifestHash（后端 z.strictObject 强制）→ VALIDATION_INVALID；且绑定
 * state.dmActive.pendingReview 而非用户当前所见 currentReview（待我处理定位时两者可能不同）。
 *
 * 本测试**原样抽取** app.js 的 dm-review-accept / dm-review-reject 处理器源码，在内存库的
 * 真实 fake 链（message.submit → DispatchWorker → 交付 pending → task.review）上执行：
 * - 返工（changes_requested）：参数带 manifestHash + 用户所见快照（currentReview 优先）；
 *   任务回 ACTIVE、交付记 changes_requested、意见入正式记录；新交付版本后旧版本不误审
 *   （STALE_REVISION）、错 hash 拒绝；redispatch 追加执行产生新版本交付。
 * - 验收（accept）：三重绑定通过 → DONE；版本/内容错位各返回明确冲突。
 * 全程 fake/零真实模型调用。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
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

const here = dirnameOf(import.meta.url); // tests/integration
const repoRoot = resolve(here, '..', '..');

function dirnameOf(u: string): string { return resolve(fileURLToPath(u), '..'); }

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dmrev-'));
mkdirSync(join(tmpRoot, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

interface ReviewSnapshot { taskId: string; deliveryId: string; revision: number; manifestHash: string }

/** 原样抽取产品 UI 处理器（与 review-r43 探针同一锚点法——改源码即改测试对象）。 */
function extractHandler(source: string, startAnchor: string, endAnchor: string): string {
  const a = source.indexOf(startAnchor);
  const b = source.indexOf(endAnchor, a);
  if (a < 0 || b < a) throw new Error(`handler anchors missing: ${startAnchor}`);
  return source.slice(a, b);
}

describe('第四十四轮 §2：DM 验收/返工按钮合同（真实 fake 链 + 原样产品处理器）', () => {
  it('返工带 manifestHash 且绑用户所见快照；accept/版本变化/错 hash 各就位', async () => {
    const db = openDatabase(':memory:');
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
    const appDir = join(tmpRoot, 'app');
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appDir };
    const raw = async (method: string, params: unknown) =>
      await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `dmrev-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: never; error?: { code: string; message: string } };

    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
    db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run('p1'); // user_review：交付 pending
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Guide A','agent',1)`).run();

    // 真实 fake 链：DM 消息 → 任务 → 执行完成 → REVIEW + 第 1 版待验收交付。
    const cv = await raw('conversation.create', { projectId: 'p1', peerMemberId: 'mA', title: '返工合同' });
    expect(cv.ok).toBe(true);
    const conversationId = (cv.data as unknown as { conversationId: string }).conversationId;
    const submitted = await raw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId }, body: '起草清单', intent: 'default', mentions: [] });
    expect(submitted.ok).toBe(true);
    const taskId = (submitted.data as unknown as { taskId: string }).taskId;
    await new DispatchWorker({ db, adapter, leaseOwner: 'w-dmrev', appDataDir: appDir }).runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('REVIEW');

    const deliveryRow = () => db.prepare('SELECT id, revision, manifest_hash, review_status FROM task_deliveries WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId) as { id: string; revision: number; manifest_hash: string; review_status: string };
    const d1 = deliveryRow();
    expect(d1.revision).toBe(1);
    expect(d1.review_status).toBe('pending');
    expect(d1.manifest_hash).toMatch(/^[0-9a-f]{64}$/);

    // ---------- 产品 reject 处理器（原样抽取）在真实命令面上的返工提交 ----------
    const source = readFileSync(join(repoRoot, 'src', 'ui', 'renderer', 'app.js'), 'utf8');
    const rejectCode = extractHandler(source, "el('dm-review-reject').onclick =", "el('dm-stop-btn').onclick");
    const acceptCode = extractHandler(source, "el('dm-review-accept').onclick =", "el('dm-review-reject').onclick");

    const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
    const lastBackend: Array<{ ok: boolean; error?: { code: string; message: string } }> = [];
    interface HandlerControls { controls: Array<{ tag: string; value: string; onclick?: () => void }>; trigger: { onclick?: () => void } }
    const runHandler = async (code: string, dmActive: { currentReview: ReviewSnapshot | null; pendingReview: ReviewSnapshot | null }, invoke: (h: HandlerControls) => void) => {
      const controls: Array<{ tag: string; value: string; onclick?: () => void }> = [];
      const rowStub = { querySelector: (s: string) => (s === '.git-row' ? { append: (...v: Array<{ tag: string; value: string; onclick?: () => void }>) => controls.push(...v) } : null) };
      const trigger: { onclick?: () => void } = {};
      const context = vm.createContext({
        state: { dmActive },
        document: { createElement: (tag: string) => ({ tag, value: '', focus: () => {} }) },
        el: (id: string) => (id === 'dm-review-row' ? rowStub : trigger),
        command: async (method: string, params: Record<string, unknown>) => {
          emitted.push({ method, params });
          const r = await raw(method, params);
          lastBackend.push({ ok: r.ok, error: r.error });
          if (!r.ok) throw new Error(r.error?.message ?? 'failed');
          return r.data;
        },
        showError: () => {},
        renderDm: async () => {},
      });
      vm.runInContext(code, context);
      invoke({ controls, trigger });
      await new Promise((r) => setTimeout(r, 20)); // onclick 内 async 完成
      return controls;
    };

    // 用户所见=第 1 版（currentReview 与 pendingReview 一致——常规路径）。
    const seen: ReviewSnapshot = { taskId, deliveryId: d1.id, revision: d1.revision, manifestHash: d1.manifest_hash };
    const controls1 = await runHandler(
      rejectCode,
      { currentReview: seen, pendingReview: seen },
      (h) => {
        h.trigger.onclick?.();
        h.controls.find((c) => c.tag === 'input')!.value = '请补风险一节';
        h.controls.find((c) => c.tag === 'button')!.onclick!();
      },
    );
    expect(controls1.length).toBe(2); // 输入 + 确认按钮已挂上（行内返工 UI）
    expect(emitted).toHaveLength(1);
    // 合同本体：必填 manifestHash 已随三重绑定提交（此前漏传→VALIDATION_INVALID）。
    expect(emitted[0]!.method).toBe('task.review');
    expect(emitted[0]!.params).toMatchObject({ taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: d1.manifest_hash, decision: 'changes_requested', note: '请补风险一节' });
    expect(lastBackend[0]!.ok).toBe(true); // 真实后端接受（不再是 schema 拒绝）
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE'); // 返工回 ACTIVE
    expect((db.prepare('SELECT review_status, review_note FROM task_deliveries WHERE id = ?').get(d1.id) as { review_status: string; review_note: string })).toMatchObject({ review_status: 'changes_requested', review_note: '请补风险一节' });
    const reviewEvents = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.reviewRecorded' AND task_id = ?`).all(taskId) as Array<{ payload_json: string }>;
    expect(reviewEvents).toHaveLength(1);
    expect(JSON.parse(reviewEvents[0]!.payload_json)).toMatchObject({ decision: 'changes_requested', deliveryRevision: 1 });

    // ---------- 版本变化：返工后追加执行 → 第 2 版 pending；旧版本/错 hash 不误审 ----------
    const rd = await raw('task.redispatch', { taskId, reason: '返工跟进（合同测试）' });
    expect(rd.ok).toBe(true);
    await new DispatchWorker({ db, adapter, leaseOwner: 'w-dmrev', appDataDir: appDir }).runOnce();
    const d2 = deliveryRow();
    expect(d2.revision).toBe(2);
    expect(d2.review_status).toBe('pending');

    // 旧版本（第 1 版已处理）再提交 → 明确冲突，不套用到新交付。
    const stale = await raw('task.review', { taskId, deliveryId: d1.id, deliveryRevision: 1, manifestHash: d1.manifest_hash, decision: 'accept' });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('STALE_REVISION');
    // 同版本号但错 hash（同版本不同内容）→ 拒绝。
    const wrongHash = await raw('task.review', { taskId, deliveryId: d2.id, deliveryRevision: 2, manifestHash: 'f'.repeat(64), decision: 'accept' });
    expect(wrongHash.ok).toBe(false);
    expect(wrongHash.error?.code).toBe('STALE_REVISION');
    expect(wrongHash.error?.message).toContain('manifestHash 不匹配');

    // ---------- 用户所见快照绑定：currentReview（定位交付）≠ pendingReview（最新） ----------
    const decoy: ReviewSnapshot = { taskId, deliveryId: d1.id, revision: 1, manifestHash: d1.manifest_hash }; // 旧版本诱饵
    const seen2: ReviewSnapshot = { taskId, deliveryId: d2.id, revision: 2, manifestHash: d2.manifest_hash };
    await runHandler(
      rejectCode,
      { currentReview: seen2, pendingReview: decoy },
      (h) => {
        h.trigger.onclick?.();
        h.controls.find((c) => c.tag === 'input')!.value = '第二版意见';
        h.controls.find((c) => c.tag === 'button')!.onclick!();
      },
    );
    // 提交目标=用户当前所见第 2 版（不是 pendingReview 诱饵、也不是旧版）。
    expect(emitted[1]!.params).toMatchObject({ deliveryId: d2.id, deliveryRevision: 2, manifestHash: d2.manifest_hash, decision: 'changes_requested', note: '第二版意见' });
    expect(lastBackend[1]!.ok).toBe(true);
    expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d2.id) as { review_status: string }).review_status).toBe('changes_requested');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('ACTIVE');

    // ---------- accept 处理器（原样抽取）：三重绑定 → DONE ----------
    await raw('task.redispatch', { taskId, reason: '再次跟进' });
    await new DispatchWorker({ db, adapter, leaseOwner: 'w-dmrev', appDataDir: appDir }).runOnce();
    const d3 = deliveryRow();
    expect(d3.revision).toBe(3);
    await runHandler(
      acceptCode,
      { currentReview: { taskId, deliveryId: d3.id, revision: d3.revision, manifestHash: d3.manifest_hash }, pendingReview: null },
      (h) => { h.trigger.onclick?.(); },
    );
    expect(emitted[2]!.params).toMatchObject({ taskId, deliveryId: d3.id, deliveryRevision: 3, manifestHash: d3.manifest_hash, decision: 'accept' });
    expect(lastBackend[2]!.ok).toBe(true);
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    expect((db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(d3.id) as { review_status: string }).review_status).toBe('accepted');

    void adapter.closeAllSessions().catch(() => {});
    db.close();
  }, 120_000);
});
