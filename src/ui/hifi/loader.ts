/**
 * 真实数据装载与写动作（H1 首包，第四十七轮修订）：正式命令 → 原型视图模型映射。
 *
 * 合同修正（review-r46 §3）：project.open 用 `{path}`；room_root target 带 `roomId`；
 * 房间名单经 `member.list({projectId, roomId})` 装载（room.memberIds=@ 候选唯一来源）；
 * mentions `all` → `{kind:'all'}`；历史 `created_at` 如实映射（不伪造当前时间）。
 *
 * 归属与水位（review-r46 §5）：装载代次+请求时项目身份双重门（迟到响应不误归新项目）；
 * markRead 仅前台+贴底+当前路由；读取失败写入 readErrors（保留旧快照，不冒充空态）。
 * 发送（review-r46 §4）：sendCommand 携带 Composer commandId，返回 ok/failed/unknown。
 */
import { command, sendCommand, bridge } from './bridge';
import type { BridgeOutcome } from './bridge';
import { setState, getState, toast, recordWrite, canMarkRead, canMarkThreadRead, getDraftFull, setDraftFull as setDraftFullShim, initDraftPersistence, markPersistenceDegraded, mergeInheritedSnapshots, setLegacyImportCandidates, readInheritMarker, writeInheritMarker } from './data/store';
import type { HifiState, PendingSendEnvelope, ThreadTaskDetail } from './data/store';
import type {ThreadMembersSnapshot} from '../../contracts/threadMembers';
import type {ThreadVisibleProgress} from '../../contracts/runtimeProgress';
import type { CollaborationStage, Message, Task, Thread, ThreadCard } from './data/types';
import { deriveDeliberateMaxTurns } from '../../contracts/deliberation.ts';
import { routeForResolved, type ResolvedDeepLink } from './lib/deepLink';
import { currentNavSeq, navigate } from './lib/router';
import { navIntentActive, cancelAllNavIntents, beginUserNavIntent, onNavIntentCancel, releaseNavIntent, type NavIntent } from './lib/navIntent';

/* ---------- 正式响应的最小类型（真实形状字段子集——具体投影，不用 any） ---------- */
interface ProjectOpenData { project: { id: string; displayName: string; revision?: number; rootPath?: string; canonicalPath?: string }; created?: boolean }
/** R65：注册表条目（project.list——多项目前端集合的事实源）。 */
interface RegistryItem { id: string; displayName: string; rootPath: string; canonicalPath: string; directoryIdentity: string; status: string; revision: number; description: string | null; taskReviewEnabled: boolean; createdAt: number }
interface RoomListData { items: Array<{ id: string; name: string; conversationId: string; coordinatorMemberId?: string | null; archived?: boolean; archivedAt?: number | null; description?: string | null; revision?: number }> }
interface RoomMembersData { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean;description?:string;revision?:number }> }
interface PoolData { items: Array<{ threadId: string; anchorMessageId?: string; taskId?: string | null; taskStatus?: string | null; taskResponseKind?:'conversation'|'work'|null; taskTitle?: string | null; roomTaskNumber?: number | null; taskObjective?: string | null; taskReviewPolicy?: Task['reviewPolicy'] | null; taskRevision?: number | null; taskMode?: Task['mode'] | null; ownerMemberId?: string | null; latestRun?: Task['latestRun']; authorType?: Message['authorType']; authorId?: string; attachments?: Array<{ artifactId: string; filename: string; kind: string; detailMarkdown?: boolean }>; body?: { text?: string }; createdAt?: number; replyCount?: number; lastReplyAt?: number | null; unread?: number; muted?: boolean; followed?: boolean }> }
interface ConvListData { conversations: Array<{ conversationId: string; peerDisplayName?: string; title?: string | null; unread?: number; execState?: string; archivedAt?: number | null; lastMessagePreview?: string | null; projectId?: string; revision?: number; activeTaskId?: string | null; activeRunId?: string | null; activeStopGeneration?: number; interruptedTasks?: Array<{ taskId: string; title: string; lastRunStatus: string | null; lastRunId: string | null; recoverable: boolean; blockReason: string | null }>; pendingReview?: { taskId: string; deliveryId: string; revision: number; manifestHash: string } | null; reworkPending?: { taskId: string; deliveryId: string; deliveryRevision: number; manifestHash: string; sourceRunId: string; note: string | null; queued: boolean } | null; queuedCount?: number; stopPending?: boolean }> }
export interface HistoryMessage { id: string; createdAt?: number; created_at?: number; authorType?: string; author_type?: string; authorId?: string; author_id?: string; bodyJson?: string; body_json?: string; conversationSeq?: number; conversation_seq?: number; attachments?: Array<{ artifactId: string; filename: string; kind: string; sizeBytes?: number; detailMarkdown?: boolean }> }
interface HistoryData { messages: HistoryMessage[] }
import {chatAnswer} from '../../contracts/chatAnswer';
export interface SendResult { taskId?: string; threadId?: string; disposition?: string; deliberationBudget?: { maxTurns: number } }

const textOf = (m: HistoryMessage): string => {
  const raw = m.bodyJson ?? m.body_json;
  if (raw == null) return '';
  try { const text=((JSON.parse(raw) ?? {}) as { text?: string }).text ?? '';return chatAnswer(text,m.authorType??m.author_type??'system'); } catch { return String(raw); }
};
/** created_at 如实映射：响应没有则置 0（「未知」）并由呈现层标注，不用当前时间伪造。 */
const createdAtOf = (m: HistoryMessage): number => m.createdAt ?? m.created_at ?? 0;

/**
 * `body_json.collaborationStage` → 呈现用阶段标记（R91 模块3）。
 *
 * 后端把验证通过的阶段产物作为正式消息持久化，`body_json` 形如
 * `{ text, collaborationStage: { stage, roundNo, turnId, runId } }`。
 * thread.history 的 `items[].body` 是完整解析后的 body_json；DM 的
 * `conversation.history` 返回原始 `body_json` 字符串——两条链都经这里转译。
 *
 * 容缺省契约：字段缺失/畸形/阶段为空一律返回 undefined（按普通消息渲染），
 * 不让渲染层去猜，也不把内部 turn/run 身份暴露到界面。
 */
export function collaborationStageOfBody(body: unknown): CollaborationStage | undefined {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as { collaborationStage?: unknown }).collaborationStage;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const stage = typeof record.stage === 'string' ? record.stage.trim() : '';
  if (stage.length === 0) return undefined;
  const result: CollaborationStage = { stage };
  if (typeof record.roundNo === 'number' && Number.isFinite(record.roundNo) && record.roundNo >= 0) {
    result.roundNo = Math.floor(record.roundNo);
  }
  if (typeof record.turnId === 'string' && record.turnId.length > 0) result.turnId = record.turnId;
  if (typeof record.runId === 'string' && record.runId.length > 0) result.runId = record.runId;
  return result;
}

/**
 * 阶段产物正文首行的【阶段】标题去重（R91 前后端契约对齐）。
 *
 * 后端 `renderStageProductText` 会在正文首行写 `【独立分析】` / `【争议讨论 · 第2轮】` /
 * `【争议讨论 · 检查点 · 第2轮】`；而消息头已经用 `collaborationStage` 渲染
 * 简短中文阶段标签和轮次。留着这行会让用户看到两遍标签，故仅在**确认这是带阶段标记的
 * 正式产物消息**且首行确为已知阶段标题时去掉该标题行；其余正文原样保留，绝不删空。
 * （用户手写正文、普通消息、无 metadata 的旧消息都不会经过这一步。）
 */
const STAGE_HEADING_LABELS = new Set(['独立分析', '互评', '分歧讨论', '争议讨论', '整合', '确认', '发布', '准备']);

export function stripStageHeading(text: string, stage: CollaborationStage | undefined): string {
  if (stage == null || text.length === 0) return text;
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  const match = /^【([^】]{1,40})】$/.exec(first);
  if (match == null) return text;
  const inner = match[1] ?? '';
  const headingMatches = [...STAGE_HEADING_LABELS].some((label) => inner === label || inner.startsWith(label + ' · '));
  if (!headingMatches) return text;
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
  return rest.length > 0 ? rest : text;
}

