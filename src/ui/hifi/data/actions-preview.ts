/**
 * 共享预览的状态动作（R64 原型还原：UX-PREVIEW-01 / §17.9 的正式版）。
 *
 * 与原型 data/actions-preview.ts 的关系：会话状态（标签/收起/放大/并排侧/返回快照/
 * 上下文变更）与三条铁律（打开不发送不执行；收起保留位置与草稿；迟到不覆盖）原样移植；
 * **资源与引用走正式链路**：
 *  - 引用（r61 用户批准合同）：附件/成果资源 → addFileRefToDraft 引用卡（正文保持用户文字）；
 *    摘录选区 → queueDraftInsert 内容插入队列。不再使用原型的 pendingQuotes 内存队列。
 *  - 工作区文件（项目文件树）：只登记只读资源，内容由预览面板经 project.file.read 实际读取；
 *    未上传为会话附件的工作区文件**不能**直接引用进草稿（如实说明，不自动上传）。
 *  - 文件评论（§7.4）：向**源会话**发一条仅记录消息并携带该附件引用卡（真实 message.submit、
 *    不触发模型派发；版本锚定在引用卡内），不再是原型 toast 模拟。
 */
import { getState, recordWrite, setState, toast } from './store';
import { addFileRefToDraft, queueDraftInsert, conversationOfDraftKey } from './store';
import {
  audienceAllows, closeTab as closeTabPure,
  latestRevisionOf, openTab, resourceOf, revisionOf, tabKeyFor,
} from '../lib/resource';
import type {
  ContextLocation, ContextTarget, DraftReference, PreviewResource,
} from './types';

/** 单调递增的请求代次，保证"只接受最新请求"（PV-16/17） */
let generationCounter = 0;

function nextOrdinal(): number {
  const s = getState();
  return s.preview.tabs.reduce((max, t) => Math.max(max, t.ordinal), -1) + 1;
}

/* ============================================================
   上下文描述
   ============================================================ */

/** 把当前路由上下文转成 ContextTarget（用于 openedFrom 与 audience 判定） */
export function contextTargetOf(
  projectId: string,
  opts: {
    roomId?: string;
    threadId?: string;
    roomView?: 'chat' | 'tasks' | 'files';
    dmConversationId?: string;
    filesView?: 'files' | 'git';
    filesSelection?: string;
  },
): ContextTarget {
  if (opts.dmConversationId) {
    return { kind: 'dm', projectId, conversationId: opts.dmConversationId, threadId: opts.threadId };
  }
  // 文件/Git 工作区独立建模，不借虚构 roomId（§7.5）
  if (opts.filesView) {
    return { kind: 'files', projectId, view: opts.filesView, selection: opts.filesSelection };
  }
  if (opts.threadId && opts.roomId) {
    return {
      kind: 'thread', projectId, roomId: opts.roomId, threadId: opts.threadId,
      tab: 'replies',
    };
  }
  return {
    kind: 'room', projectId, roomId: opts.roomId ?? '', view: opts.roomView ?? 'chat',
  };
}

export function contextKey(t: ContextTarget): string {
  switch (t.kind) {
    case 'room':
      return `room:${t.projectId}:${t.roomId}:${t.view}`;
    case 'thread':
      return `thread:${t.projectId}:${t.threadId}:${t.tab}`;
    case 'dm':
      return `dm:${t.projectId}:${t.conversationId}`;
    case 'files':
      return `files:${t.projectId}:${t.view}`;
  }
}

/** 通知"左侧上下文已改变"（§3.4 第 2 条：关闭预览时保留最新选择，不跳回旧任务）。 */
export function noteContextChanged() {
  if (!getState().preview.contextChangedSinceOpen) {
    setState((s) => ({ ...s, preview: { ...s.preview, contextChangedSinceOpen: true } }));
  }
}

/** 主动切换上下文后，预览并排的那一侧跟着走（§3.3）。 */
export function setPreviewContextSide(side: 'thread' | 'pool') {
  if (getState().preview.side === side) return;
  setState((s) => ({ ...s, preview: { ...s.preview, side } }));
}

