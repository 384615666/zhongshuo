/**
 * 共享预览的状态动作（UX-PREVIEW-01 / §17.9）。
 *
 * 为什么集中在这里：施工说明 §6 要求"不在每页各建资源状态"。
 * 所有入口（主池消息、线程成果、房间文件、项目文件树、DM、搜索）
 * 都调用这里的动作，因此"打开文件"的语义只有一份实现。
 *
 * 三条不可违反的规则（§17.9）：
 *  1. 打开文件**不**发送、不验收、不写文件、不执行脚本（第 5 条）；
 *  2. 暂收区域保留阅读位置与独立草稿，面板操作**不停止任务**（第 3 条）；
 *  3. 迟到响应不得覆盖新目标，关闭的标签不得被回包重新打开（第 9 条）。
 */

import { getState, recordLocalOnly, setState, toast } from './store';
import {
  audienceAllows, buildDraftReference, closeTab as closeTabPure,
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

/**
 * 通知"左侧上下文已改变"。
 *
 * §3.4 第 2 条：期间**主动切过**房间/任务则关闭预览时保留最新选择，
 * 不跳回旧任务。所以用户导航时必须把 contextChangedSinceOpen 置位。
 */
export function noteContextChanged() {
  if (!getState().preview.contextChangedSinceOpen) {
    setState((s) => ({ ...s, preview: { ...s.preview, contextChangedSinceOpen: true } }));
  }
}

/**
 * 主动切换上下文后，预览并排的那一侧跟着走（§3.3）。
 *
 * 例：从主池打开文件（主池＋文件）→ 点开某条回复串 →
 * 左侧切到回复串、右侧继续看那份文件，**不需要先关掉文件**。
 * 与 `openPreview` 里的 `side` 是同一个字段：打开时按来源定，
 * 之后按用户实际导航到的上下文改。关掉/清空预览时一并复位。
 */
export function setPreviewContextSide(side: 'thread' | 'pool') {
  if (getState().preview.side === side) return;
  setState((s) => ({ ...s, preview: { ...s.preview, side } }));
}

/* ============================================================
   打开资源
   ============================================================ */

/**
 * 打开一个资源版本（唯一入口）。
 *
 * @param resourceId 资源 ID
 * @param revision 固定版本；不传则取最新（工作区"当前文件"）
 * @param openedFrom 本次打开位置（与资源真实 origin 不同，§17.9 第 1 条）
 */
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

  // 权限校验：当前上下文必须能看见该 audience（§17.9 第 7 条）
  if (!audienceAllows(res.audience, openedFrom.target)) {
    toast('当前上下文无权查看这份资源（私信附件不能跨会话共享）', 'error');
    recordLocalOnly(
      'preview.open.denied',
      `resource=${resourceId} audience=${res.audience.kind} → 拒绝：同 projectId 不是共享许可`,
    );
    return false;
  }

  const rev = revision ?? latestRevisionOf(res)?.revision;
  if (rev === undefined || !revisionOf(res, rev)) {
    toast('该版本不可用，未回退到其他版本', 'error');
    recordLocalOnly('preview.open.missing_revision', `resource=${resourceId} revision=${revision}`);
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
        // 第一次从非预览布局进入预览时记录返回快照（§3.4）
        returnSnapshot: prev.preview.returnSnapshot ?? {
          target: openedFrom.target,
          sizes: { ...prev.layout.sizes },
        },
        contextChangedSinceOpen: false,
        // §3.2：打开时并排的那一侧 = 你点击文件所在的那一侧
        // （从主池消息打开 → 主池＋文件；从回复串/成果打开 → 回复串＋文件）
        side: openedFrom.target.kind === 'thread' ? 'thread' as const : 'pool' as const,
      },
    };
  });

  recordLocalOnly(
    'preview.open',
    `resource=${resourceId} revision=${rev} origin=${res.origin.kind} from=${openedFrom.target.kind}（只读，不发送/不执行）`,
  );
  return true;
}

/** 激活已打开的标签（不改变其 openedFrom） */
export function activatePreview(key: string) {
  setState((s) => ({ ...s, preview: { ...s.preview, activeKey: key, hidden: false } }));
}