/** 从 DM 原始历史行解析 body_json（解析失败不抛错、不渲染原 JSON）。 */
function parsedHistoryBody(m: HistoryMessage): unknown {
  const raw = m.bodyJson ?? m.body_json;
  if (raw == null) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

/** Raw detail is the visible fallback when the app-managed MD attachment could not be registered. */
function detailMarkdownOfBody(body: unknown): string | undefined {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as { detailMarkdown?: unknown; runtimeControlResult?: unknown };
  if (typeof value.detailMarkdown === 'string' && value.detailMarkdown.trim().length > 0) return value.detailMarkdown;
  if (typeof value.runtimeControlResult === 'string') {
    try {
      const parsed = JSON.parse(value.runtimeControlResult) as { detailMarkdown?: unknown };
      if (typeof parsed.detailMarkdown === 'string' && parsed.detailMarkdown.trim().length > 0) return parsed.detailMarkdown;
    } catch { /* natural text */ }
  }
  return undefined;
}

/** 归属门：请求发起时的 (gen, projectId) 与当前状态一致才落盘。 */
function stillCurrent(gen: number, projectId: string): boolean {
  const s = getState();
  return s.loadGen === gen && s.activeProjectId === projectId;
}

/* ---------- 首启（有界等待，不靠 reload——review-r46 §5） ---------- */

/**
 * 草稿持久化初始化（r61 P5 → R67 P1-B → R68 §2 真实旧版继承）：
 *  - 命名空间 **v2=稳定逻辑根身份**：`v2.<dataRootId>|<localUserId>`（app.identity 懒建
 *    {appData}/root-identity.json，随目录复制原样带走）。dataRootId 不可用（内存库测试/旧
 *    daemon）→ 回退 v1 绝对路径形态。
 *  - **身份标记无效（R68 §3B）**：root-identity.json 已存在但不合法时 daemon 不覆写不换 ID
 *    （rootIdentityHealth='invalid-marker'）——本侧退回绝对路径键并给出可见健康状态与显式
 *    恢复路径，不静默换身份。
 *  - **真实旧版首次继承（R68 §2）**：v3/v4 没有逻辑身份标记，旧快照也没有内嵌 dataRootId。
 *    继承判定与「v2 键是否存在」**解耦**（空新键不再是「迁移完成」证据）——用独立继承标记
 *    `zs.hifi.inherit.<ns>` 记录结论：标记缺失=未判定，每次启动重试（旧键原样保留，重试安全）：
 *    ① 旧键目录==当前 appDataDir（同目录升级）——目录即同一物理根，构造性可信，自动继承；
 *    ② 新格式快照内嵌 dataRootId==当前——本地自证（目录改名/移动后仍可继承）；
 *    ③ 旧格式（无内嵌 id）目录≠当前——daemon app.rootIdentityOf 只读核对旧目录标记；
 *    ④ 旧格式且旧目录无标记（真实 v3/v4 就是这样）——**不自动继承也不静默丢弃**：登记到
 *    draftPersist.legacyImport（设置 → 草稿存储 可见 + 重扫 + 用户逐键确认导入；不盲扫合并、
 *    无关根不混入，导入决定权在用户）。
 *  - 继承的未知信封/出站账本原 commandId/参数/阶段完整保留（无 TTL、不自动发送、不换号）；
 *    普通草稿沿用 24h TTL；未来版本来源整体拒收（mergeInheritedSnapshots 版本门同判）。
 */
async function initDraftPersistenceFromIdentity(): Promise<void> {
  try {
    const id = await command<{ localUserId: string; appDataDir: string; dataRootId: string | null; rootIdentityHealth?: 'ok' | 'invalid-marker' | 'unavailable'; rootIdentityProblem?: string | null }>('app.identity', {});
    if (id.dataRootId == null || id.rootIdentityHealth === 'invalid-marker') {
      // 绝对路径命名空间（内存库/旧 daemon/标记无效）。标记无效：身份健康问题必须可见——
      // 不冒充逻辑身份可用，也不静默换 ID（旧 v2 键仍指向原 ID，等用户修复标记）。
      const ns = `${id.appDataDir}|${id.localUserId}`;
      initDraftPersistence(ns);
      if (id.rootIdentityHealth === 'invalid-marker') {
        recordWrite('app.identity', `数据根身份标记无效（${id.rootIdentityProblem ?? '未知原因'}）——原件未改动；本会话草稿按绝对路径键读写，逻辑身份继承暂停`);
        setState((s) => ({ ...s, draftPersist: { ...s.draftPersist, recoveryNote: `数据根身份标记 root-identity.json 无效（${id.rootIdentityProblem ?? '未知原因'}）——**原件逐字保全，未换 ID**；本会话按绝对路径键读写（同目录内正常）。修复方法：人工核对 ${id.appDataDir}\\root-identity.json（内容应为 {"id":"dri_…","createdAt":…}），修正或删除该文件后重启应用——逻辑身份与跨目录继承即恢复。` } }));
      }
      return;
    }
    const ns = `v2.${id.dataRootId}|${id.localUserId}`;
    initDraftPersistence(ns, id.dataRootId);
    // 继承标记门：与 v2 键存在与否解耦（先写空新键不再导致永久跳过继承）。标记同时是
    // **导入候选队列的持久层**——重载/重开后设置页的候选列表由此恢复（不因重启丢失后永久
    // 跳过——R68 反例：首轮登记后进程重启即空表）。state 未结论时再跑一次判定。
    const marker = readInheritMarker(ns);
    if (marker != null && Array.isArray(marker.candidates) && marker.candidates.length > 0) {
      setLegacyImportCandidates(marker.candidates, null);
    }
    if (marker?.state === 'done') return;
    await attemptLegacyInheritance(ns, { localUserId: id.localUserId, appDataDir: id.appDataDir, dataRootId: id.dataRootId });
  } catch (e) {
    markPersistenceDegraded(`持久化身份不可用（${e instanceof Error ? e.message : String(e)}）——草稿仅本次进程内有效`);
  }
}

/** 一次继承判定（自动通道 ①②③ + 用户导入候选登记 ④）。结论写继承标记（含候选队列）；
 * 失败不写 done（下次重试）。重扫保留已导入项的 importedAt（不复活已处理候选）。 */
async function attemptLegacyInheritance(ns: string, id: { localUserId: string; appDataDir: string; dataRootId: string }): Promise<void> {
  const prevMarker = readInheritMarker(ns);
  const prevImportedAt = new Map<string, number>();
  for (const c of prevMarker?.candidates ?? []) if (c.importedAt != null) prevImportedAt.set(c.key, c.importedAt);
  const candidates = collectLegacyPersistKeys(id.localUserId);
  const validated: Array<{ raw: string; sourceDir: string }> = [];
  const importable: Array<{ key: string; dir: string; hasStateDb: boolean | null }> = [];
  let scanError: string | null = null;
  // 通道①：同目录 v1 键（目录==当前 appDataDir——同一物理根，构造性可信；不依赖旧程序从未
  // 生成过的标记）。R67 反例：此键曾被跳过，同目录升级丢失草稿/未知账本。
  for (const c of candidates.filter((c) => c.dir === id.appDataDir)) {
    const raw = localStorage.getItem(c.key) ?? '';
    if (raw.length > 0) validated.push({ raw, sourceDir: `${c.dir}（同目录）` });
  }
  // 通道②③：跨目录候选——内嵌 dataRootId 自证，或交 daemon 只读核对旧目录标记。
  const crossDir = candidates.filter((c) => c.dir !== id.appDataDir);
  const needDirCheck: Array<{ key: string; dir: string; raw: string }> = [];
  for (const c of crossDir) {
    const raw = localStorage.getItem(c.key) ?? '';
    if (raw.length === 0) continue;
    const embedded: unknown = (() => {
      try { return (JSON.parse(raw) as { dataRootId?: unknown })?.dataRootId; } catch { return null; }
    })();
    if (typeof embedded === 'string' && embedded.length >= 8) {
      if (embedded === id.dataRootId) validated.push({ raw, sourceDir: `${c.dir}（内嵌同根）` });
      // 内嵌异根：不合并、不导入（明确属于其它逻辑根）。
    } else {
      needDirCheck.push({ key: c.key, dir: c.dir, raw });
    }
  }
  if (needDirCheck.length > 0) {
    try {
      const r = await command<{ ids: Record<string, string | null>; hasStateDb: Record<string, boolean> }>('app.rootIdentityOf', { appDataDirs: needDirCheck.map((c) => c.dir) });
      for (const c of needDirCheck) {
        if (r.ids[c.dir] === id.dataRootId) validated.push({ raw: c.raw, sourceDir: `${c.dir}（标记同根）` });
        else {
          // 旧目录无标记/异根：真实 v3/v4 旧根没有标记——登记为用户导入候选（hasStateDb 帮助
          // 核对，不构成信任证明；不自动合并无关根）。
          importable.push({ key: c.key, dir: c.dir, hasStateDb: r.hasStateDb?.[c.dir] ?? null });
        }
      }
    } catch (e) {
      // 目录校验不可用：仅已验证部分继承；未验证候选下次启动重试（标记不写 done）。
      scanError = `旧目录身份核对不可用（${e instanceof Error ? e.message : String(e)}）——未验证候选保留，下次启动自动重试`;
    }
  }
  if (validated.length > 0) {
    mergeInheritedSnapshots(validated, `已从旧命名空间自动继承（${validated.map((c) => c.sourceDir).join('、')}；旧键原样保留）`);
  }
  setLegacyImportCandidates(importable, scanError);
  if (importable.length > 0) {
    recordWrite('draft.inherit', `发现 ${importable.length} 个未验证旧目录的草稿键（${importable.map((c) => c.dir).join('、')}）——真实 v3/v4 旧数据根没有身份标记，不能自动确认同根；如属你的旧数据根，请到「设置 → 草稿存储」逐键确认导入（未确认前不合并、不派发）`);
  } else if (validated.length === 0 && candidates.length > 0) {
    recordWrite('draft.inherit', `发现 ${candidates.length} 个旧命名空间键但无一同属当前数据根（内嵌异根/标记异根）——不合并（无关根/他机数据不混入）`);
  }
  if (scanError == null) {
    // 全部候选已有结论（继承/登记/明确异根）——写 done 并持久化候选队列（设置页导入入口
    // 重载后由此恢复）；保留已导入项的 importedAt（重扫不复活已处理候选）。
    const persisted = importable.map((c) => ({ ...c, importedAt: prevImportedAt.get(c.key) ?? null }));
    writeInheritMarker(ns, { state: 'done', at: Date.now(), auto: validated.length, candidates: persisted });
  }
}

/** 设置页「重扫旧目录」：重跑一次继承判定（用户修复标记/插入新复制后用）。 */
export async function rescanLegacyImport(): Promise<void> {
  try {
    const id = await command<{ localUserId: string; appDataDir: string; dataRootId: string | null }>('app.identity', {});
    if (id.dataRootId == null) { setLegacyImportCandidates([], '当前无逻辑数据根身份（标记无效/不可用）——先修复 root-identity.json 再重扫'); return; }
    await attemptLegacyInheritance(`v2.${id.dataRootId}|${id.localUserId}`, { localUserId: id.localUserId, appDataDir: id.appDataDir, dataRootId: id.dataRootId });
  } catch (e) {
    setLegacyImportCandidates([], `重扫失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 收集候选 v1 旧键（同用户、非隔离件；**含当前目录**——同目录升级的构造性可信来源）。
 * 返回 [{key, dir}]。 */
function collectLegacyPersistKeys(localUserId: string): Array<{ key: string; dir: string }> {
  const out: Array<{ key: string; dir: string }> = [];
  try {
    for (const key of Object.keys(localStorage)) {
      const m = /^zs\.hifi\.persist\.(.+\|.+)$/.exec(key);
      if (m == null) continue;
      if (key.includes('.quarantine-')) continue; // 隔离件不参与继承（保全原件，不二次消费）
      const sep = m[1].lastIndexOf('|');
      const dir = m[1].slice(0, sep);
      const user = m[1].slice(sep + 1);
      if (user !== localUserId) continue; // 别的用户不混入
      if (dir.startsWith('v2.')) continue; // v2 键非本函数职责
      out.push({ key, dir });
    }
  } catch { /* localStorage 不可枚举：如实无候选 */ }
  return out.slice(0, 32);
}

export async function bootRemembered(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const s = getState();
    if (s.boot === 'ready' || s.boot === 'failed') return; // 已装载/用户已手动打开
    try {
      const remembered = await command<{ values: Record<string, string> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      await initDraftPersistenceFromIdentity();
      // R65：注册表+服务端导航偏好（无行=本地/全量默认）。欢迎页「最近项目」来自真实注册表；
      // 偏好中的有效 id 才采用（已移除/归档项目自动清出，不猜）。
      await loadProjectRegistry();
      await applyServerNavPrefs();
      const path = remembered?.values?.['ui.autoOpenProjectPath'];
      if (typeof path === 'string' && path.length > 0) {
        try {
          if (getState().boot === 'ready' || getState().boot === 'failed') return;
          await openProjectByPath(path, { fromIntent: true }); // 启动恢复=系统动作，不取消在途深链意图
        } catch (e) {
          // r57：记忆路径失效≠服务未就绪——如实报错并保持可操作（选择其它目录/重试），
          // 不再被外层 catch 归类成「连接中」空转 60 秒。
          setState((st) => ({ ...st, boot: 'failed', bootError: `记忆的项目路径无法打开：${(e as Error).message}——可打开其它文件夹或修改「启动时打开的项目」` }));
        }
        return;
      }
      // R90: a server-side navigation preference may restore focus without a
      // remembered filesystem path. Load that project so rooms/recipients exist,
      // but do not navigate over an explicit cold deep link or forced room.
      const restoredId = getState().activeProjectId;
      const restored = getState().projects.find((project) => project.id === restoredId);
      if (restored != null && restored.removedAt == null && restored.archivedAt == null && restored.rootPath.length > 0) {
        const initialRoute = window.location.hash.replace(/^#/, '') || '/welcome';
        await openProjectByPath(restored.rootPath, {
          fromIntent: true,
          navigateToRoom: initialRoute === '/welcome' || initialRoute === '/',
        });
        return;
      }

      // Truly empty registry only: create the app-managed default project/room and
      // auto-discovered local AI members. Existing roots are never displaced.
      if (getState().projects.length === 0) {
        try {
          const ensured = await command<{
            project: { id: string; displayName: string; rootPath?: string; canonicalPath?: string } | null;
            created: boolean;
            reason: string;
            availableAgentCount?: number;
          }>('project.ensureDefault', {});
          if (ensured.project != null) {
            await loadProjectRegistry();
            recordWrite(
              'project.ensureDefault',
              `${ensured.created ? '已创建' : '已复用'}「${ensured.project.displayName}」及默认房间${ensured.availableAgentCount === 0 ? '；尚未发现可用 AI 渠道' : `；已准备 ${ensured.availableAgentCount} 位可用 AI`}`,
            );
            const initialRoute = window.location.hash.replace(/^#/, '') || '/welcome';
            await openProjectByPath(ensured.project.rootPath ?? ensured.project.canonicalPath ?? '', {
              fromIntent: true,
              navigateToRoom: initialRoute === '/welcome' || initialRoute === '/',
            });
            return;
          }
        } catch (error) {
          setState((st) => ({
            ...st,
            boot: 'failed',
            bootError: `默认项目准备失败：${(error as Error).message}。可重试或直接打开文件夹`,
          }));
          return;
        }
      }
      // r57：成功读到**空记忆**=正常无项目状态——立即就绪并显示欢迎/打开入口，
      // 不再继续等 60 秒后误报「启动失败」（空项目≠失败）。
      // R67 修复：ready 只看 boot 本身——原条件还要求 activeProjectId===''，但
      // applyServerNavPrefs 可能已按服务端偏好设置了 activeProjectId（保存过导航偏好的
      // 用户），导致「无记忆路径」启动永远停在 pending（恢复轮询等所有 boot 依赖全挂）。
      setState((st) => (st.boot === 'pending' ? { ...st, boot: 'ready' } : st));
      // 演练包竞态兜底：启动器窗口先于种子打开（种子晚写 autoOpen）——欢迎态下留一个
      // **有界后台观察**（不阻塞欢迎交互；用户手动打开后 watcher 自停）。真实新装环境
      // 种子不写该键，观察窗口自然结束、欢迎保持——不冒充失败。
      void (async () => {
        for (let i = 0; i < 75; i += 1) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = getState();
          // r58 P4：手动/显式打开在途同样让观察器停（不只看 activeProjectId——打开在途时
          // 它尚未落位，观察器此刻抢 openProjectByPath 会拿更高代次覆盖用户选择）。
          if (st.activeProjectId !== '' || st.boot === 'failed' || st.openInFlight) return; // 用户已打开/已失败/打开在途——停
          try {
            const again = await command<{ values: Record<string, string> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
            const p2 = again?.values?.['ui.autoOpenProjectPath'];
            if (typeof p2 === 'string' && p2.length > 0) {
              if (getState().activeProjectId !== '') return;
              await openProjectByPath(p2, { fromIntent: true }).catch(() => { /* 种子写入的路径异常：保持欢迎+如实控制台 */ });
              return;
            }
          } catch { /* 服务暂不可达——继续观察 */ }
        }
      })();
      return;
    } catch { /* 服务未就绪——有界重试；真不可达在窗口尽后如实报告 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  setState((s) => (s.activeProjectId === '' ? { ...s, boot: 'failed', bootError: '服务在 60 秒内未就绪——可重试，或直接打开文件夹' } : s));
}

/** R65：服务端导航偏好（navigation_preferences by viewer+client）→ 本地状态合并。
 * 服务端无行=null（保持本地/默认）；无效 id（已移除项目）被过滤；active 不在有效集则忽略。 */
export async function applyServerNavPrefs(): Promise<void> {
  try {
    const r = await command<{ prefs: { activeProjectId: string | null; visibleProjectIds: string[]; expandedProjectIds: string[]; pinnedProjectIds: string[]; fileGitTabs: Record<string, string>; revision: number } | null }>('navigation.get', { clientId: 'desktop-hifi' });
    if (r.prefs == null) {
      // 无偏好行=全量可见（原型/board.view 同口径）：注册表里的日常项目默认进侧栏（首个展开）。
      setState((s) => (s.visibleProjectIds.length > 0 ? s : {
        ...s,
        visibleProjectIds: s.projects.filter((p) => p.removedAt == null).map((p) => p.id),
        expandedProjectIds: s.projects.filter((p) => p.removedAt == null).slice(0, 1).map((p) => p.id),
      }));
      return;
    }
    const prefs = r.prefs;
    const valid = new Set(getState().projects.map((p) => p.id));
    const visible = prefs.visibleProjectIds.filter((id) => valid.has(id));
    const expanded = prefs.expandedProjectIds.filter((id) => valid.has(id));
    const pinned = (prefs.pinnedProjectIds ?? []).filter((id) => valid.has(id));
    setState((s) => ({
      ...s,
      visibleProjectIds: visible.length > 0 ? visible : s.visibleProjectIds,
      expandedProjectIds: expanded.length > 0 ? expanded : s.expandedProjectIds,
      pinnedProjectIds: pinned.length > 0 ? pinned : s.pinnedProjectIds,
      fileGitTabs: Object.keys(prefs.fileGitTabs ?? {}).length > 0 ? (prefs.fileGitTabs as Record<string, 'files' | 'git'>) : s.fileGitTabs,
      activeProjectId: prefs.activeProjectId != null && valid.has(prefs.activeProjectId) ? prefs.activeProjectId : s.activeProjectId,
    }));
  } catch { /* 服务端偏好读取失败：保持本地（不阻塞启动） */ }
}

/** R65：项目全停（无独立批量命令——按 board.view 权威清单逐任务 task.get→task.stop，
 * 每次停止绑定该任务的 run+停止代次（三重绑定合同不变）；失败逐条收集，不静默跳过）。 */
export async function stopAllProjectReal(projectId: string): Promise<{ stopped: number; failed: string[] }> {
  const failed: string[] = [];
  let stopped = 0;
  try {
    const b = await command<{ groups: Array<{ rooms: Array<{ cards: Array<{ taskId: string; title: string; taskStatus: string; runStatus: string | null }> }> }> }>('board.view', { scope: 'project', projectId });
    const cards = (b.groups ?? []).flatMap((g) => (g.rooms ?? []).flatMap((r) => r.cards ?? []));
    const stoppable = cards.filter((c) => ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(c.taskStatus));
    for (const c of stoppable) {
      try {
        const tg = await command<{ task: { id: string; stopGeneration: number }; activeRun: { id: string } | null }>('task.get', { taskId: c.taskId });
        if (tg.activeRun == null) { failed.push(`#${c.title}：无活跃 run（可能已结束）`); continue; }
        await command('task.stop', { taskId: tg.task.id, targetRunId: tg.activeRun.id, expectedStopGeneration: tg.task.stopGeneration });
        stopped += 1;
      } catch (e) {
        failed.push(`${c.title}：${(e as Error).message}`);
      }
    }
    recordWrite('project.stopAll', `项目全停：停止 ${stopped} 个任务${failed.length > 0 ? `，失败 ${failed.length} 个（逐条列出）` : ''}`);
  } catch (e) {
    failed.push(`看板清单读取失败：${(e as Error).message}`);
  }
  return { stopped, failed };
}