/* ============================================================
   资源登记（正式侧：真实身份，不伪造内容）
   ============================================================ */

// R69 P1-A：registerAttachmentResource 移入 store 层（store.openPreview 统一入口需要在
// 调度层同步登记+开标签）；此处再导出保持既有 import 路径兼容。
export { registerAttachmentResource } from './store';

/**
 * 登记一个**项目工作区文件**资源（文件树入口）：内容经 project.file.read 实际读取
 * （安全根内、只读、白名单）；hash 在读取成功后由预览面板回填。同路径去重。
 *
 * R70 F1：资源 ID=**项目 ID + 完整规范路径的无损编码**（encodeURIComponent——任意中文/
 * 标点/大小写差异都不同键，可逆且不碰撞；旧实现把非 ASCII 压成下划线，`甲文.md` 与
 * `乙文.md`、`a-b.md` 与 `a_b.md` 均碰撞成同一资源——串读反例根因）。展示名（title）与
 * 身份键分离；版本/快照/重载/另存/摘录都按此具体资源绑定。
 */
export function registerWorktreeResource(projectId: string, relativePath: string, sizeBytes: number): string {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const resourceId = `res_wt_${projectId}_${encodeURIComponent(normalizedPath)}`;
  setState((prev) => {
    if (prev.resources.some((r) => r.id === resourceId)) return prev;
    const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
    const res: PreviewResource = {
      id: resourceId,
      projectId,
      kind: 'worktree',
      title: relativePath.split(/[\\/]/).pop() ?? relativePath,
      relativePath: normalizedPath,
      mimeType: ext ? `text/${ext}` : 'text/plain',
      origin: { kind: 'workspace' },
      audience: { kind: 'project' },
      mutable: true,
      revisions: [{
        revision: 1,
        hash: '(读取时核验)',
        sizeBytes,
        createdAt: Date.now(),
        content: { kind: 'unsupported', reason: 'not_connected', note: '内容由共享预览按需装载' },
      }],
      createdAt: Date.now(),
      formalWorktree: { projectId, path: normalizedPath },
    };
    return { ...prev, resources: [...prev.resources, res] };
  });
  return resourceId;
}

/**
 * R68 §6：登记一个**正式 AI 交付文档**资源（共享预览第三来源）。版本=交付 revision、
 * hash=manifestHash（不可变快照）；内容经 delivery.document 按需装载（自然链持久化的
 * turn 最终输出，hash 与 manifest 核对）。audience 按交付所属会话（房间/私信）。
 */
export function registerDeliveryResource(input: {
  deliveryId: string; revision: number; manifestHash: string; conversationId: string;
  threadId: string | null; taskTitle: string; audience: 'room' | 'dm'; roomId?: string;
  openedFrom: ContextTarget;
}): string {
  const resourceId = `dlv_${input.deliveryId}`;
  setState((prev) => {
    if (prev.resources.some((r) => r.id === resourceId)) return prev;
    const res: PreviewResource = {
      id: resourceId,
      projectId: input.openedFrom.projectId,
      kind: 'attachment',
      title: `${input.taskTitle || '交付文档'} v${input.revision}.md`,
      mimeType: 'text/markdown',
      origin: input.audience === 'dm'
        ? { kind: 'dm', conversationId: input.conversationId }
        : { kind: 'task', taskId: '', threadId: input.threadId ?? '', roomId: input.roomId ?? '' },
      audience: input.audience === 'dm'
        ? { kind: 'dm', conversationId: input.conversationId, memberIds: [] }
        : { kind: 'room', roomId: input.roomId ?? '' },
      revisions: [{
        revision: input.revision,
        hash: input.manifestHash,
        sizeBytes: 0,
        createdAt: Date.now(),
        content: { kind: 'unsupported', reason: 'not_connected', note: '交付文档由共享预览按需装载' },
      }],
      createdAt: Date.now(),
      formalDelivery: {
        deliveryId: input.deliveryId, revision: input.revision, manifestHash: input.manifestHash,
        conversationId: input.conversationId, threadId: input.threadId, taskTitle: input.taskTitle, audience: input.audience,
      },
    };
    return { ...prev, resources: [...prev.resources, res] };
  });
  return resourceId;
}