/** 记录标签的阅读位置（关闭/收起后恢复） */
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

/**
 * 关闭一个标签（§4.5）：切到右邻，无右邻则左邻；
 * 关掉最后一个 → 退出预览并按 §3.4 恢复。
 */
export function closePreviewTab(key: string) {
  const s = getState();
  const target = s.preview.tabs.find((t) => t.key === key);
  const { tabs, activeKey } = closeTabPure(s.preview.tabs, key);

  setState((prev) => {
    const next = {
      ...prev.preview,
      tabs,
      activeKey,
      // 最后一个标签关闭 → 退出预览（hidden=false 由"无标签"表达）
      returnSnapshot: tabs.length === 0 ? undefined : prev.preview.returnSnapshot,
      // 没有标签就谈不上"并排哪一侧"，一并复位，避免下次打开继承上一次的侧别
      side: tabs.length === 0 ? undefined : prev.preview.side,
    };
    return { ...prev, preview: next };
  });

  recordLocalOnly(
    'preview.tab.close',
    `key=${key} 剩余标签=${tabs.length}${tabs.length === 0 ? ' → 退出预览并恢复上下文' : ''}`,
  );
  if (target) {
    const res = resourceOf(s, target.resourceId);
    toast(`已关闭 ${res?.title ?? key}${tabs.length === 0 ? '（预览已退出）' : ''}`, 'info');
  }
}

/** 收起整个预览区：**保留标签与阅读位置**，稍后可重开（§4.5） */
export function hidePreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: true, maximized: false } }));
  recordLocalOnly('preview.hide', '收起预览区：保留全部标签与阅读位置，未关闭任何文件');
}

export function showPreview() {
  setState((s) => ({ ...s, preview: { ...s.preview, hidden: false } }));
}

/** 关闭所有文件：清空标签并退出预览（不删除磁盘文件） */
export function closeAllPreviews() {
  const n = getState().preview.tabs.length;
  setState((s) => ({
    ...s,
    preview: { ...s.preview, tabs: [], activeKey: undefined, maximized: false, returnSnapshot: undefined, side: undefined },
  }));
  recordLocalOnly('preview.close_all', `清空 ${n} 个标签 → 退出预览；未删除任何磁盘文件`);
  toast(`已关闭全部 ${n} 个文件`, 'info');
}

export function togglePreviewMaximized() {
  setState((s) => ({ ...s, preview: { ...s.preview, maximized: !s.preview.maximized } }));
}

/* ============================================================
   工作区文件重新读取（PV-09）
   ============================================================ */

/**
 * 文件被外部修改：**只提示，不抢正文**。
 * 用户点击"重新加载"才切换版本；已插入草稿的引用仍绑定原快照。
 */
export function markResourceUpdated(resourceId: string) {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) return;
  // 工作区资源新增一个读取版本，但**不自动切换**活动标签
  const latest = latestRevisionOf(res);
  if (!latest) return;
  const nextRev = latest.revision + 1;
  setState((prev) => ({
    ...prev,
    resources: prev.resources.map((r) =>
      r.id !== resourceId
        ? r
        : {
            ...r,
            revisions: [
              ...r.revisions,
              {
                ...latest,
                revision: nextRev,
                createdAt: Date.now(),
                hash: `${latest.hash}_r${nextRev}`,
              },
            ],
          },
    ),
    preview: {
      ...prev.preview,
      tabs: prev.preview.tabs.map((t) =>
        t.resourceId === resourceId && !res.mutable === false
          ? { ...t, pendingRevision: nextRev }
          : t,
      ),
    },
  }));
  recordLocalOnly('preview.resource.updated', `resource=${resourceId} → 磁盘已更新，提示而不替换正在读的内容`);
}

/** 用户显式重新加载当前文件（更新读取快照） */
export function reloadResource(revision: number, key: string) {
  setState((s) => ({
    ...s,
    preview: {
      ...s.preview,
      tabs: s.preview.tabs.map((t) =>
        t.key === key ? { ...t, revision, pendingRevision: undefined } : t,
      ),
    },
  }));
  recordLocalOnly('preview.resource.reload', `key=${key} revision=${revision}（只更新读取快照，已插入草稿引用仍绑原版本）`);
}