/** R65：任务验收开关（project.reviewPolicy.set——CAS；只影响新任务）。 */
export async function setTaskReviewReal(projectId: string, enabled: boolean, expectedRevision: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('project.reviewPolicy.set', { projectId, taskReviewEnabled: enabled, expectedRevision });
    recordWrite('project.reviewPolicy.set', `任务交付验收=${enabled ? '开启' : '关闭'}（仅影响新任务）`);
    await loadProjectRegistry();
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** R65：协作限制（project.collab.get/set——缺席容忍与单轮时限，ms；NULL=服务端默认）。 */
export async function collabGet(projectId: string): Promise<{ absenceToleranceMs: number | null; turnDeadlineMs: number | null; revision: number }> {
  const r = await command<{ absenceToleranceMs: number | null; turnDeadlineMs: number | null; revision: number }>('project.collab.get', { projectId });
  return { absenceToleranceMs: r.absenceToleranceMs, turnDeadlineMs: r.turnDeadlineMs, revision: r.revision };
}

export async function collabSet(projectId: string, patch: { absenceToleranceMs?: number | null; turnDeadlineMs?: number | null }, expectedRevision: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('project.collab.set', { projectId, ...patch, expectedRevision });
    recordWrite('project.collab.set', `协作限制已保存（新派发 turn 起生效；在途不变）`);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function pickAndOpenFolder(): Promise<void> {
  const intent = beginUserNavIntent();
  try {
    const dir = await bridge().pickFolder();
    if (dir == null || !navIntentActive(intent)) return;
    await openProjectByPath(dir, { intent, navigateToRoom: true });
  } catch (e) {
    if (!navIntentActive(intent)) return;
    toast(`打开项目失败：${(e as Error).message}`, 'error');
    setState((s) => (s.activeProjectId === '' ? { ...s, boot: 'failed', bootError: (e as Error).message } : s));
  } finally {
    releaseNavIntent(intent);
  }
}

export interface OpenProjectResult {
  id: string;
  /** 返回后到最终导航之间也可能被新动作取代，调用方不得只凭 id 落位。 */
  isCurrent(): boolean;
}
const cancelledOpen = (): OpenProjectResult => ({ id: '', isCurrent: () => false });

export async function openProjectByPath(path: string, opts?: { fromIntent?: boolean; intent?: NavIntent; navigateToRoom?: boolean }): Promise<OpenProjectResult> {
  // 代次在**请求入口**分配（review-r47 §4：旧 A 响应不得覆盖后来已打开的 B——先请求 A 延迟、
  // 再请求 B 完成，A 回来须被丢弃）。启动自动恢复同理不能覆盖手动打开。
  // R73：fromIntent=定位/对齐链内部调用（不取消所属意图）；用户级打开（打开文件夹/启动恢复）
  // 取消所有在途定位意图。
  // R74（review-r73 §P1）：fromIntent 只是「不取消自己」的布尔开关，**取消凭据必须贯穿函数
  // 内部**——project.open 回执之后、焦点/可见集合提交、本地导航记忆（zs.lastProjectPath）、
  // persistNav 之前逐一核有效性。用户跳走（navigate/新深链/切项目/返回）的旧打开安静收尾：
  // 不切项目、不写偏好、不弹旧错误、不再重试。
  // R75（review-r74 §P1/§P2）：①落位所有权——提交时登记 openInFlightTarget（目标+发起时
  // URL 代次），打开窗口内陈旧路由让位（见 App/ProjectHome）；返回**本次目标 id**，调用方
  // （打开弹窗）按目标落位，不按异步结束时的 activeProjectId。②取消回滚完整性——装载刷新期
  // 取消不只还原焦点：zs.lastProjectPath 与本操作整表替换的 rooms/members/memberRuntimes/dms
  // 投影一并还原（只撤销本操作仍拥有的值；项目注册表不回滚——注册是既成事实）。
  // 无显式凭据的用户直呼也受导航取消约束；启动恢复的系统调用保持原合同。
  const ownsIntent = opts?.fromIntent !== true && opts?.intent == null;
  const intent = ownsIntent ? beginUserNavIntent() : opts?.intent;
  if (!navIntentActive(intent)) return cancelledOpen();
  if (opts?.fromIntent !== true) cancelAllNavIntents(intent);
  const urlSeqAtStart = currentNavSeq();
  const prevFocus = getState().activeProjectId; // 装载刷新期取消时还原焦点（仅当焦点仍指向本次结果）
  let prevLastPath: string | null = null;
  try { prevLastPath = localStorage.getItem('zs.lastProjectPath'); } catch { prevLastPath = null; }
  const prevProjections = {
    rooms: getState().rooms,
    members: getState().members,
    memberRuntimes: getState().memberRuntimes,
    dms: getState().dms,
  };
  const gen = getState().loadGen + 1;
  setState((s) => ({ ...s, loadGen: gen, boot: 'ready', bootError: null, openInFlight: true }));
  let openedId: string | null = null; // 提交时置——回滚只针对本次已提交的目标
  let landedHash: string | null = null;
  /** R75：装载期取消/装载失败+取消共用回滚——焦点/本地记忆/整表投影还原到入口快照。
   * 守卫：本次确已提交、焦点仍指向本次目标且无更新代次、且不是同项目重开——
   * 不覆盖用户随后主动切走的项目/新打开（review-r74 §P2）。 */
  const rollbackOwned = (): boolean => {
    if (openedId == null || prevFocus === openedId) return false;
    const cur = getState();
    if (cur.loadGen !== gen || cur.activeProjectId !== openedId) return false;
    setState((s) => ({
      ...s,
      activeProjectId: prevFocus,
      rooms: prevProjections.rooms,
      members: prevProjections.members,
      memberRuntimes: prevProjections.memberRuntimes,
      dms: prevProjections.dms,
    }));
    try {
      if (prevLastPath == null) localStorage.removeItem('zs.lastProjectPath');
      else localStorage.setItem('zs.lastProjectPath', prevLastPath);
    } catch { /* 本地记忆不可写——尽力 */ }
    return true;
  };
  const operationActive = (): boolean => getState().loadGen === gen && navIntentActive(intent)
    && (opts?.fromIntent === true || (landedHash != null ? window.location.hash === landedHash : currentNavSeq() === urlSeqAtStart));
  const canLand = (): boolean => operationActive() && openedId != null && getState().activeProjectId === openedId;
  const stopListening = intent == null ? () => {} : onNavIntentCancel(intent, () => {
    rollbackOwned();
    setState((s) => s.loadGen === gen ? { ...s, openInFlight: false, openInFlightTarget: null } : s);
  });
  try {
    const data = await command<ProjectOpenData>('project.open', { path }); // 正式合同：{path}
    if (!operationActive()) {
      // project.open 在途回执到达时定位意图已取消（review-r73 反例：URL 已是 settings 而
      // activeProjectId 被旧请求切成 A + 取消后 navigation.set(A)）——零提交。
      recordWrite('project.open.cancelled', `「${path}」回执到达时定位意图已取消——零提交（焦点/可见集合/本地记忆/导航偏好均未改动）`);
      return cancelledOpen();
    }
    const p = data.project;
    openedId = p.id;
    recordWrite('project.open', `打开项目「${p.displayName}」${data.created === true ? '（新注册）' : '（已注册·幂等重开）'}`);
    try {
      const defaults=await command<{created:Array<{displayName:string}>;existing:Array<{displayName:string}>;removedLegacyPlaceholder:boolean}>('member.discoverDefaults',{projectId:p.id});
      if(defaults.created.length>0||defaults.removedLegacyPlaceholder)recordWrite('member.discoverDefaults',`已从本机默认配置准备 ${defaults.created.length} 位 AI 成员${defaults.removedLegacyPlaceholder?'，并替换未使用的旧占位成员':''}（不自动派发）`);
    } catch (error) {
      recordWrite('member.discoverDefaults.failed',`本机默认 AI 发现未完成：${(error as Error).message}`);
    }
    // R65（review-r64 §1A/§4A）：**合并不替换**——B 打开后 A 仍在侧栏/注册表；焦点/可见/展开
    // 各自 upsert（不覆盖其它项目的显示偏好）；旧项目的房间/主池缓存保留为事实，重进即用。
    setState((s) => {
      const others = s.projects.filter((x) => x.id !== p.id);
      const known = s.projects.find((x) => x.id === p.id);
      return {
        ...s,
        loadGen: gen,
        projects: [...others, {
          id: p.id, displayName: p.displayName, rootPath: p.rootPath ?? path, canonicalPath: p.canonicalPath ?? path,
          directoryIdentity: known?.directoryIdentity ?? '', status: 'ok', revision: p.revision ?? 0,
          isGit: known?.isGit ?? false, gitBranch: known?.gitBranch,
          description: known?.description, taskReviewEnabled: known?.taskReviewEnabled,
        }],
        activeProjectId: p.id,
        visibleProjectIds: [...new Set([...s.visibleProjectIds, p.id])],
        expandedProjectIds: [...new Set([...s.expandedProjectIds, p.id])],
        openInFlightTarget: { projectId: p.id, urlSeqAtStart }, // R75：陈旧路由让位（App/ProjectHome 消费）
      };
    });
    try { localStorage.setItem('zs.lastProjectPath', path); } catch { /* 忽略 */ }
    await Promise.all([loadProjectRegistry(), refreshMembers(), refreshRooms(), refreshDms(), refreshSavedMessageRefs()]);
    if (!canLand()) {
      // 成员/房间/DM 装载等待期取消到达——不写导航偏好；本操作拥有的状态回滚到入口快照
      //（焦点/本地记忆 zs.lastProjectPath/整表投影；房间缓存是事实但被本波整表替换——还原）。
      const rolled = rollbackOwned();
      recordWrite('project.open.cancelled', `「${p.displayName}」装载期间定位意图已取消——跳过导航偏好写入${rolled ? '，焦点/本地记忆/装载投影已还原到打开前' : '（焦点已不在本次目标——不回滚，尊重用户后续选择）'}`);
      return cancelledOpen();
    }
    const { persistNav } = await import('./data/store');
    if (!canLand()) { rollbackOwned(); return cancelledOpen(); }
    // 桥模块等待也受代次/归属门保护；成功落位自身的 navigate 不撤销已接受的偏好。
    persistNav(getState(), () => stillCurrent(gen, p.id));
    if (opts?.navigateToRoom === true) {
      // 最终落位也是本操作的一部分：先完成路由交接，再释放占位，旧路由不能插入新打开。
      stopListening();
      if (intent != null) releaseNavIntent(intent);
      const projectRooms = getState().rooms.filter((r) => r.projectId === p.id);
      const first = projectRooms.find((room) => room.archivedAt == null) ?? projectRooms[0];
      const target = first != null ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`;
      navigate(target);
      landedHash = `#${target}`;
    }
    return { id: p.id, isCurrent: canLand };
  } catch (e) {
    if (!operationActive()) {
      // 装载失败 + 意图已取消（review-r74 §P2 覆盖面）：与装载期取消同口径回滚，安静收尾
      //（不向已离开的用户弹旧错误）；未取消的失败照旧抛出（调用方如实提示）。
      rollbackOwned();
      recordWrite('project.open.cancelled', `「${path}」装载失败且定位意图已取消——按取消口径收尾（不弹旧错误）`);
      return cancelledOpen();
    }
    throw e;
  } finally {
    stopListening();
    if (ownsIntent && intent != null) releaseNavIntent(intent);
    // 在途结束（成功/失败/被取代/取消）——按代次条件清：旧调用的收尾不清掉更新调用的标记/目标。
    setState((s) => (s.openInFlight && s.loadGen === gen ? { ...s, openInFlight: false, openInFlightTarget: null } : s));
  }
}

/**
 * R65（review-r64 §1A/§4A）：装载真实注册表（project.list）。**合并不替换**——打开 B 不再
 * 让 A 从侧栏消失；保留已习得的 isGit 事实。status 映射：directory_missing→missing、
 * archived/removed→archivedAt/removedAt 标记位（选择器按真值过滤，不用假时间戳）。
 */
export async function loadProjectRegistry(): Promise<void> {
  const gen = getState().loadGen;
  try {
    const data = await command<{ items: RegistryItem[] }>('project.list', {});
    // 旧打开的注册表快照可能还没有刚注册的C；迟到后不能整表抹掉最新项目。
    if (getState().loadGen !== gen) return;
    setState((prev) => {
      const byIdMap = new Map(prev.projects.map((pr) => [pr.id, pr]));
      const next = (data.items ?? []).map((it) => {
        const known = byIdMap.get(it.id);
        return {
          id: it.id, displayName: it.displayName, rootPath: it.rootPath, canonicalPath: it.canonicalPath,
          directoryIdentity: it.directoryIdentity,
          status: it.status === 'directory_missing' ? ('missing' as const) : ('ok' as const),
          revision: it.revision,
          isGit: known?.isGit ?? false,
          gitBranch: known?.gitBranch,
          description: it.description ?? undefined,
          archivedAt: it.status === 'archived' ? 1 : undefined,
          removedAt: it.status === 'removed' ? 1 : undefined,
          taskReviewEnabled: it.taskReviewEnabled,
        };
      });
      return { ...prev, projects: next };
    });
  } catch { /* 注册表读取失败：保持旧集合（当前项目仍可用），不冒充空 */ }
}

/** R65：项目属性真实保存（displayName/description；expectedRevision 乐观锁——A 的编辑不写进 B）。 */
export async function updateProjectReal(projectId: string, expectedRevision: number, patch: { displayName?: string; description?: string }): Promise<{ ok: boolean; error?: string; project?: { id: string; displayName: string; description: string | null; revision: number } }> {
  try {
    const r = await command<{ project: { id: string; displayName: string; description: string | null; revision: number } }>('project.update', { projectId, expectedRevision, ...patch });
    recordWrite('project.update', `项目属性已保存（revision ${r.project.revision}，回读一致由服务端事务保证）`);
    await loadProjectRegistry();
    return { ok: true, project: r.project };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** R65：项目生命周期（archive/unarchive/remove/restore/relocate）——真实命令+注册表刷新。 */
export async function projectLifecycleReal(projectId: string, expectedRevision: number, action: 'archive' | 'unarchive' | 'remove' | 'restore' | 'relocate', newRootPath?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('project.lifecycle', { projectId, expectedRevision, action, ...(action === 'relocate' && newRootPath != null ? { newRootPath } : {}) });
    recordWrite('project.lifecycle', `${action}（revision ${expectedRevision} 基线）`);
    await loadProjectRegistry();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** R65：房间属性/归档/成员真实命令（乐观锁+守卫由服务端裁决，UI 保留输入并如实报错）。 */
export async function updateRoomReal(roomId: string, expectedRevision: number, patch: { name?: string; description?: string; coordinatorMemberId?: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('room.update', { roomId, expectedRevision, ...patch });
    recordWrite('room.update', `房间属性已保存（revision ${expectedRevision} 基线）`);
    await refreshRooms().catch(() => { /* 名单下次刷新 */ });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function roomArchiveReal(roomId: string, expectedRevision: number, action: 'archive' | 'unarchive'): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('room.archive', { roomId, expectedRevision, action });
    recordWrite('room.archive', action === 'archive' ? '房间已归档（历史保留·只读）' : '房间已取消归档');
    await refreshRooms().catch(() => { /* 下次刷新 */ });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function roomMembersSetReal(roomId: string, memberId: string, action: 'add' | 'remove'): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('room.members.set', { roomId, memberId, action });
    recordWrite('room.members.set', `${action === 'add' ? '加入' : '移出'}房间（新增只对后续新任务生效——运行中研讨名单冻结）`);
    await refreshRooms().catch(() => { /* 下次刷新 */ });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** R65：焦点切换（不重开目录）——切 activeProjectId 并刷新该项目的房间/成员/私信投影。
 * 已打开项目的房间事实在库里，无需 project.open；未注册 id 返回 false（调用方如实提示）。 */
export async function switchFocusProject(projectId: string): Promise<boolean> {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  if (p == null) return false;
  if (s.activeProjectId === projectId) return true;
  setState((st) => ({ ...st, activeProjectId: projectId, visibleProjectIds: [...new Set([...st.visibleProjectIds, projectId])], expandedProjectIds: [...new Set([...st.expandedProjectIds, projectId])] }));
  await Promise.all([refreshRooms(projectId), refreshMembers(projectId), refreshDms(projectId)]);
  const { persistNav } = await import('./data/store');
  persistNav(getState());
  return true;
}

export interface SidebarRoomSummary {
  id: string;
  name: string;
  archivedAt?: number;
  revision: number;
}

/** Sidebar-only room index. It is deliberately independent of AppState.rooms,
 * which represents the active project's full roster-bearing projection. */
export async function loadSidebarRooms(projectId: string): Promise<SidebarRoomSummary[]> {
  const data = await command<RoomListData>('room.list', { projectId });
  return (data.items ?? []).map((room) => ({
    id: room.id,
    name: room.name,
    archivedAt: room.archivedAt ?? undefined,
    revision: room.revision ?? 0,
  }));
}

/** Open a room owned by another project without letting a late response steal
 * navigation from a newer intent. The room is checked before focus is committed;
 * only after the target project's projections load do we route to it. */
export async function openSidebarRoom(projectId: string, roomId: string): Promise<boolean> {
  const intent = beginUserNavIntent();
  const before = getState();
  const previous = {
    activeProjectId: before.activeProjectId,
    loadGen: before.loadGen ?? 0,
    visibleProjectIds: before.visibleProjectIds,
    expandedProjectIds: before.expandedProjectIds,
    rooms: before.rooms,
    members: before.members,
    memberRuntimes: before.memberRuntimes,
    dms: before.dms,
  };
  let gen: number | null = null;
  let committed = false;
  try {
    const project = getState().projects.find((item) => item.id === projectId);
    if (project == null || project.removedAt != null) {
      toast('该项目已移除或不在项目列表中，未切换', 'error');
      return false;
    }
    if (project.archivedAt != null) {
      toast('该项目已归档，历史只读，不能进入日常房间', 'warn');
      return false;
    }
    const rooms = await loadSidebarRooms(projectId);
    if (!navIntentActive(intent)) return false;
    const target = rooms.find((room) => room.id === roomId && room.archivedAt == null);
    if (target == null) {
      toast('目标房间不存在或已归档，项目与草稿均未切换', 'error');
      return false;
    }
    const nextGen = (getState().loadGen ?? 0) + 1;
    gen = nextGen;
    setState((state) => ({
      ...state,
      loadGen: nextGen,
      activeProjectId: projectId,
      openInFlight: true,
      visibleProjectIds: [...new Set([...state.visibleProjectIds, projectId])],
      expandedProjectIds: [...new Set([...state.expandedProjectIds, projectId])],
    }));
    const loaded = await Promise.allSettled([refreshRooms(projectId), refreshMembers(projectId), refreshDms(projectId)]);
    if (loaded[0]?.status === 'rejected') throw loaded[0].reason;
    if (!navIntentActive(intent) || getState().activeProjectId !== projectId) return false;
    if (loaded[1]?.status === 'rejected' || loaded[2]?.status === 'rejected') {
      recordWrite('navigation.room.partial', '房间已装载，但成员或私信投影读取失败；保留旧投影并进入目标房间');
    }
    if (!getState().rooms.some((room) => room.id === roomId && room.projectId === projectId)) {
      toast('房间装载失败，未进入目标房间；当前草稿仍保留', 'error');
      return false;
    }
    const { persistNav } = await import('./data/store');
    if (!navIntentActive(intent)) return false;
    persistNav(getState(), () => navIntentActive(intent) && getState().activeProjectId === projectId);
    recordWrite('navigation.room.open', `切换到项目「${project.displayName}」并进入房间「${target.name}」`);
    navigate(`/project/${projectId}/room/${roomId}`);
    setState((state) => ({ ...state, openInFlight: false }));
    committed = true;
    return true;
  } catch (error) {
    if (navIntentActive(intent)) {
      toast(`打开项目房间失败：${(error as Error).message}；页面与草稿保留`, 'error');
    }
    return false;
  } finally {
    if (!committed && gen != null && getState().loadGen === gen) {
      const stillOwnsFocus = getState().activeProjectId === projectId;
      setState((state) => stillOwnsFocus
        ? {
            ...state,
            activeProjectId: previous.activeProjectId,
            loadGen: previous.loadGen,
            openInFlight: false,
            visibleProjectIds: previous.visibleProjectIds,
            expandedProjectIds: previous.expandedProjectIds,
            rooms: previous.rooms,
            members: previous.members,
            memberRuntimes: previous.memberRuntimes,
            dms: previous.dms,
          }
        : { ...state, openInFlight: false });
    }
    releaseNavIntent(intent);
  }
}

export async function refreshMembers(projectIdArg?: string): Promise<void> {
  const gen = getState().loadGen;
  const projectId = projectIdArg ?? getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<RoomMembersData>('member.list', { projectId });
  if (!stillCurrent(gen, projectId)) return; // 迟到响应：项目已切走——丢弃（review-r46 §5 反例）
  // r63：runtime 绑定投影（一次 runtime.status 拿全量 memberBindings+防护自述——失败=unknown
  // 不冒充，成员页/发送区共用；不计成员页局部回读）。
  void command<{ memberBindings: Array<{ memberId: string; kind: string | null; model: string | null }>; dispatchGuard: { fakeAllowed: boolean; realDispatchGuard: boolean } }>('runtime.status', {})
    .then((rt) => {
      if (!stillCurrent(gen, projectId)) return;
      const map: Record<string, { kind: string | null; model: string | null; status: 'bound' | 'unbound' | 'unknown' }> = {};
      for (const b of rt.memberBindings ?? []) map[b.memberId] = { kind: b.kind ?? null, model: b.model ?? null, status: b.kind != null && b.kind !== '(默认 runtime)' ? 'bound' : 'unbound' };
      setState((prev) => ({ ...prev, memberRuntimes: map, dispatchGuard: rt.dispatchGuard ?? null }));
    })
    .catch(() => { if (stillCurrent(gen, projectId)) setState((prev) => ({ ...prev, dispatchGuard: prev.dispatchGuard })); });
  setState((prev) => ({
    ...prev,
    members: (data.items ?? []).map((m) => ({
      id: m.id, projectId, profileId: '', displayName: m.displayName, description:m.description,revision:m.revision, enabled: m.enabled,
      principalType: m.principalType,
      workState: 'unknown' as const, workStateReason:'实时状态未提供', model: '', effort: 'medium' as const, internalSubagents: false, isCoordinatorDefault: false,
    })),
  }));
}

export async function refreshRooms(projectIdArg?: string): Promise<void> {
  const gen = getState().loadGen;
  const projectId = projectIdArg ?? getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<RoomListData>('room.list', { projectId });
  if (!stillCurrent(gen, projectId)) return;
  const rooms = data.items ?? [];
  // 房间名单（@ 候选唯一来源——review-r46 §3）：每房间 member.list({projectId, roomId})。
  // 读取失败**保留旧名单**并就地报错（review-r47 §5——不呈现成「暂无成员」）；协调者不伪造
  // （取首个成员不是服务端事实——置空，呈现层不依赖）。
  const rosterErrors: Record<string, string> = {};
  const rosters = await Promise.all(rooms.map(async (r) => {
    try {
      const roster = await command<RoomMembersData>('member.list', { projectId, roomId: r.id });
      return { roomId: r.id, memberIds: (roster.items ?? []).filter((m) => m.enabled).map((m) => m.id) };
    } catch (e) {
      rosterErrors[`roster:${r.id}`] = (e as Error).message;
      const oldRoom = getState().rooms.find((x) => x.id === r.id);
      return { roomId: r.id, memberIds: oldRoom?.memberIds ?? [] }; // 旧名单兜底
    }
  }));
  if (!stillCurrent(gen, projectId)) return;
  setState((prev) => ({
    ...prev,
    rooms: rooms.map((r, i) => {
      const oldRoom = prev.rooms.find((x) => x.id === r.id);
      const roster = rosters[i];
      const failed = rosterErrors[`roster:${r.id}`] != null;
      return {
        id: r.id, projectId, name: r.name, conversationId: r.conversationId,
        coordinatorMemberId: r.coordinatorMemberId ?? (failed ? (oldRoom?.coordinatorMemberId ?? '') : ''),
        memberIds: roster?.memberIds ?? [],
        description: r.description ?? undefined,
        archivedAt: r.archivedAt ?? undefined,
        revision: r.revision ?? oldRoom?.revision ?? 0,
        unread: 0,
      };
    }),
    readErrors: { ...prev.readErrors, ...rosterErrors },
  }));
}

/* ---------- 收藏（r61 G6：可切换——按正式收藏事实显示已收藏状态，再点取消；页面/列表同步） ---------- */

/** 刷新 message 类收藏投影（saved.list 全量拉取后按 kind 过滤）。读取失败保持旧投影——
 * 按钮仍可用，点击后按回执更新（不因投影过期把用户锁死）。 */
export async function refreshSavedMessageRefs(): Promise<void> {
  try {
    const r = await command<{ items: Array<{ kind: string; ref: string }> }>('saved.list', {});
    const next: Record<string, boolean> = {};
    for (const it of r.items ?? []) if (it.kind === 'message') next[it.ref] = true;
    setState((s) => ({ ...s, savedMessageRefs: next }));
  } catch { /* 保持旧投影 */ }
}

/** 收藏切换：已收藏→saved.remove（只删收藏行，原内容不动）；未收藏→saved.add（幂等）。
 * 同消息在途互斥（快速连点：后到点击直接忽略，第一笔的回执决定最终状态——不交错覆盖、
 * 不伪成功）；成功才更新投影；失败如实返回错误且状态不变。 */
const savedToggling = new Set<string>();
export async function toggleSavedMessage(m: { id: string; body: string }, projectId: string | null): Promise<{ ok: boolean; saved: boolean; busy?: boolean; error?: string }> {
  if (savedToggling.has(m.id)) return { ok: false, saved: getState().savedMessageRefs[m.id] === true, busy: true };
  savedToggling.add(m.id);
  try {
    const wasSaved = getState().savedMessageRefs[m.id] === true;
    if (wasSaved) {
      await command<{ removed: boolean }>('saved.remove', { kind: 'message', ref: m.id });
      setState((s) => { const next = { ...s.savedMessageRefs }; delete next[m.id]; return { ...s, savedMessageRefs: next }; });
      recordWrite('saved.remove', `取消收藏消息 ${m.id.slice(0, 12)}…（只删收藏行，原内容不动）`);
      return { ok: true, saved: false };
    }
    const r = await command<{ existed: boolean }>('saved.add', { kind: 'message', ref: m.id, title: m.body.slice(0, 60), ...(projectId != null ? { projectId } : {}) });
    setState((s) => ({ ...s, savedMessageRefs: { ...s.savedMessageRefs, [m.id]: true } }));
    recordWrite('saved.add', `收藏消息 ${m.id.slice(0, 12)}…${r.existed === true ? '（已收藏——幂等）' : ''}`);
    return { ok: true, saved: true };
  } catch (e) {
    return { ok: false, saved: getState().savedMessageRefs[m.id] === true, error: (e as Error).message };
  } finally {
    savedToggling.delete(m.id);
  }
}

export async function refreshDms(projectIdArg?: string): Promise<void> {  const gen = getState().loadGen;
  const projectId = projectIdArg ?? getState().activeProjectId;
  if (projectId === '') return;
  const data = await command<ConvListData>('conversation.list', { projectId });
  if (!stillCurrent(gen, projectId)) return;
  setState((prev) => ({
    ...prev,
    dms: (data.conversations ?? []).map((c) => ({
      id: c.conversationId, projectId: c.projectId ?? projectId,
      peerDisplayName: c.peerDisplayName ?? '成员', title: c.title ?? '', unread: c.unread ?? 0,
      memberIds: [], threadId: '', createdAt: 0, lastMessageAt: 0,
      execState: c.execState ?? 'idle', archivedAt: c.archivedAt ?? undefined, lastMessagePreview: c.lastMessagePreview ?? '',
      // r56 H4 操作面投影：revision CAS/停止三重绑定/中断恢复/待验收/排队数。
      revision: c.revision ?? 0,
      activeTaskId: c.activeTaskId ?? null, activeRunId: c.activeRunId ?? null, activeStopGeneration: c.activeStopGeneration ?? 0,
      interruptedTasks: c.interruptedTasks ?? [], pendingReview: c.pendingReview ?? null,
      reworkPending: c.reworkPending ?? null,
      queuedCount: c.queuedCount ?? 0, stopPending: c.stopPending ?? false,
    })),
  }));
}

/* ---------- 快照装载（读失败≠空态：保留旧快照+readErrors） ---------- */

// Read tickets cover both root projections: late replies cannot roll back newer facts.
let rootReadTicket = 0;
const rootTickets = new Map<string, number>();
const poolTickets = new Map<string, number>();
const threadTickets = new Map<string, number>();

export async function loadRoomPool(roomId: string): Promise<void> {
  const ticket = ++rootReadTicket;
  poolTickets.set(roomId, ticket);
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  const room = getState().rooms.find((r) => r.id === roomId);
  if (room == null || room.projectId !== projectId) return;
  try {
    const data = await command<PoolData>('room.pool', { roomId, limit: 50 });
    if (!stillCurrent(gen, projectId) || poolTickets.get(roomId) !== ticket) return;
    // 主池条目=线程卡（第五十一轮 H2）：room.pool 的真实投影——记录串 taskId=null（E1），
    // 不伪造任务标题；正文缺省空串由呈现层标注。
    const cards: ThreadCard[] = (data.items ?? []).map((it) => ({
      threadId: it.threadId, projectId, roomId,
      anchorMessageId: it.anchorMessageId ?? '',
      taskId: it.taskId ?? null, taskStatus: it.taskStatus ?? null, taskResponseKind:it.taskResponseKind, roomTaskNumber: it.roomTaskNumber ?? null,
      taskTitle: it.taskTitle ?? null,
      taskObjective: it.taskObjective, taskReviewPolicy: it.taskReviewPolicy, taskRevision: it.taskRevision,
      taskMode: it.taskMode, ownerMemberId: it.ownerMemberId,
      latestRun: it.latestRun,
      body: it.body?.text ?? '', createdAt: it.createdAt ?? 0,
      authorType: it.authorType, authorId: it.authorId, formalAttachments: it.attachments,
      replyCount: it.replyCount ?? 0, lastReplyAt: it.lastReplyAt ?? null,
      unread: it.unread ?? 0, muted: it.muted === true, followed: it.followed === true,
    }));
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[roomId];
      return { ...prev, roomPool: { ...prev.roomPool, [roomId]: cards }, readErrors: errors };
    });
    hydrateRoomFromPool(getState(), projectId, roomId, cards, ticket);
  } catch (e) {
    if (!stillCurrent(gen, projectId) || poolTickets.get(roomId) !== ticket) return;
    const msg = (e as Error).message;
    setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [roomId]: msg } }));
  }
}

/* ---------- AppState 视图模型水合（R64 原型还原：真实数据 → 原型页面消费的字段） ----------
 * 原型页面（Room/FilesGit/Settings…）经 selectors 读 AppState.threads/messages/tasks 等；
 * 正式真实数据住在 HifiExtension（roomPool/threadEntities/threadMessages/threadTasks）。
 * 水合层把真实投影同步进 AppState 视图模型——原型组件零改动运行；真实事实源不变
 *（每次快照装载后重放本房间/本线程的水合，切项目由 openProjectByPath 清空）。 */

/**
 * room.pool 卡片 → AppState：threads（线程实体）、messages（根锚消息）、tasks（最小任务
 * 投影：真实 id/标题/状态/号）、subscriptions（muted/followed 只读事实——切换走 thread.subscribe）。
 * 未装载回复的线程其 unread/replyCount 由 selectors 兜底读卡片（见 selectors.ts R64 注）。
 */
function hydrateRoomFromPool(prev: HifiState, projectId: string, roomId: string, cards: ThreadCard[], ticket: number): void {
  const room = prev.rooms.find((r) => r.id === roomId);
  const convId = room?.conversationId ?? '';
  const threads = cards.map((c) => ({
    id: c.threadId, projectId, roomId, conversationId: convId,
    anchorMessageId: c.anchorMessageId, rootTaskId: c.taskId ?? undefined,
    status: 'open' as const, lastMessageSeq: 0, revision: 0,
  }));
  const roots = cards.filter((c) => c.body.length > 0 || c.createdAt > 0).map((c) => ({
    id: c.anchorMessageId || `anchor:${c.threadId}`, projectId, roomId, threadId: undefined,
    authorType: c.authorType ?? 'human', authorId: c.authorId ?? 'you', kind: 'text' as const,
    body: c.body, createdAt: c.createdAt, formalAttachments: c.formalAttachments,
  }));
  const stableRoots = roots.map((root) => {
    const old = prev.messages.find((m) => m.id === root.id);
    if ((rootTickets.get(root.id) ?? 0) > ticket && old != null) return old;
    rootTickets.set(root.id, ticket);
    return root.formalAttachments == null && old != null ? { ...root, formalAttachments: old.formalAttachments } : root;
  });
  const anchors = { ...prev.threadAnchors };
  for (const c of cards) {
    const root = stableRoots.find((m) => m.id === c.anchorMessageId);
    if (root != null && anchors[c.threadId] != null) anchors[c.threadId] = root;
  }
  const tasks = cards.filter((c) => c.taskId != null).map((c) => ({
    id: c.taskId as string, projectId, roomId, conversationThreadId: c.threadId,
    roomTaskNumber: c.roomTaskNumber ?? 0, title: c.taskTitle ?? '',
    responseKind:c.taskResponseKind, objective: c.taskObjective ?? null, status: (c.taskStatus ?? 'OPEN') as Task['status'], revision: c.taskRevision ?? 0,
    reviewPolicy: c.taskReviewPolicy ?? undefined, mode: c.taskMode ?? undefined, ownerMemberId: c.ownerMemberId ?? undefined,
    latestRun: c.latestRun,
    displayNumber: c.roomTaskNumber ?? 0,
  }));
  const subscriptions: Record<string, { followed: boolean; muted: boolean }> = {};
  for (const c of cards) subscriptions[c.threadId] = { followed: c.followed, muted: c.muted };
  setState((s) => ({
    ...s,
    threads: [...s.threads.filter((t) => t.roomId !== roomId), ...threads],
    messages: [...s.messages.filter((m) => m.roomId !== roomId || m.threadId != null), ...stableRoots],
    tasks: [...s.tasks.filter((t) => t.roomId !== roomId), ...tasks],
    subscriptions: { ...s.subscriptions, ...subscriptions },
    threadAnchors: anchors,
  }));
}

/**
 * thread.get/history/task.get 快照 → AppState：threads 实体（含 conversationId）、锚消息、
 * 回复消息、完整任务投影（title/status/号 + pendingDelivery/reworkPending → taskDeliveries/
 * runs 最小投影）、readStates（threadReadSeq 同步——首条未读分隔线用真实水位）。
 */
function hydrateThreadFromSnapshots(threadId: string, ticket = ++rootReadTicket): void {
  const s = getState();
  const thread = s.threadEntities[threadId];
  if (thread == null) return;
  const anchor = s.threadAnchors[threadId] ?? null;
  const replies = s.threadMessages[threadId] ?? [];
  const detail = s.threadTasks[threadId];
  const readSeq = s.threadReadSeq[threadId] ?? 0;
  setState((prev) => {
    const otherThreads = prev.threads.filter((t) => t.id !== threadId);
    const otherMessages = prev.messages.filter((m) => m.threadId !== threadId && m.id !== anchor?.id);
    const oldRoot = prev.messages.find((m) => m.id === anchor?.id);
    const staleRoot = anchor != null && (rootTickets.get(anchor.id) ?? 0) > ticket;
    if (anchor != null && !staleRoot) rootTickets.set(anchor.id, ticket);
    const anchorMsg = staleRoot && oldRoot != null ? [oldRoot] : anchor == null ? [] : [{
      id: anchor.id, projectId: thread.projectId, roomId: thread.roomId, threadId: undefined,
      authorType: anchor.authorType, authorId: anchor.authorId, kind: 'text' as const,
      body: anchor.body, createdAt: anchor.createdAt,
      formalAttachments: (anchor as Message & { formalAttachments?: unknown }).formalAttachments,
    }];
    const nextTasks = [...prev.tasks];
    if (detail != null) {
      const idx = nextTasks.findIndex((t) => t.id === detail.id);
      const taskView = {
        id: detail.id, projectId: thread.projectId, roomId: thread.roomId,
        conversationThreadId: threadId, roomTaskNumber: detail.roomTaskNumber,
        responseKind:detail.responseKind, title: detail.title, objective: detail.objective ?? null, status: detail.status as Task['status'],
        revision: detail.revision, reviewPolicy: detail.reviewPolicy,
        currentDeliveryId: detail.currentDeliveryId ?? undefined,
        ownerMemberId: detail.ownerMemberId ?? undefined, parentTaskId: detail.parentTaskId ?? undefined,
        mode: detail.mode, latestRun: detail.activeRun as Task['latestRun'], displayNumber: detail.roomTaskNumber,
      };
      if (idx >= 0) nextTasks[idx] = taskView; else nextTasks.push(taskView);
      // task.get only supplies a run hint and a pending-delivery identity. It cannot certify
      // a full WorkflowRun/TaskDelivery. Detail views read task.details/files.view instead;
      // don't manufacture mode, stage, zero budgets, empty manifests or timestamps here.
    }
    return {
      ...prev,
      threads: [...otherThreads, thread],
      messages: [...otherMessages, ...anchorMsg, ...replies],
      tasks: nextTasks,
      readStates: { ...prev.readStates, [threadId]: readSeq },
    };
  });
}



interface ThreadGetData {  thread: { id: string; projectId: string; conversationId: string; roomId: string; anchorMessageId: string; rootTaskId: string | null; status: string; lastMessageSeq: number; revision: number };
  members?:ThreadMembersSnapshot;
  progress?:ThreadVisibleProgress[];
  anchor: { id: string; authorType: string; authorId: string; body: { text: string }; createdAt: number; conversationSeq: number; attachments?: Array<{ artifactId: string; filename: string; kind: string; detailMarkdown?: boolean }> } | null;
  lastReadSeq: number;
}
/**
 * thread.history 的回复项。`body` 是服务端 `JSON.parse(body_json)` 的完整对象
 * （R91：含 `collaborationStage`），loader 只取 `text` 正文并转译阶段标记。
 */
export interface ThreadHistoryItem { id: string; authorType: string; authorId: string; seq: number; body: { text?: string; collaborationStage?: unknown; detailMarkdown?: string; runtimeControlResult?: string } | null; createdAt: number; attachments?: Array<{ artifactId: string; filename: string; kind: string; sizeBytes?: number; detailMarkdown?: boolean }>;replyExecution?:Message['formalReplyExecution'] }
interface ThreadHistoryData { items: ThreadHistoryItem[]; rootAttachments: Array<{ artifactId: string; filename: string; kind: string }> }
interface TaskGetData {
  task: { response_kind?:'conversation'|'work'|null; id: string; title: string; status: string; room_id: string; conversation_thread_id: string | null; room_task_number: number; revision: number; stopGeneration: number;
    objective?: string | null; review_policy?: Task['reviewPolicy']; mode?: Task['mode'] | null; owner_member_id?: string | null; parent_task_id?: string | null; current_delivery_id?: string | null;
    deliberationBudget?: { maxTurns: number } | null };
  activeRun: { id: string; status: string } | null;
  pendingDelivery: { id: string; revision: number; manifest_hash: string } | null;
  reworkPending?: { deliveryId: string; deliveryRevision: number; manifestHash: string; sourceRunId: string; note: string | null; queued: boolean } | null;
  lastStartupFailureMessage?: string;
}

/**
 * 历史回复项 → 呈现用 Message（真实作者/真实 seq/附件摘要保持原样）。
 * R91 模块3：`body.collaborationStage` 只转译成呈现标签，正文只取 text。
 */
export const msgOfReply = (projectId: string, roomId: string, threadId: string, it: ThreadHistoryItem): Message => {
  const stage = collaborationStageOfBody(it.body);
  const readable = chatAnswer(it.body?.text??'',it.authorType);
  const message: Message = {
    id: it.id, projectId, roomId, threadId, taskId: undefined,
    authorType: it.authorType as Message['authorType'], authorId: it.authorId, kind: 'text',
    body: stripStageHeading(readable, stage), createdAt: it.createdAt, threadMessageSeq: it.seq,
    attachmentIds: [], formalAttachments: it.attachments ?? [],
    formalReplyExecution:it.replyExecution,
  detailMarkdown: (it.attachments??[]).some(a=>a.detailMarkdown) ? undefined : detailMarkdownOfBody(it.body),
  };
  if (stage != null) message.collaborationStage = stage;
  return message;
};

/**
 * 装载线程视图：thread.get（实体+根消息+水位）→ thread.history（回复+根附件）→
 * task.get（有根任务才查）。readGate 独立水位：thread.markRead 只在**发起此刻**门通过才发
 * （当前线程+前台/贴底/接管——ThreadPage 注册；与 DM conversationSeq 门分开，review-r50 §4）。
 */
export async function loadThread(threadId: string, opts: { markRead?: boolean } = {}): Promise<void> {
  const ticket = ++rootReadTicket;
  threadTickets.set(threadId, ticket);
  const initialProjectId = getState().activeProjectId;
  const gen = getState().loadGen;
  try {
    const got = await command<ThreadGetData>('thread.get', { threadId });
    const projectId = got.thread.projectId;
    if (!stillCurrent(gen, projectId) || threadTickets.get(threadId) !== ticket) return; // 项目已切走——丢弃迟到响应
    const thread = {
      id: got.thread.id, projectId, conversationId: got.thread.conversationId, roomId: got.thread.roomId,
      anchorMessageId: got.thread.anchorMessageId, rootTaskId: got.thread.rootTaskId ?? undefined,
      status: (got.thread.status === 'archived' ? 'archived' : 'open') as Thread['status'],
      lastMessageSeq: got.thread.lastMessageSeq, revision: got.thread.revision,
    };
    const anchor: Message | null = got.anchor == null ? null : {
      id: got.anchor.id, projectId, roomId: thread.roomId, threadId: undefined,
      authorType: got.anchor.authorType as Message['authorType'], authorId: got.anchor.authorId,
      kind: 'text', body: chatAnswer(got.anchor.body?.text??'',got.anchor.authorType), createdAt: got.anchor.createdAt,
      attachmentIds: [], formalAttachments: got.anchor.attachments ?? getState().threadAnchors[threadId]?.formalAttachments,
    };
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[`thread:${threadId}`];
      return {
        ...prev,
        threadEntities: { ...prev.threadEntities, [threadId]: thread },
        threadAnchors: { ...prev.threadAnchors, [threadId]: anchor != null && (rootTickets.get(anchor.id) ?? 0) > ticket
          ? prev.messages.find((m) => m.id === anchor.id) ?? prev.threadAnchors[threadId] ?? anchor : anchor },
        threadReadSeq: { ...prev.threadReadSeq, [threadId]: got.lastReadSeq },
        ...(got.members?{threadMemberships:{...prev.threadMemberships,[threadId]:got.members},followers:{...prev.followers,[threadId]:got.members.memberIds}}:{}),
        ...(got.progress?{threadProgress:{...prev.threadProgress,[threadId]:{items:got.progress,readAt:Date.now()}}}:{}),
        readErrors: errors,
      };
    });
    hydrateThreadFromSnapshots(threadId, ticket);
    const hist = await command<ThreadHistoryData>('thread.history', { threadId, limit: 100 });
    if (!stillCurrent(gen, projectId) || threadTickets.get(threadId) !== ticket) return;
    const replies = (hist.items ?? []).map((it) => msgOfReply(projectId, thread.roomId, threadId, it));
    // r56：**合并**而非整表替换——可见期轻量刷新（5s）会把补读出的更早历史整页冲掉
    //（长历史定位后元素消失）。按 id 去重合并、seq 升序，保留已补读窗口。
    setState((prev) => {
      const cur = prev.threadMessages[threadId] ?? [];
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of replies) byId.set(m.id, m);
      const merged = [...byId.values()].sort((a, b) => (a.threadMessageSeq ?? 0) - (b.threadMessageSeq ?? 0));
      return { ...prev, threadMessages: { ...prev.threadMessages, [threadId]: merged } };
    });    // thread.get owns the atomic root projection. Legacy missing attachments are unread,
    // while [] is authoritative; history failures must never clear confirmed roots.
    if (anchor != null && got.anchor?.attachments == null && hist.rootAttachments != null) {
      setState((prev) => ({ ...prev, threadAnchors: { ...prev.threadAnchors,
        [threadId]: { ...anchor, formalAttachments: hist.rootAttachments } } }));
    }
    // 任务详情（记录串无根任务——不查不写键；「详情」分组如实显示记录串说明）。
    if (thread.rootTaskId != null) {
      const tg = await command<TaskGetData>('task.get', { taskId: thread.rootTaskId });
      if (!stillCurrent(gen, projectId) || threadTickets.get(threadId) !== ticket) return;
      const detail: ThreadTaskDetail = {
        id: tg.task.id, responseKind:tg.task.response_kind, title: tg.task.title, status: tg.task.status, roomId: tg.task.room_id,
        threadId: tg.task.conversation_thread_id, roomTaskNumber: tg.task.room_task_number,
        revision: tg.task.revision, stopGeneration: tg.task.stopGeneration,
        objective: tg.task.objective, reviewPolicy: tg.task.review_policy, mode: tg.task.mode ?? undefined,
        ownerMemberId: tg.task.owner_member_id, parentTaskId: tg.task.parent_task_id, currentDeliveryId: tg.task.current_delivery_id,
        activeRun: tg.activeRun, pendingDelivery: tg.pendingDelivery == null ? null
          : { id: tg.pendingDelivery.id, revision: tg.pendingDelivery.revision, manifestHash: tg.pendingDelivery.manifest_hash },
        reworkPending: tg.reworkPending ?? null,
        lastStartupFailureMessage: tg.lastStartupFailureMessage ?? null,
      };
      setState((prev) => ({ ...prev, threadTasks: { ...prev.threadTasks, [threadId]: detail } }));
    } else {
      setState((prev) => { const next = { ...prev.threadTasks }; delete next[threadId]; return { ...prev, threadTasks: next }; });
    }
    // R64：真实快照 → AppState 视图模型水合（原型线程面板消费 threads/messages/tasks/readStates）。
    hydrateThreadFromSnapshots(threadId, ticket);
    // 阅读水位（独立门）：最新回复 seq ≤ thread.lastMessageSeq（未来序号服务端拒绝）。
    const lastSeq = replies.length > 0 ? (replies[replies.length - 1]?.threadMessageSeq ?? 0) : 0;
    if (opts.markRead === true && lastSeq > got.lastReadSeq && canMarkThreadRead(threadId)) {
      void command('thread.markRead', { threadId, throughMessageSeq: lastSeq })
        .then(() => {
          if (!stillCurrent(gen, projectId) || threadTickets.get(threadId) !== ticket) return;
          setState((prev) => ({ ...prev, threadReadSeq: { ...prev.threadReadSeq, [threadId]: lastSeq } }));
          void loadRoomPool(thread.roomId).catch(() => { /* 主池未读汇总下次刷新再对 */ });
        })
        .catch(() => { /* 下次进入再推进 */ });
    }
  } catch (e) {
    const s = getState();
    // 归属未变才记错（迟到失败不污染当前线程）。
    if (stillCurrent(gen, initialProjectId) && threadTickets.get(threadId) === ticket && (s.threadEntities[threadId] == null || s.threadEntities[threadId]!.projectId === initialProjectId)) {
      setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [`thread:${threadId}`]: (e as Error).message } }));
    }
  }
}