/* ============================================================
   打开资源
   ============================================================ */

/** 打开一个资源版本（唯一入口；权限校验=audience 必须允许当前上下文）。 */
export function openPreview(
  resourceId: string,
  revision: number | undefined,
  openedFrom: ContextLocation,
): boolean {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) {
    toast('这份资源不存在或已被移除', 'error');
    return false;
  }
  if (!audienceAllows(res.audience, openedFrom.target)) {
    toast('当前上下文无权查看这份资源（私信附件不能跨会话共享）', 'error');
    recordWrite('preview.open.denied', `resource=${resourceId} audience=${res.audience.kind} → 拒绝：同 projectId 不是共享许可`);
    return false;
  }
  const rev = revision ?? latestRevisionOf(res)?.revision;
  if (rev === undefined || !revisionOf(res, rev)) {
    toast('该版本不可用，未回退到其他版本', 'error');
    return false;
  }
  const generation = ++generationCounter;
  setState((prev) => {
    const { tabs, activeKey } = openTab(prev.preview.tabs, res, rev, openedFrom, nextOrdinal());
    return {
      ...prev,
      preview: {
        ...prev.preview,
        tabs: tabs.map((t) => (t.key === activeKey ? { ...t, requestGeneration: generation } : t)),
        activeKey,
        hidden: false,
        returnSnapshot: prev.preview.returnSnapshot ?? {
          target: openedFrom.target,
          sizes: { ...prev.layout.sizes },
        },
        contextChangedSinceOpen: false,
        side: openedFrom.target.kind === 'thread' ? 'thread' as const : 'pool' as const,
      },
    };
  });
  recordWrite('preview.open', `resource=${resourceId} revision=${rev} origin=${res.origin.kind} from=${openedFrom.target.kind}（只读，不发送/不执行）`);
  return true;
}

/** 激活已打开的标签（不改变其 openedFrom）。 */
export function activatePreview(key: string) {
  setState((s) => ({ ...s, preview: { ...s.preview, activeKey: key, hidden: false } }));
}

/** 记录标签的阅读位置（关闭/收起后恢复）。 */
export function rememberScroll(key: string, scrollTop: number) {
  setState((s) => ({
    ...s,
    preview: {
      ...s.preview,
      tabs: s.preview.tabs.map((t) => (t.key === key ? { ...t, scrollTop } : t)),
    },
  }));
}

/* ============================================================
   关闭 / 收起 / 放大
   ============================================================ */

export function closePreviewTab(key: string) {
  const s = getState();
  const target = s.preview.tabs.find((t) => t.key === key);
  const { tabs, activeKey } = closeTabPure(s.preview.tabs, key);
  setState((prev) => {
    const next = {
      ...prev.preview,
      tabs,
      activeKey,
      returnSnapshot: tabs.length === 0 ? undefined : prev.preview.returnSnapshot,
      side: tabs.length === 0 ? undefined : prev.preview.side,
    };
    return { ...prev, preview: next };
  });
  recordWrite('preview.tab.close', `key=${key} 剩余标签=${tabs.length}${tabs.length === 0 ? ' → 退出预览并恢复上下文' : ''}`);
  if (target) {
    const res = resourceOf(s, target.resourceId);
    toast(`已关闭 ${res?.title ?? key}${tabs.length === 0 ? '（预览已退出）' : ''}`, 'info');
  }
}

/** 收起整个预览区：保留标签与阅读位置（§4.5）。 */
export function hidePreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: true, maximized: false } }));
  recordWrite('preview.hide', '收起预览区：保留全部标签与阅读位置，未关闭任何文件');
}

export function showPreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: false } }));
}