/* ============================================================
   引用（§7.3 / PV-06）
   ============================================================ */

/**
 * 把当前文件引用加入**指定目标草稿**。
 *
 * 目标是点击时捕获的（capturedTarget），不是"当前选中" ——
 * 异步读取完成后用户可能已经切到别的任务，此时不能插进新任务（PV-06）。
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

  const ref = buildDraftReference(res, rev, excerpt);
  const quote = {
    id: ++generationCounter,
    draftKey: targetDraftKey,
    targetLabel,
    reference: ref,
  };
  setState((prev) => ({ ...prev, pendingQuotes: [...prev.pendingQuotes, quote] }));
  recordLocalOnly(
    'preview.quote',
    `resource=${resourceId} revision=${revision} hash=${ref.hash.slice(0, 12)} → 目标草稿 ${targetDraftKey}（固定版本，不随当前选择漂移）`,
  );
  return true;
}

/** 取出并清空某草稿的待插入引用（Composer 消费） */
export function takePendingQuotes(draftKey: string): DraftReference[] {
  const s = getState();
  const mine = s.pendingQuotes.filter((q) => q.draftKey === draftKey);
  if (mine.length === 0) return [];
  setState((prev) => ({
    ...prev,
    pendingQuotes: prev.pendingQuotes.filter((q) => q.draftKey !== draftKey),
  }));
  return mine.map((q) => q.reference);
}

/* ============================================================
   评论（§7.4 / PV-20/21）
   ============================================================ */

/**
 * 文件评论固定**源会话**、文件版本与锚点。
 *
 * 在任务 B 的对话里评论来自 A 的文件，评论仍归 A ——
 * 不能因为"当前在看 B"就把源文件评论归到 B（这是真实且难查的串线 bug）。
 */
export function createFileComment(
  resourceId: string,
  revision: number,
  anchor: DraftReference['anchor'],
  body: string,
): void {
  const s = getState();
  const res = resourceOf(s, resourceId);
  if (!res) return;
  const originDesc =
    res.origin.kind === 'task' ? `任务 ${res.origin.taskId}`
      : res.origin.kind === 'dm' ? `私信 ${res.origin.conversationId}`
        : res.origin.kind === 'message' ? `消息 ${res.origin.messageId}`
          : '项目工作区';

  recordLocalOnly(
    'fileComment.create',
    `resource=${resourceId} revision=${revision} anchor=${anchor?.kind ?? 'file'} body=${JSON.stringify(body.slice(0, 40))} → 评论归入源会话「${originDesc}」；文件更新后旧评论标为旧版（不静默漂移）`,
  );
  toast(`评论已提交到源会话（${originDesc}），锚定在 v${revision}；原型不落库`, 'success');
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
  recordLocalOnly('layout.nav.pin', `用户显式${pinned ? '锁定' : '解除锁定'}导航展开；自动隐藏不覆盖该偏好`);
}

/**
 * 设置/清除"导航被自动临时隐藏"。
 *
 * **必须幂等**（实测踩到 "Maximum update depth exceeded"）：
 * 早先版本无条件 `{ ...s, layout: { ... } }`，即使值没变也产生新对象 →
 * `useStore` 订阅者全部重渲染 → 布局 effect 再跑 → 再 setState → 无限循环。
 * 现在值相同就直接返回原状态，store 不会 emit。
 */
export function setNavAutoHidden(hidden: boolean) {
  setState((s) => {
    // 用户显式锁定展开时，自动隐藏不得生效（§5.3 第 3 条）
    if (s.layout.navPinned && hidden) return s;
    // 幂等：值没变就不产生新状态，避免触发无意义的重渲染循环
    if (s.layout.navAutoHidden === hidden) return s;
    return { ...s, layout: { ...s.layout, navAutoHidden: hidden } };
  });
}

/* ============================================================
   DM audience 隔离（§7.5 / PV-32）
   ============================================================ */

/**
 * 当前上下文下**可见**的标签。
 * 不可见的标签既不能显示正文，也不能在"已打开"列表里露出标题。
 */