/**
 * R72：把指定项目对齐为活跃项目（线程/房间跨项目定位的公共前置）。
 * loadThread/loadRoomPool 的 stillCurrent 双门（loadGen+activeProjectId）把「目标
 * ≠ 活跃项目」的装载当迟到响应丢弃——看板/待办/归档跨项目跳线程、深链冷启动都会踩中。
 * 对齐方式按会话内事实分列：房间数据已装载（旧项目缓存保留）→ focusProject 轻切换
 * （与侧栏点击同链）；未装载 → openProjectByPath 全链（幂等合并不替换）。
 * 有界重试吸收与启动恢复观察器并发打开的窗口。
 */
export async function ensureProjectActive(projectId: string, intent?: NavIntent): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // R73：每个 await 之后/每次重试/每次提交焦点之前核意图——用户跳走或切项目后，
    // 旧定位不得再抢焦点或继续重试（review-r72 §P1 反例：迟到 thread.get 回执后
    // locateThread 已把焦点从 B 切到 A，而用户停留在设置页）。
    if (!navIntentActive(intent)) return;
    // 「活跃」不等于「已装载」：applyServerNavPrefs 重启后会恢复 activeProjectId 但不装
    // 房间/成员（不走 openProjectByPath）——此时直达房间/线程仍会「找不到该房间」。
    // 活跃且房间已装载才可早退。
    if (getState().activeProjectId === projectId && getState().rooms.some((r) => r.projectId === projectId)) return;
    let proj = getState().projects.find((p) => p.id === projectId);
    if (proj == null) await loadProjectRegistry().catch(() => undefined);
    if (!navIntentActive(intent)) return;
    proj = getState().projects.find((p) => p.id === projectId);
    if (proj == null || typeof proj.rootPath !== 'string' || proj.rootPath.length === 0) {
      throw new Error(`项目不在注册表或路径缺失（可能已归档/移除/目录失效）：${projectId}`);
    }
    if (getState().rooms.some((r) => r.projectId === projectId)) {
      const { focusProject } = await import('./data/actions-nav');
      if (!navIntentActive(intent)) return;
      focusProject(projectId, { system: true }); // system：定位链内部调用，不取消所属意图
      if (getState().activeProjectId === projectId) return; // 聚焦已落位
      // focusProject 静默未落位（如注册表瞬时缺行）——落到下一轮的全链打开
    } else {
      // R74（review-r73 §P1）：concrete intent 传入函数内部——openProjectByPath 的每段
      // 异步回执后（project.open/装载刷新）按意图决定是否提交焦点/写偏好。
      await openProjectByPath(proj.rootPath, { fromIntent: true, intent });
    }
    if (!navIntentActive(intent)) return;
    if (getState().activeProjectId === projectId) return;
    // 并发打开抢先（如启动恢复观察器晚到落位）：有界重试
  }
  throw new Error('项目切换未落位（并发打开抢占）——请重试');
}