export function closeAllPreviews() {
  const n = getState().preview.tabs.length;
  setState((s) => ({
    ...s,
    preview: { ...s.preview, tabs: [], activeKey: undefined, maximized: false, returnSnapshot: undefined, side: undefined },
  }));
  recordWrite('preview.close_all', `清空 ${n} 个标签 → 退出预览；未删除任何磁盘文件`);
  toast(`已关闭全部 ${n} 个文件`, 'info');
}

export function togglePreviewMaximized() {
  setState((s) => ({ ...s, preview: { ...s.preview, maximized: !s.preview.maximized } }));
}

/* ============================================================
   工作区文件重新读取（PV-09）
   ============================================================ */

/** 工作区文件读取到的真实内容/身份回填（预览面板装载后调用——hash/大小为服务端事实）。
 *  R70 F8：binaryKind=二进制阅读类（pdf/docx/xlsx/pptx/image——content 记 unsupported
 *  binary 类（正文由格式视图自带），mimeType 按 kind 修正；hash/大小必为真实值）。 */
export function applyWorktreeRead(
  resourceId: string,
  data: { text?: string; hash?: string; sizeBytes?: number; revision?: number; notPreviewable?: 'binary' | 'too_large'; note?: string; binaryKind?: string },
): void {
  const kindLabel: Record<string, string> = {
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    image: 'image/*', markdown: 'text/markdown', html: 'text/html', csv: 'text/csv',
  };
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) => {
      if (r.id !== resourceId) return r;
      const ext = (r.relativePath ?? '').split('.').pop()?.toLowerCase() ?? '';
      const content = data.notPreviewable != null
        ? { kind: 'unsupported' as const, reason: data.notPreviewable === 'binary' ? 'binary' as const : 'too_large' as const, note: data.note ?? '不可预览' }
        : data.binaryKind != null
          ? { kind: 'unsupported' as const, reason: 'binary' as const, note: `二进制阅读类（${data.binaryKind}）——正文由格式视图按原字节渲染` }
          : ext === 'md' || data.binaryKind === 'markdown'
            ? { kind: 'markdown' as const, text: data.text ?? '' }
            : ext === 'csv' || ext === 'tsv'
              ? { kind: 'csv' as const, text: data.text ?? '' }
              : { kind: ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'json' ? 'code' as const : 'text' as const, language: ext, text: data.text ?? '' };
      return {
        ...r,
        ...(data.binaryKind != null && kindLabel[data.binaryKind] != null ? { mimeType: kindLabel[data.binaryKind] } : {}),
        revisions: r.revisions.map((rev) => (rev.revision === (data.revision ?? rev.revision)
          ? { ...rev, hash: data.hash ?? rev.hash, sizeBytes: data.sizeBytes ?? rev.sizeBytes, content }
          : rev)),
      };
    }),
  }));
}

/** R68 §6：交付文档装载回填——内容按 markdown（turn 最终输出的阅读风味）；hash 保持
 *  manifest（交付身份），sizeBytes 用 delivery.document 的真实字节数。不可变快照（无重载链）。 */
export function applyDeliveryRead(resourceId: string, data: { text: string; bytes: number; revision: number }): void {
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) => (r.id !== resourceId ? r : {
      ...r,
      revisions: r.revisions.map((rev) => (rev.revision === data.revision
        ? { ...rev, sizeBytes: data.bytes, content: { kind: 'markdown' as const, text: data.text } }
        : rev)),
    })),
  }));
}