export function visibleTabs(target: ContextTarget) {
  const s = getState();
  return s.preview.tabs
    .filter((t) => {
      const res = resourceOf(s, t.resourceId);
      return res ? audienceAllows(res.audience, target) : false;
    })
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** 当前上下文下被暂藏的标签数（用于如实提示，不泄露文件名） */
export function hiddenTabCount(target: ContextTarget): number {
  const s = getState();
  return s.preview.tabs.length - visibleTabs(target).length;
}

/* ============================================================
   工作区文件（项目文件树 / Git）复用共享预览
   ============================================================ */

/**
 * 把项目文件树里的一个 mock 节点变成可预览资源并打开。
 *
 * 为什么需要这个函数（施工说明 §6、§11.5 B2）：
 * 文件页原来有**自己的预览壳**（一个 `<pre>` + 自己的卡头），
 * 于是"预览器"有两套实现 —— 一套在房间/线程，一套在文件页，
 * 必然漂移（比如版本徽标、来源行、引用按钮只在其中一套里）。
 * 现在文件树选中节点也走**同一个** PreviewPane。
 *
 * 资源按 `projectId + relativePath` 稳定生成 ID：同一路径重复打开
 * 命中去重逻辑（§6.1），不会每点一次多一个标签。
 *
 * 边界：内容来自**mock 文件树**（明确标注），不读取真实磁盘。
 * 二进制/过大在这里转成 `unsupported` 内容，与文件页原有说明一致。
 */
export function openWorktreeNode(
  projectId: string,
  relativePath: string,
  node: {
    preview?: string;
    notPreviewable?: 'binary' | 'too_large';
    sizeBytes?: number;
  },
  openedFrom: ContextLocation,
): boolean {
  const resourceId = `res_wt_${projectId}_${relativePath.replace(/[^a-zA-Z0-9]+/g, '_')}`;
  const now = Date.now();

  setState((prev) => {
    if (prev.resources.some((r) => r.id === resourceId)) return prev;

    const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
    const hash = `mock_${relativePath.length}_${(node.preview ?? '').length}`;

    let content: import('./types').ResourceContent;
    if (node.notPreviewable === 'binary') {
      content = {
        kind: 'unsupported', reason: 'binary',
        note: `这是二进制文件（${node.sizeBytes ?? 0} 字节），不提供文本预览。原型不读取真实磁盘内容。`,
      };
    } else if (node.notPreviewable === 'too_large') {
      content = {
        kind: 'unsupported', reason: 'too_large',
        note: '文件较大，已跳过内容预览以免卡住界面。打开真实文件请用外部编辑器。',
      };
    } else if (ext === 'md') {
      content = { kind: 'markdown', text: node.preview ?? '' };
    } else if (ext === 'csv') {
      content = { kind: 'csv', text: node.preview ?? '' };
    } else if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'json') {
      content = { kind: 'code', language: ext, text: node.preview ?? '' };
    } else {
      content = { kind: 'text', text: node.preview ?? '' };
    }

    const res: import('./types').PreviewResource = {
      id: resourceId,
      projectId,
      kind: 'worktree',
      title: relativePath.split('/').pop() ?? relativePath,
      relativePath,
      mimeType: ext ? `text/${ext}` : 'text/plain',
      origin: { kind: 'workspace' },
      audience: { kind: 'project' },
      mutable: true,
      revisions: [
        {
          revision: 1,
          hash,
          sizeBytes: node.sizeBytes ?? (node.preview ?? '').length,
          createdAt: now,
          content,
        },
      ],
      createdAt: now,
    };
    return { ...prev, resources: [...prev.resources, res] };
  });

  return openPreview(resourceId, 1, openedFrom);
}

/* ---------- 兼容旧入口：从 Artifact 打开 ---------- */

/**
 * 旧的 `openArtifact` 语义在资源层的落点。
 * Artifact 与 Resource 目前并存（Artifact 仍承载报告结构），
 * 这里给出映射，避免调用方各自拼 key。
 */
export function resourceIdForArtifact(artifactId: string): string | undefined {
  const s = getState();
  const art = s.artifacts.find((a) => a.id === artifactId);
  if (!art) return undefined;
  // 同名资源对应（原型种子里的映射）
  const byTitle = s.resources.find((r) => r.title === art.title);
  return byTitle?.id;
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