/**
 * R72：线程直达（#/thread/:id）**定位**装载——修「深链不稳定」根因。
 *
 * 先探归属（thread.get——服务端 audience 裁决，本地不猜），所属项目未激活时先
 * ensureProjectActive 对齐，再交回常规链（RoomPage 挂载后 ThreadPanel 的 loadThread
 * 代次/归属已对齐，不再被 stillCurrent 双门丢弃）。
 */
export async function locateThread(threadId: string, intent?: NavIntent): Promise<{ projectId: string; roomId: string }> {
  // 等 boot 定型（ready/failed，bootRemembered 有界 60s）——避免与其 openProjectByPath 互抢代次。
  for (let i = 0; i < 70; i += 1) {
    const b = getState().boot;
    if (b === 'ready' || b === 'failed') break;
    await new Promise((r) => setTimeout(r, 1000));
    if (!navIntentActive(intent)) return { projectId: '', roomId: '' }; // 已取消：安静停（调用方以 intent 再核）
  }
  const probe = await command<ThreadGetData>('thread.get', { threadId }); // 不存在/不可访问=如实抛出
  if (!navIntentActive(intent)) return { projectId: '', roomId: '' };
  // 对齐链偶发竞态（注册表瞬时缺行/装载竞态）吸收一次重试——深链是用户明确意图，
  // 一次瞬时失败就报「不存在」是误报。已取消的意图不再重试（review-r72：旧请求不继续重试抢焦点）。
  let lastErr: unknown = null;
  for (let i = 0; i < 2; i += 1) {
    try { await ensureProjectActive(probe.thread.projectId, intent); lastErr = null; break; }
    catch (e) {
      if (!navIntentActive(intent)) return { projectId: '', roomId: '' };
      lastErr = e; await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (!navIntentActive(intent)) return { projectId: '', roomId: '' };
  if (lastErr != null) throw lastErr;
  return { projectId: probe.thread.projectId, roomId: probe.thread.roomId };
}

/** 显式推进线程阅读水位（ThreadPage 贴底滚动时调用——发起此刻重查独立门；未来序号服务端拒）。 */
export async function markThreadReadIfAllowed(threadId: string): Promise<void> {
  const { canMarkThreadRead } = await import('./data/store');
  const s = getState();
  if (s.threadEntities[threadId] == null) return;
  const replies = s.threadMessages[threadId] ?? [];
  const lastSeq = replies.length > 0 ? (replies[replies.length - 1]?.threadMessageSeq ?? 0) : 0;
  const known = s.threadReadSeq[threadId] ?? 0;
  if (lastSeq > known && canMarkThreadRead(threadId)) {
    try {
      await command('thread.markRead', { threadId, throughMessageSeq: lastSeq });
      setState((prev) => ({ ...prev, threadReadSeq: { ...prev.threadReadSeq, [threadId]: lastSeq } }));
    } catch { /* 未来序号/门关——下次再推进 */ }
  }
}

/** 任务详情单项刷新（停止/验收后重查——绑定服务端当前事实）。 */
/** 长历史定位补读（r56 H4 §5）：thread.history beforeSeq 游标向前补一页（100 条），追加到
 * 已装载回复**头部**（保持 seq 升序）。返回补入条数（0=已到头/迟到丢弃）——调用方按此决定
 * 继续补读还是如实「未定位」。补读是纯读：不改水位（标读仍只在前台+贴底时发生）。 */
export async function loadThreadOlder(threadId: string, beforeSeq: number): Promise<number> {
  const gen = getState().loadGen;
  const ent = getState().threadEntities[threadId];
  if (ent == null) return 0;
  const hist = await command<ThreadHistoryData>('thread.history', { threadId, beforeSeq, limit: 100 });
  if (!stillCurrent(gen, ent.projectId)) return 0;
  const older = (hist.items ?? []).map((it) => msgOfReply(ent.projectId, ent.roomId, threadId, it));
  if (older.length === 0) return 0;
  setState((prev) => {
    const cur = prev.threadMessages[threadId] ?? [];
    const known = new Set(cur.map((m) => m.id));
    const fresh = older.filter((m) => !known.has(m.id));
    return { ...prev, threadMessages: { ...prev.threadMessages, [threadId]: [...fresh, ...cur] } };
  });
  hydrateThreadFromSnapshots(threadId);
  return older.length;
}

export async function refreshThreadTask(threadId: string): Promise<void> {
  const s = getState();
  const thread = s.threadEntities[threadId];
  if (thread?.rootTaskId == null) return;
  const tg = await command<TaskGetData>('task.get', { taskId: thread.rootTaskId });
  const projectId = s.activeProjectId;
  if (!stillCurrent(s.loadGen, projectId)) return;
  const detail: ThreadTaskDetail = {
    id: tg.task.id, responseKind:tg.task.response_kind, title: tg.task.title, status: tg.task.status, roomId: tg.task.room_id,
    threadId: tg.task.conversation_thread_id, roomTaskNumber: tg.task.room_task_number,
    revision: tg.task.revision, stopGeneration: tg.task.stopGeneration,
    objective: tg.task.objective, reviewPolicy: tg.task.review_policy, mode: tg.task.mode ?? undefined,
    ownerMemberId: tg.task.owner_member_id, parentTaskId: tg.task.parent_task_id, currentDeliveryId: tg.task.current_delivery_id,
    activeRun: tg.activeRun, pendingDelivery: tg.pendingDelivery == null ? null
      : { id: tg.pendingDelivery.id, revision: tg.pendingDelivery.revision, manifestHash: tg.pendingDelivery.manifest_hash },
    reworkPending: tg.reworkPending ?? null,
    lastStartupFailureMessage: tg.lastStartupFailureMessage ?? null,
  };
  setState((prev) => ({ ...prev, threadTasks: { ...prev.threadTasks, [threadId]: detail } }));
}

/**
 * DM 历史行 → 呈现用 Message。`conversation.history` 返回原始 `body_json`
 * 字符串：正文与可选的 `collaborationStage` 都从这里转译，**原 JSON 不进正文**。
 */
export const msgOfDmHistory = (projectId: string, conversationId: string, m: HistoryMessage, index: number): Message => {
  const stage = collaborationStageOfBody(parsedHistoryBody(m));
  const message: Message = {
    id: m.id, projectId, roomId: `dm:${conversationId}`,
    authorType: (m.authorType ?? m.author_type ?? 'system') as Message['authorType'],
    authorId: m.authorId ?? m.author_id ?? '', kind: 'text', body: stripStageHeading(textOf(m), stage),
    createdAt: createdAtOf(m), threadMessageSeq: m.conversationSeq ?? m.conversation_seq ?? index,
    attachmentIds: [], formalAttachments: m.attachments ?? [],
    detailMarkdown: (m.attachments??[]).some(a=>a.detailMarkdown) ? undefined : detailMarkdownOfBody(parsedHistoryBody(m)),
  };
  if (stage != null) message.collaborationStage = stage;
  return message;
};

export async function loadDmHistory(conversationId: string, opts: { markRead?: boolean } = {}): Promise<void> {
  const gen = getState().loadGen;
  const projectId = getState().activeProjectId;
  try {
    const data = await command<HistoryData>('conversation.history', { conversationId, limit: 100 });
    if (!stillCurrent(gen, projectId)) return;
    const conv = getState().dms.find((d) => d.id === conversationId);
    const msgs: Message[] = (data.messages ?? []).map((m, i) => msgOfDmHistory(projectId, conversationId, m, i));
    setState((prev) => {
      const errors = { ...prev.readErrors }; delete errors[conversationId];
      return { ...prev, dmHistory: { ...prev.dmHistory, [conversationId]: msgs }, readErrors: errors };
    });
    // 已读水位（统一门——review-r47 §4）：缓存写入与阅读水位分开；**发起点此刻**重查
    // store.readGate（当前会话+前台/焦点+贴底+接管——页面注册，缺省拒绝），不信任请求前快照。
    if (opts.markRead === true && conv != null && (conv.unread ?? 0) > 0 && canMarkRead(conversationId)) {
      const last = (data.messages ?? [])[(data.messages ?? []).length - 1];
      const lastSeq = last ? (last.conversationSeq ?? last.conversation_seq) : undefined;
      if (lastSeq != null) {
        void command('conversation.markRead', { conversationId, throughMessageSeq: lastSeq })
          .then(() => { if (stillCurrent(gen, projectId)) return refreshDms().catch(() => { /* 归属已变/库关闭——下次再进 */ }); })
          .catch(() => { /* 下次进入再推进 */ });
      }
    }
  } catch (e) {
    if (!stillCurrent(gen, projectId)) return;
    setState((prev) => ({ ...prev, readErrors: { ...prev.readErrors, [conversationId]: (e as Error).message } }));
  }
}

/** 正式侧消息扩展说明：呈现用序号走原型 Message.threadMessageSeq；无额外下划线字段。 */

/* ---------- 发送（正式异步合同：Composer commandId 贯通；ok/failed/unknown） ---------- */

const mentionPayload = (mentionIds: string[]): Array<{ kind: 'member'; memberId: string } | { kind: 'all' }> =>
  mentionIds.map((id) => (id === 'all' ? { kind: 'all' as const } : { kind: 'member' as const, memberId: id }));

/** Shared with the Composer mode/budget bubble; the server re-derives and validates it. */
export function defaultDeliberationMaxTurns(rosterSize: number): number {
  return deriveDeliberateMaxTurns(rosterSize, { expectsCheckpointRound3: true }).core;
}

/**
 * 唯一正式参数 builder（review-r48 §3）：发送前把**真正要发给 bridge 的完整请求**固化成
 * 不可变信封（原 commandId+完整 target（含 projectId/conversationId/roomId——不从 UI 目标
 * 重造）+body+intent+mentions）。等待/回执/重试/冻结都用这一份。
 * 附件 refs（第五十一轮 H2）：只在 upload 回执明确成功后进入信封——信封不可变原则不变。
 */
export function buildRoomRootEnvelope(commandId: string, roomId: string, body: string, intent: 'default' | 'record_only', mentionIds: string[], attachmentRefs?: string[], opts?: { collaboration?:'deliberate'; deliberationBudget?: { maxTurns: number }; imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): PendingSendEnvelope {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'room_root', projectId: s.activeProjectId, conversationId: room?.conversationId ?? '', roomId },
      body, intent, mentions: mentionPayload(mentionIds),
      ...(opts?.collaboration?{collaboration:opts.collaboration}:{}),
      ...(opts?.collaboration === 'deliberate' && opts.deliberationBudget != null
        ? { deliberationBudget: { maxTurns: opts.deliberationBudget.maxTurns } }
        : {}),
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `room:${roomId}`,
    at: Date.now(),
  };
}

export function buildDmEnvelope(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only', attachmentRefs?: string[], opts?: { imageAck?: 'omit-images'; attachmentRanges?: Record<string, string> }): PendingSendEnvelope {
  const s = getState();
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'dm', projectId: s.activeProjectId, conversationId }, body, intent, mentions: [],
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `dm:${conversationId}`,
    at: Date.now(),
  };
}