/** 磁盘已更新：新增读取版本但**不自动切换**（用户点"重新加载"才切）。 */
export function markResourceUpdated(resourceId: string) {  const s = getState();  const res = resourceOf(s, resourceId);
  if (!res) return;
  const latest = latestRevisionOf(res);
  if (!latest) return;
  if (latest.hash.endsWith(`_r${latest.revision}`)) return; // 已标记脏（R68 轮询幂等）——等用户重载
  const nextRev = latest.revision + 1;
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) =>
      r.id !== resourceId
        ? r
        : { ...r, revisions: [...r.revisions, { ...latest, revision: nextRev, createdAt: Date.now(), hash: `${latest.hash}_r${nextRev}` }] },
    ),
    preview: {
      ...prev.preview,
      tabs: prev.preview.tabs.map((t) =>
        t.resourceId === resourceId && res.mutable === true
          ? { ...t, pendingRevision: nextRev }
          : t,
      ),
    },
  }));
  recordWrite('preview.resource.updated', `resource=${resourceId} → 磁盘已更新，提示而不替换正在读的内容`);
}

/** 用户显式重新加载当前文件（更新读取快照）。 */
export function reloadResource(revision: number, key: string) {
  setState((s) => ({
    ...s,
    preview: {
      ...s.preview,
      tabs: s.preview.tabs.map((t) => (t.key === key ? { ...t, revision, pendingRevision: undefined } : t)),
    },
  }));
  recordWrite('preview.resource.reload', `key=${key} revision=${revision}（只更新读取快照，已插入草稿引用仍绑原版本）`);
}

/* ============================================================
   引用（r61 用户批准合同：引用卡默认 + 摘录独立）
   ============================================================ */

/**
 * 把当前文件引用加入指定目标草稿。
 *
 * 正式语义（r61 重做后用户批准的形态）：
 *  - 附件/成果资源（有真实 attachmentId）→ **引用卡**直写目标草稿（addFileRefToDraft：
 *    同文件同版本去重、跨会话拒绝、失败零写入、focus-composer）；
 *  - 摘录文本 → 独立摘录通道（queueDraftInsert：内容前缀插入队列，Composer 挂载即消费）；
 *  - 工作区文件（未上传为会话附件）→ 不能直接引用（如实说明，不自动上传）。
 */
export function quoteResource(
  resourceId: string,
  revision: number,
  targetDraftKey: string,
  targetLabel: string,
  excerpt?: string,
): boolean {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) return false;
  const rev = revisionOf(res, revision);
  if (!rev) {
    toast('该版本已不可用，引用未加入草稿', 'error');
    return false;
  }
  if (res.formalWorktree != null) {
    toast('工作区文件未上传为会话附件——不能直接引用进草稿（打开只是只读预览；需要引用请先把文件拖入输入区上传）', 'warn');
    return false;
  }
  if (res.formalDelivery != null) {
    // R68 §6：交付文档引用=**结构化文字引用**（版本+manifest 绑定进正文）——交付不是会话
    // 托管附件，不存在可携带的 attachmentId；不伪造附件引用合同。摘录来自已装载正文。
    const fd = res.formalDelivery;
    const revText = rev.content.kind === 'text' || rev.content.kind === 'markdown' || rev.content.kind === 'code' || rev.content.kind === 'csv'
      ? rev.content.text : '';
    const body = revText.replace(/\s+/g, ' ').trim().slice(0, 160);
    const line = `> 引用交付「${fd.taskTitle || res.title}」v${fd.revision}（manifest ${fd.manifestHash.slice(0, 12)}…）${body.length > 0 ? `：${body}` : ''}`;
    const r = queueDraftInsert(targetDraftKey, line);
    if (r.ok) {
      recordWrite('preview.quote', `交付 ${fd.deliveryId} v${fd.revision} → 目标草稿 ${targetDraftKey}（文字引用：版本+manifest 绑定；交付非会话附件，不伪造附件引用）`);
      toast(r.queued === false ? '相同交付引用已在待插入队列（不重复）' : `已引用交付 v${fd.revision}（manifest ${fd.manifestHash.slice(0, 8)}…）到「${targetLabel}」——文字引用带版本绑定`, 'success');
    }
    return r.ok;
  }
  const attachmentId = res.formalAttachment?.attachmentId ?? res.id;
  const conversationId = conversationOfDraftKey(targetDraftKey) ?? res.formalAttachment?.conversationId ?? '';
  const r = addFileRefToDraft(targetDraftKey, conversationId, {
    attachmentId,
    name: res.title,
    kind: res.formalAttachment?.kind ?? res.mimeType,
    revision,
    hash: rev.hash.startsWith('(') ? undefined : rev.hash,
  });
  if (!r.ok) {
    toast(`引用失败：${r.error ?? '未知错误'}（未写入）`, 'error');
    return false;
  }
  if (excerpt != null && excerpt.trim().length > 0) {
    queueDraftInsert(targetDraftKey, `> 摘录「${res.title}」v${revision}：${excerpt.trim().slice(0, 400)}`);
  }
  recordWrite('preview.quote', `resource=${resourceId} revision=${revision} → 目标草稿 ${targetDraftKey}（固定版本；正文保持用户文字）`);
  toast(r.existed === true
    ? `「${res.title}」已在「${targetLabel}」引用（同文件同版本不重复）`
    : `已引用「${res.title}」到「${targetLabel}」的输入区（发送时按正式附件合同携带版本/hash）`, 'success');
  return true;
}

/* ============================================================
   评论（§7.4 / PV-20/21——正式：向源会话仅记录提交）
   ============================================================ */

export interface FileCommentDraft { body: string }

/**
 * 文件评论的正式落点由页面执行（需要 commandId/账本管线）；这里只做归属与参数校验，
 * 返回发送所需的目标。评论=向**源会话**发一条仅记录消息并携带该附件引用卡——
 * 不触发模型派发、不串会话（PV-20）。
 */
export function fileCommentTarget(resourceId: string): {
  ok: boolean;
  kind?: 'thread' | 'room' | 'dm';
  conversationId?: string;
  threadId?: string;
  roomId?: string;
  attachmentId?: string;
  filename?: string;
  error?: string;
} {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (res == null) return { ok: false, error: '资源不存在' };
  if (res.formalWorktree != null) return { ok: false, error: '工作区文件不属于任何会话——评论需要先在某个会话里讨论它' };
  const attachmentId = res.formalAttachment?.attachmentId ?? res.id;
  const o = res.origin;
  if (o.kind === 'message' && o.threadId != null) {
    const t = s.threads.find((x) => x.id === o.threadId);
    return { ok: true, kind: 'thread', threadId: o.threadId, roomId: t?.roomId ?? o.roomId, attachmentId, filename: res.title };
  }
  if (o.kind === 'message') {
    return { ok: true, kind: 'room', roomId: o.roomId, attachmentId, filename: res.title };
  }
  if (o.kind === 'dm') {
    return { ok: true, kind: 'dm', conversationId: o.conversationId, attachmentId, filename: res.title };
  }
  return { ok: false, error: '该资源不属于任何会话' };
}

/* ============================================================
   布局
   ============================================================ */

export function setLayoutSize(mode: string, ratio: number) {
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  setState((s) => ({
    ...s,
    layout: { ...s.layout, sizes: { ...s.layout.sizes, [mode]: clamped } },
  }));
}

export function setNavPinned(pinned: boolean) {
  setState((s) => ({ ...s, layout: { ...s.layout, navPinned: pinned, navAutoHidden: false } }));
  recordWrite('layout.nav.pin', `用户显式${pinned ? '锁定' : '解除锁定'}导航展开；自动隐藏不覆盖该偏好`);
}

/** 导航自动临时隐藏（幂等——值不变不产生新状态，防重渲染循环）。 */
export function setNavAutoHidden(hidden: boolean) {
  setState((s) => {
    if (s.layout.navPinned && hidden) return s;
    if (s.layout.navAutoHidden === hidden) return s;
    return { ...s, layout: { ...s.layout, navAutoHidden: hidden } };
  });
}

/* ============================================================
   DM audience 隔离（§7.5 / PV-32）
   ============================================================ */