/** 线程跟进信封（第五十一轮 H2）：目标=打开的线程（projectId/conversationId/threadId 来自
 * thread.get 实体——不从界面焦点重造）；记录串（rootTaskId 空）由服务端强制 record_only。 */
export function buildThreadEnvelope(
  commandId: string,
  threadId: string,
  body: string,
  intent: 'default' | 'record_only',
  attachmentRefs?: string[],
  opts?: {
    mentionIds?:string[];
    collaboration?:'deliberate';
    deliberationBudget?:{maxTurns:number};
    imageAck?: 'omit-images';
    attachmentRanges?: Record<string, string>;
  },
): PendingSendEnvelope {
  const s = getState();
  const thread = s.threadEntities[threadId];
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'thread', projectId: thread?.projectId ?? s.activeProjectId, conversationId: thread?.conversationId ?? '', threadId },
      body, intent, mentions: mentionPayload(opts?.mentionIds??[]),
      ...(s.threadMemberships[threadId]?{threadMemberVersion:s.threadMemberships[threadId].version}:{}),
      ...(opts?.collaboration?{collaboration:opts.collaboration}:{}),
      ...(opts?.collaboration==='deliberate'&&opts.deliberationBudget!=null
        ?{deliberationBudget:{maxTurns:opts.deliberationBudget.maxTurns}}
        :{}),
      ...(attachmentRefs != null && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(opts?.imageAck != null ? { imageAck: opts.imageAck } : {}),
      ...(opts?.attachmentRanges != null ? { attachmentRanges: opts.attachmentRanges } : {}),
    },
    targetLabel: `thread:${threadId}`,
    at: Date.now(),
  };
}

/**
 * 草稿附件 → 正式 refs（第五十二轮修订，review-r51 §2）：上传中/失败项拦截（store.uploadItems
 * 为真源）；refs 取**草稿里已就绪的 attachmentId 引用**（上传回执写入）。图片+派发意图不再硬拦
 * ——由 Composer 显式二选一（imageAck='omit-images' 一次性冻结进信封，或改仅记录）。
 */
export function attachmentRefsFromDraft(draftKey: string, intent: 'default' | 'record_only'): { refs?: string[]; hasImages?: boolean; blockError?: string } {
  const s = getState();
  const items = (s.uploadItems[draftKey] ?? []).filter((x) => x.removed !== true);
  const uploading = items.filter((x) => x.status === 'uploading');
  if (uploading.length > 0) return { blockError: `附件仍在上传（${uploading.map((x) => x.name).join('、')}）——完成后再发送` };
  const failed = items.filter((x) => x.status === 'failed');
  if (failed.length > 0) return { blockError: `有上传失败的附件（${failed.map((x) => x.name).join('、')}）——请移除或重选后再发送` };
  const d = getDraftFull(draftKey);
  const ready = d.attachments.filter((a) => a.attachmentId != null && a.attachmentId.length > 0);
  if (ready.length === 0) return {};
  return { refs: ready.map((a) => a.attachmentId), hasImages: intent === 'default' && ready.some((a) => a.kind === 'image_file') };
}

/** 表格注入范围（第五十二轮 §6.3）：草稿内已选范围 → attachmentRanges；缺省=服务端有界默认窗。 */
export function attachmentRangesFromDraft(draftKey: string): Record<string, string> | undefined {
  const d = getDraftFull(draftKey);
  const out: Record<string, string> = {};
  for (const a of d.attachments) if (a.range != null && a.range.length > 0) out[a.attachmentId] = a.range;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 为草稿内某附件设定注入范围（预览面板「用此窗口作注入范围」——只写草稿，信封在发送时冻结）。 */
export function setDraftAttachmentRange(draftKey: string, attachmentId: string, range: string): void {
  const d = getDraftFull(draftKey);
  setDraftFullShim(draftKey, { ...d, attachments: d.attachments.map((a) => (a.attachmentId === attachmentId ? { ...a, range } : a)) });
}

/* ---------- 任务动作（第五十一轮 H2）：停止绑定 run/代次；验收绑定交付三重身份 ---------- */

/** 停止任务：targetRunId/expectedStopGeneration 取自**已装载的任务详情**（服务端核对——
 * 过时绑定会被正式链拒绝，不静默套用到新 run）。 */
export async function stopThreadTask(threadId: string): Promise<{ ok: boolean; error?: string }> {
  const s = getState();
  const detail = s.threadTasks[threadId];
  if (detail == null) return { ok: false, error: '任务详情未装载——先打开详情刷新' };
  if (['DONE', 'CANCELLED'].includes(detail.status)) return { ok: false, error: `任务已终态（${detail.status}）——无可停止的执行` };
  if (detail.activeRun == null) return { ok: false, error: '当前没有活跃 run（任务可能已结束）' };
  try {
    await command('task.stop', { taskId: detail.id, targetRunId: detail.activeRun.id, expectedStopGeneration: detail.stopGeneration });
    recordWrite('task.stop', `停止任务 #${detail.roomTaskNumber}（run ${detail.activeRun.id}）`);
    await refreshThreadTask(threadId).catch(() => { /* 刷新失败保留旧详情并就地报错 */ });
    return { ok: true };
  } catch (e) {
    await refreshThreadTask(threadId).catch(() => { /* 停止失败后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
}

/** 验收/返工快照（页面打开意见/验收框时冻结——目标变化不悄悄换稿，review-r44/45 同判）。 */
export interface ReviewSnapshot {
  taskId: string;
  deliveryId: string;
  deliveryRevision: number;
  manifestHash: string;
}

/** 提交验收：只带**冻结快照**的三重身份（id+revision+manifest_hash）——不重读当前 review；
 * 冲突（STALE_REVISION 等）如实上屏并刷新详情。 */
export async function submitTaskReview(snapshot: ReviewSnapshot, decision: 'accept' | 'changes_requested', note?: string, threadIdForRefresh?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('task.review', {
      taskId: snapshot.taskId, deliveryId: snapshot.deliveryId, deliveryRevision: snapshot.deliveryRevision,
      manifestHash: snapshot.manifestHash, decision, ...(decision === 'changes_requested' && note != null ? { note } : {}),
    });
    recordWrite('task.review', `${decision === 'accept' ? '验收通过' : '要求返工'}（交付 v${snapshot.deliveryRevision}）`);
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 详情下次进入刷新 */ });
    return { ok: true };
  } catch (e) {
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 冲突后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
}

/** 执行返工（r58 验收与执行分离；r59 完整身份绑定）：意见已由 task.review 入账；本入口
 * 传**点击时冻结的交付完整快照**（id/revision/manifestHash/sourceRunId）——服务端事务内核
 * 核对当前返工事实，旧引用（页面未刷新、另一路已推进到新返工）STALE 拒绝不改绑。 */
export async function executeTaskRework(snapshot: { taskId: string; deliveryId: string; deliveryRevision: number; manifestHash: string; sourceRunId: string }, threadIdForRefresh?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command('task.executeRework', { taskId: snapshot.taskId, deliveryId: snapshot.deliveryId, deliveryRevision: snapshot.deliveryRevision, manifestHash: snapshot.manifestHash, sourceRunId: snapshot.sourceRunId, reason: '用户点击「执行返工」' });
    recordWrite('task.executeRework', `执行返工（任务 ${snapshot.taskId.slice(0, 14)}… v${snapshot.deliveryRevision}）`);
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 详情下次进入刷新 */ });
    return { ok: true };
  } catch (e) {
    if (threadIdForRefresh != null) await refreshThreadTask(threadIdForRefresh).catch(() => { /* 冲突后重查事实 */ });
    return { ok: false, error: (e as Error).message };
  }
}