export function visibleTabs(target: ContextTarget) {
  const s = getState();
  return s.preview.tabs
    .filter((t) => {
      const res = resourceOf(s, t.resourceId);
      return res ? audienceAllows(res.audience, target) : false;
    })
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function hiddenTabCount(target: ContextTarget): number {
  const s = getState();
  return s.preview.tabs.length - visibleTabs(target).length;
}

/* ============================================================
   兼容入口
   ============================================================ */

export function resourceIdForArtifact(artifactId: string): string | undefined {
  return resourceOf(getState(), artifactId) ? artifactId : undefined;
}

export function activeTab() {
  const s = getState();
  return s.preview.tabs.find((t) => t.key === s.preview.activeKey);
}

export function activeResource(): PreviewResource | undefined {
  const t = activeTab();
  return t ? resourceOf(getState(), t.resourceId) : undefined;
}

export { tabKeyFor };

/** 打开标签的短别名（预览壳桥接/页面用——openPreview 的资源版）。 */
export const openPreviewTab = openPreview;

/* ============================================================
   评论提交桥（§7.4 正式落点：向源会话仅记录提交，携带引用卡）
   ============================================================ */

import { stageOutbound, settleOutbound, dropOutbound, confirmOutboundUnknown } from './store';
import type { PendingSendEnvelope } from './store';

/**
 * 文件评论正式提交：向**源会话**（thread/room/dm 由资源归属决定）发一条 record_only
 * message.submit，并把该附件作为 attachmentRefs 引用卡随信封携带——不触发模型派发、
 * 不串会话（PV-20）、版本锚定在引用卡内。出站账本管线与普通发送一致（r62 P1）。
 */
export async function createFileCommentBridge(resourceId: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const target = fileCommentTarget(resourceId);
  if (!target.ok) return { ok: false, error: target.error ?? '无法确定评论归属' };
  const s = getState();
  const projectId = s.activeProjectId;
  let env: PendingSendEnvelope;
  const commandId = `cmd_comment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (target.kind === 'thread' && target.threadId != null) {
    const thread = s.threadEntities[target.threadId];
    env = {
      commandId, method: 'message.submit',
      params: {
        target: { kind: 'thread', projectId: thread?.projectId ?? projectId, conversationId: thread?.conversationId ?? '', threadId: target.threadId ?? '' },
        body, intent: 'record_only', mentions: [], attachmentRefs: [target.attachmentId ?? resourceId],
      },
      targetLabel: `thread:${target.threadId}`, at: Date.now(),
    };
  } else if (target.kind === 'dm' && target.conversationId != null) {
    env = {
      commandId, method: 'message.submit',
      params: { target: { kind: 'dm', projectId, conversationId: target.conversationId ?? '' }, body, intent: 'record_only', mentions: [], attachmentRefs: [target.attachmentId ?? resourceId] },
      targetLabel: `dm:${target.conversationId}`, at: Date.now(),
    };
  } else {
    const room = s.rooms.find((r) => r.id === target.roomId);
    if (room == null) return { ok: false, error: '源房间未装载——无法提交评论' };
    env = {
      commandId, method: 'message.submit',
      params: { target: { kind: 'room_root', projectId, conversationId: room.conversationId ?? '', roomId: room.id }, body, intent: 'record_only', mentions: [], attachmentRefs: [target.attachmentId ?? resourceId] },
      targetLabel: `room:${room.id}`, at: Date.now(),
    };
  }
  const draftKey = `comment:${resourceId}`;
  const staged = stageOutbound(draftKey, env);
  if (staged.ok !== true) return { ok: false, error: staged.error ?? '原信封未能耐久保存' };
  const { sendEnvelope } = await import('../loader');
  const r = await sendEnvelope(env);
  if (r.status === 'ok') { settleOutbound(draftKey, env, { recordThread: true }); return { ok: true }; }
  if (r.status === 'failed') { dropOutbound(draftKey, env); return { ok: false, error: `${r.code}: ${r.error}` }; }
  confirmOutboundUnknown(draftKey, env);
  return { ok: false, error: `结果未知（${r.error ?? ''}）——可在输入区横幅人工确认，评论不会重复提交` };
}