/** 发送不可变信封（正式管道——重试与首次共用，保证同号同参）。 */
export async function sendEnvelope(env: PendingSendEnvelope): Promise<BridgeOutcome<SendResult>> {
  const r = await sendCommand<SendResult>(env.commandId, env.method, env.params);
  if (r.status === 'ok') recordWrite('message.submit', `${env.params.target.kind === 'dm' ? '私信' : '房间'} ${env.params.intent === 'record_only' ? '仅记录' : '发送'}（${String(env.params.body).slice(0, 24)}…）`);
  return r;
}

export async function sendRoomRoot(
  commandId: string,
  roomId: string,
  body: string,
  intent: 'default' | 'record_only',
  mentionIds: string[],
  opts?: { collaboration?: 'deliberate'; deliberationBudget?: { maxTurns: number } },
): Promise<BridgeOutcome<SendResult>> {
  const s = getState();
  const room = s.rooms.find((r) => r.id === roomId);
  if (room == null) return { status: 'failed', code: 'NO_ROOM', error: '房间不存在或尚未装载' };
  const projectedMembers = room.memberIds
    .map((memberId) => getState().members.find((candidate) => candidate.id === memberId))
    .filter((member) => member != null);
  const enabledAgentCount = projectedMembers.length > 0
    ? projectedMembers.filter((member) => member.principalType === 'agent' && member.enabled).length
    : room.memberIds.length;
  if (enabledAgentCount === 0 && intent === 'default') {
    return { status: 'failed', code: 'NO_MEMBERS', error: '该房间没有可用 AI——请先添加 AI' };
  }
  return sendEnvelope(buildRoomRootEnvelope(commandId, roomId, body, intent, mentionIds, undefined, opts));
}

export async function sendDmMessage(commandId: string, conversationId: string, body: string, intent: 'default' | 'record_only'): Promise<BridgeOutcome<SendResult>> {
  return sendEnvelope(buildDmEnvelope(commandId, conversationId, body, intent));
}

export async function createDm(memberId: string): Promise<string> {
  const s = getState();
  const r = await command<{ conversationId: string }>('conversation.create', { projectId: s.activeProjectId, peerMemberId: memberId });
  await refreshDms();
  return r.conversationId;
}

/** 结果未知信封的严格重发（review-r47 §2/r48 §3）：原 commandId+原参数逐字重发——不重组。 */
export async function retryUnknownSend(env: PendingSendEnvelope): Promise<BridgeOutcome<SendResult>> {
  return sendEnvelope(env);
}

/* ---------- 附件上传/预览适配（第五十一轮 H2 骨架——格式实际限制，服务端为最终裁决） ---------- */

/** 格式上限与 daemon 常量同源核对（UI 只做前置拦截；正式校验在服务端）：文本 256KB、图片
 * 8MB、PDF/Office 20MiB、CSV 5MB——不把 20MiB 当所有格式上限（review-r50 §4）。 */
export const ATTACHMENT_LIMITS = {
  text: 256 * 1024,
  image: 8 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  office: 32 * 1024 * 1024, // R71：与 daemon OFFICE_MAX_BYTES 分道对齐（真实 22.54MiB PPT）
  csv: 5 * 1024 * 1024,
} as const;

const TEXT_EXTS = /\.(txt|md|markdown|json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql|html|css|xml|log|ini|cfg)$/i;
const OFFICE_EXTS = /\.(docx|xlsx|pptx)$/i;

export type AttachmentClass = { cls: 'text' | 'image' | 'pdf' | 'office' | 'csv' | 'unsupported'; reason?: string };

/** 分类+前置限幅（magic bytes 由服务端裁决——此处按扩展名给 UI 预判与说明）。 */
export function classifyAttachmentFile(name: string, size: number): AttachmentClass {
  const lower = name.toLowerCase();
  if (TEXT_EXTS.test(lower)) return size > ATTACHMENT_LIMITS.text ? { cls: 'unsupported', reason: `文本附件超过 ${ATTACHMENT_LIMITS.text / 1024}KB 上限` } : { cls: 'text' };
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return size > ATTACHMENT_LIMITS.image ? { cls: 'unsupported', reason: `图片原件超过 ${ATTACHMENT_LIMITS.image / 1024 / 1024}MB 上限` } : { cls: 'image' };
  if (/\.(pdf)$/.test(lower)) return size > ATTACHMENT_LIMITS.pdf ? { cls: 'unsupported', reason: `PDF 超过 ${ATTACHMENT_LIMITS.pdf / 1024 / 1024}MiB 上限` } : { cls: 'pdf' };
  if (/\.(csv|tsv)$/.test(lower)) return size > ATTACHMENT_LIMITS.csv ? { cls: 'unsupported', reason: `CSV 超过 ${ATTACHMENT_LIMITS.csv / 1024 / 1024}MB 上限` } : { cls: 'csv' };
  if (OFFICE_EXTS.test(lower)) return size > ATTACHMENT_LIMITS.office ? { cls: 'unsupported', reason: `Office 原件 ${(size / 1048576).toFixed(1)}MiB 超过 ${(ATTACHMENT_LIMITS.office / 1048576).toFixed(0)}MiB 上限` } : { cls: 'office' };
  return { cls: 'unsupported', reason: '未接入的附件类型（文本/图片/PDF/Office/CSV 之外）' };
}

/** File→base64（arrayBuffer+btoa——Electron renderer 与 Node 测试环境双兼容，不依赖 FileReader）。 */
const fileToBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

export interface UploadReceipt { previewWarning?: string; attachmentId: string; hash: string; revision: number; kind: string; /** R69 P1-D：Office 软解析失败=已保存但提取不可用（分列状态，非上传失败）。 */ extractionFailed?: string }

/** 上传分类 → artifacts.kind（与 daemon kindForFilename 同口径的 UI 侧推导：code 扩展名=
 * code_file，其余文本=text_file；Office 按扩展名三类——服务端按内容嗅探为准）。 */
function kindOfClass(cls: AttachmentClass['cls'], name: string): string {
  const lower = name.toLowerCase();
  switch (cls) {
    case 'image': return 'image_file';
    case 'pdf': return 'pdf_file';
    case 'csv': return 'sheet_file';
    case 'office': return /\.(xlsx)$/.test(lower) ? 'sheet_file' : /\.(pptx)$/.test(lower) ? 'slides_file' : 'docx_file';
    default: return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql)$/.test(lower) ? 'code_file' : 'text_file';
  }
}

/**
 * 上传一个附件到目标会话（回执绑定发起项目/会话——上传时 conversationId 必填，跨会话引用
 * 由服务端 audience 拒绝）。分类→前置限幅→对应 upload 命令；失败原样抛出（页面保留草稿）。
 * receipt.kind 为 UI 侧按同一分类推导（服务端按内容嗅探为准——门禁与展示用，不作归属事实）。
 */
export async function uploadAttachmentFile(conversationId: string, file: File): Promise<UploadReceipt> {
  const cls = classifyAttachmentFile(file.name, file.size);
  if (cls.cls === 'unsupported') throw new Error(cls.reason ?? '不支持的附件类型');
  if (cls.cls === 'text') {
    // R69 P1-C：文本走**原字节上传**（attachment.uploadTextRaw）——hash/副本=真实字节，
    // BOM/UTF-16/GB18030 原样保存（另存原文件逐字节一致）；编码检测/0B 允许在服务端裁决
    // （同一 decodeTextBytes 检测链——旧实现 renderer 解码后重编码会剥 BOM、把正常 UTF-16
    // 当「损坏字节」拒绝、0B 一律失败）。
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length > ATTACHMENT_LIMITS.text) throw new Error(`文本附件超过 ${ATTACHMENT_LIMITS.text / 1024}KB 上限（服务端同限裁决）`);
    const contentBase64 = await fileToBase64(file);
    const r = await command<Omit<UploadReceipt, 'kind'> & { bytes?: number }>('attachment.uploadTextRaw', { conversationId, filename: file.name, contentBase64 });
    return { attachmentId: r.attachmentId, hash: r.hash, revision: r.revision ?? 1, kind: kindOfClass('text', file.name) };
  }
  const contentBase64 = await fileToBase64(file);
  const method = cls.cls === 'image' ? 'attachment.uploadImage' : cls.cls === 'pdf' ? 'attachment.uploadPdf' : cls.cls === 'csv' ? 'attachment.uploadCsv' : 'attachment.uploadOffice';
  const r = await command<Omit<UploadReceipt, 'kind'> & { bytes?: number; extraction?: string; extractionCode?: string; extractionMessage?: string }>(method, { conversationId, filename: file.name, contentBase64 });
  // R69 P1-D：Office 软解析失败=上传成功（原件已保存、本地预览可开）+提取分列不可用——
  // 不再吞掉整次上传；失败原因随回执带出（芯片就地呈现，模型注入侧 fail-closed 拒绝）。
  const extractionFailed = r.extraction === 'failed'
    ? `内容提取失败（${r.extractionCode ?? '未知'}：${r.extractionMessage ?? ''}）——文件已保存可预览；发给 AI 会因无提取文本被拒`
    : undefined;
  let previewWarning: string | undefined;
  if (cls.cls === 'image' && typeof Image !== 'undefined') {
    const url = URL.createObjectURL(file);
    try {
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(new Error('浏览器未解码出有效图片尺寸'));
        image.onerror = () => reject(new Error('浏览器无法解码图片；文件可能损坏或格式不受支持'));
        image.src = url;
      });
    } catch (error) { previewWarning = `${(error as Error).message}。原件已保存；可打开预览重试或另存原件。`; }
    finally { URL.revokeObjectURL(url); }
  }
  // 各 upload* 首传均为 artifacts 插入 revision=1（响应不带回执字段——按合同事实补默认，不为重传猜值）。
  return { attachmentId: r.attachmentId, hash: r.hash, revision: r.revision ?? 1, kind: kindOfClass(cls.cls, file.name), ...(previewWarning != null ? { previewWarning } : {}), ...(extractionFailed != null ? { extractionFailed } : {}) };
}

/** 文本/代码附件预览（骨架：真实 attachment.previewText——其余类型如实分列到原界面）。 */
export async function previewTextAttachment(attachmentId: string, conversationId: string): Promise<{ filename: string; kind: string; revision: number; text: string; truncated: boolean; originalBytes: number }> {
  return command('attachment.previewText', { attachmentId, conversationId });
}

/* ---------- 深链规范化（review-r50 §4：#dm=/#task=/#delivery=/#msg= → 内部路由） ---------- */

/**
 * 解析外部深链族（与 daemon deepLink.resolve 同一 hash 形态）并规范化为内部路由：
 * 跨项目先经 rootPath 打开真实项目（实体身份保留），再导航到对应页面；失败如实报错
 * （不静默跳转、不猜实体）。刷新/前进后退走内部路由（斜杠形态），不再进本函数。
 */
export async function openExternalDeepLink(hash: string): Promise<void> {
  const urlSeq = currentNavSeq();
  const res = await command<ResolvedDeepLink>('deepLink.resolve', { hash });
  if (currentNavSeq() !== urlSeq) return;
  const s = getState();
  if (res.projectId !== s.activeProjectId) {
    if (res.rootPath == null || res.rootPath.length === 0) throw new Error('深链指向其它项目但未返回项目路径——无法打开');
    const opened = await openProjectByPath(res.rootPath);
    if (!opened.isCurrent()) return;
  }
  const route = routeForResolved(res, getState());
  if (route == null) throw new Error(`深链解析成功但无对应界面落点（kind=${res.kind}）`);
  if (currentNavSeq() !== urlSeq) return;
  navigate(route);
  recordWrite('deepLink.resolve', `深链 ${hash.slice(0, 40)} → ${route}`);
}
