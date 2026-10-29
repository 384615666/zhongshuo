import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 输入条（§4.1 / §4.2 / E6 / E8 / E3）
 *
 * 关键口径：
 *  - 普通输入**默认交给 AI**（2026-09-25 起）：不再有常驻的「任务/讨论」二选一；
 *    R90 起普通聊天/私信/线程均移除「仅记录」入口；历史 record 消息只保留数据语义，
 *    在历史记录串里继续聊天也会自然发起新的 AI 请求。
 *  - 协作模式由 @ 结构推导，不手选；发送前持续显示解析结果（§4.1、E6）
 *  - 方式芯片是上下文相关的一个开关，默认全关（E6 方案 A）
 *  - 意图标签显示实际能力，不画锁/盾；说明默认收起，点 ⓘ 才展开（E8、ADR-14）
 *  - E3：点到子任务卡后，输入条出现「→ 子任务 #n」目标标签
 *  - Enter 发送、Shift+Enter 换行、中文输入法组合态不发送（§17.4）
 *  - 发送中的 commandId 不变，重复点击不会创建多个任务（§17.4、RT-01）
 *  - 布局：工具条与状态行都是单行不折行；窄窗靠收窄间距与截断，而不是换行堆叠
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { Avatar, Menu, MenuItem, anchorFromElement, memberColor, Tag } from './ui';
import {
  useStore, getState, getDraftFull, setDraftFull, clearUnknownEnvelope, addUploadItem, settleUpload,
  settleUploadReady, removeUploadItem, hydrateUploadRefs, clearSettledUploads, openPreview,
  takeDraftInserts, settleOutbound, addFileRefToDraft, inlineAttachmentToken, parseInlineBody,
  stripInlineAttachmentTokens, staleAttachmentUploadIds,
} from '../data/store';
import type { PendingSendEnvelope, HifiDraft, HifiDraftAttachment, UploadItem, InlineAttachmentToken, InlineBodySegment } from '../data/store';
import {SendRecoveryAction} from './SendRecoveryAction';
import { deriveRoute, memberLabel, roomOf } from '../data/selectors';
import { routeModeCopy } from '../lib/format';
import { detectMentionRange, resolveMentionIds } from '../lib/mentionText';
import { command } from '../bridge';
import { uploadAttachmentFile, classifyAttachmentFile, defaultDeliberationMaxTurns } from '../loader';
import type { ProjectMember, Room } from '../data/types';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  parseCallBudgetEnabledSetting,
} from '../../../contracts/callBudget';

type MentionDocument = {
  key: string;
  kind: 'workspace' | 'uploaded';
  name: string;
  path?: string;
  attachmentId?: string;
  hash?: string;
  revision?: number;
  fileKind?: string;
  sizeBytes?: number | null;
};

type UploadClassification = ReturnType<typeof classifyAttachmentFile>;

function uploadContentIdentity(item: Pick<UploadItem, 'name' | 'size' | 'status' | 'removed' | 'contentHash' | 'hash'>): string | null {
  if (item.removed === true || item.status === 'failed') return null;
  const contentHash = item.contentHash ?? (item.status === 'ready' ? item.hash : undefined);
  return contentHash == null || contentHash.length === 0 ? null : `${item.name}\u0000${item.size}\u0000${contentHash}`;
}

/** Hash the selected bytes so files with equal name/size metadata never collide by accident. */
export async function uploadFileContentHash(file: Pick<File, 'arrayBuffer'>): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle == null) return null;
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // A failed hash must not turn into a false duplicate; accept the explicit selection.
    return null;
  }
}

export async function prepareUploadFiles(
  files: readonly File[],
  existing: readonly UploadItem[],
): Promise<Array<{ file: File; contentHash: string | null; cls: UploadClassification }>> {
  const seen = new Set(existing.map(uploadContentIdentity).filter((value): value is string => value != null));
  const accepted: Array<{ file: File; contentHash: string | null; cls: UploadClassification }> = [];
  for (const file of files) {
    const cls = classifyAttachmentFile(file.name, file.size);
    const contentHash = cls.cls === 'unsupported' ? null : await uploadFileContentHash(file);
    const identity = contentHash == null ? null : `${file.name}\u0000${file.size}\u0000${contentHash}`;
    if (identity != null && seen.has(identity)) continue;
    if (identity != null) seen.add(identity);
    accepted.push({ file, contentHash, cls });
  }
  return accepted;
}

/**
 * 意图标签的说明（E8 / ADR-14）。
 * 这里只讲实际能力，不给安全承诺——不画锁，也不写"受保护"。
 */
const INTENT_HINT =
  '当前为演示界面，未连接 AI。';

/**
 * 权限模式（四档，下拉选择）。
 *
 * 首版可用性（2026-09-20，按修订后的 ADR-14 / §9.6 同步）
 *
 * 首版使用经验证的 runtime 原生限制，adapter 转发确认请求与答复。
 * RT-23/B6 通过前「变更前确认」禁选，原因是尚未验证，并非永久后置。
 * DEV-06/10/14 承担最小确认通道，DEV-20 仅承担完整加固。
 * 此处 available 表示原型可交互，不代表 runtime 能力已认证；正式接入时按
 * runtime/adapter 版本、平台和成员逐项开放，失败不得回退为完全访问。
 *
 * 四档与设计文档的对应关系（选项 → 实际运行参数 → 不支持时如何处理）：
 *
 * | 档位 | §15.2 intent | 正式运行目标 | 当前原型 |
 * |---|---|---|---|
 * | 计划模式 | analyze | 本次止于方案，验证原生写入限制 | 可模拟选择 |
 * | 变更前确认 | modify | 转发原生审批，明确实际确认粒度 | 禁用，待 RT-23/B6 |
 * | 自动编辑 | modify | 授权范围内编辑，额外请求仍走确认 | 可模拟选择 |
 * | 完全访问 | modify | 明确选择后使用可用的更宽策略 | 可模拟选择 |
 *
 * 关于"计划模式"的边界：它**只覆盖只分析那一半**。决策 03「先给方案再执行」
 * 里的"再执行"不靠 approval，而是你看完方案后用新的输入继续 —— 那是一次新的
 * 后续执行，须重新核对有效策略、预算和目录租约，不复用方案确认充当工具审批。
 */
export type AccessMode = 'plan' | 'confirm' | 'auto_edit' | 'full_access';

export const ACCESS_MODES: {
  value: AccessMode;
  label: string;
  desc: string;
  icon: string;
  /** 映射到 §15.2 intent 的权限意图 */
  intent: 'analyze' | 'modify';
  /** 原型是否允许选择；正式能力须另按 runtime 验证记录判断 */
  v01: { available: true } | { available: false; reason: string };
}[] = [
  {
    value: 'plan',
    label: '计划模式',
    desc: '本次只出方案或分析，不自动转入修改。',
    icon: 'sparkles',
    intent: 'analyze',
    v01: { available: true },
  },
  {
    value: 'confirm',
    label: '变更前确认',
    desc: '需要授权的操作由你确认后继续，范围以实际工具能力为准。',
    icon: 'hand',
    intent: 'modify',
    v01: {
      available: false,
      reason: '暂未开放：权限限制与确认通道尚未验证，验证通过后按成员开放。',
    },
  },
  {
    value: 'auto_edit',
    label: '自动编辑',
    desc: '在项目已授权的范围内直接改文件，并记录改动集。',
    icon: 'edit',
    intent: 'modify',
    v01: { available: true },
  },
  {
    value: 'full_access',
    label: '完全访问',
    desc: '允许更宽的访问范围，仍遵守系统限制。',
    icon: 'alert-circle',
    intent: 'modify',
    v01: { available: true },
  },
];

/**
 * 输入条要能一眼看出「我现在是在发起，还是在跟进」（两份评审都把它列为第一优先）。
 *
 * 语义分三种，控件也随之不同：
 *  1. room_root + task       → 发起新任务：显示模式推导、参与者、预算、权限
 *  2. thread + task          → 跟进已有任务：延续该任务，不重建工作流；显示"延续 <模式>"
 *  3. thread/room + 讨论     → 纯备注：不调用 AI，**不显示**权限、预算、模式与分工控件
 */

export interface ComposerTarget {
  kind: 'room_root' | 'thread' | 'dm';
  /** 房间/线程用真实 roomId；私信用 `dm:<conversationId>`（诊断与资源归属都需要稳定 id） */
  roomId: string;
  threadId?: string;
  /** kind === 'dm' 时的会话 id（成员边界取自该私信的 audience，§4.6） */
  dmId?: string;
  /** E3：定向跟进某子任务 */
  subtask?: { taskId: string; number: number; title: string };
  /** 线程内是否显示「另起任务」（§17.4 始终可见） */
  showNewTask?: boolean;
}

/** 每键发送锁（review-r48 §4）：多目标在途互不解除——A 回执的 finally 只清 A 的键。 */
const sendingKeys = new Set<string>();
const imageCheckingKeys = new Set<string>();
/** 附件上传项的稳定空集（selector 引用稳定——useSyncExternalStore 契约）。 */
const EMPTY_UPLOADS: UploadItem[] = [];
const DELIBERATION_BUDGET_MAX = 500;

/**
 * 独立研讨实际可冻结的名单人数。`all` 只展开到当前上下文可用成员，
 * 不会把线程/房间外的成员算进来。
 */
export function deliberationRosterSize(mentionIds: string[], availableMemberIds: string[]): number {
  const available = new Set(availableMemberIds);
  if (mentionIds.includes('all')) return available.size;
  return new Set(mentionIds.filter((id) => id !== 'all' && available.has(id))).size;
}

/** 服务端预算约束：2..500，且至少 1 次整合 + N 次逐成员确认。 */
export function deliberationBudgetBounds(
  mentionIds: string[],
  availableMemberIds: string[],
): { rosterSize: number; minimum: number; maximum: number } {
  const rosterSize = deliberationRosterSize(mentionIds, availableMemberIds);
  return {
    rosterSize,
    minimum: Math.max(2, rosterSize + 1),
    maximum: DELIBERATION_BUDGET_MAX,
  };
}

export function isValidDeliberationBudget(value: number, mentionIds: string[], availableMemberIds: string[]): boolean {
  const bounds = deliberationBudgetBounds(mentionIds, availableMemberIds);
  return Number.isInteger(value) && value >= bounds.minimum && value <= bounds.maximum;
}

function serializeEditorNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.dataset.zsInlineToken === '1') return node.dataset.zsRawToken ?? '';
  if (node instanceof HTMLBRElement) return '\n';
  let text = '';
  node.childNodes.forEach((child) => { text += serializeEditorNode(child); });
  if (node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P') && text.length > 0 && !text.endsWith('\n')) text += '\n';
  return text;
}

/** 编辑区正文序列化（token 保留原始串）——导出供真实 Chromium 验证脚本读取编辑区文本。 */
export function serializeEditor(editor: HTMLElement | null): string {
  if (editor == null) return '';
  let text = '';
  editor.childNodes.forEach((child) => { text += serializeEditorNode(child); });
  return text;
}

/**
 * R91：行内附件 token 的身份（合并时的匹配键）。回执结算保留 uploadId，所以优先用它；
 * 已就绪引用用 attachmentId；两者都缺时退回 kind+name（仅失败/未知 token 才会走到这里）。
 */
function inlineTokenIdentity(token: InlineAttachmentToken): string {
  if (token.uploadId != null && token.uploadId.length > 0) return `upload:${token.uploadId}`;
  if (token.attachmentId != null && token.attachmentId.length > 0) return `attachment:${token.attachmentId}`;
  return `${token.kind}:${token.name}`;
}

/**
 * R91：组合输入结束时的「DOM 文本 + 草稿 token」合并（纯函数，便于单测）。
 *
 * **权威来源（明确规则）**：
 *  - 正文文本 = DOM：用户刚完成的组合串绝不能被较早的草稿覆盖（旧实现直接 setBody(草稿)
 *    会丢字）。
 *  - token 集合/顺序/最新原始串 = 草稿：组合期间上传回执（upload→file）、引用 hydrate 新增、
 *    token 移除都可能已落 store。DOM 里过期的 token 不得复活已移除项；store 新增的 token
 *    不得被丢。DOM 中已有 token 保持 DOM 位置；store 新增而 DOM 缺失的 token 以草稿顺序里
 *    相邻的已存在 token 为锚插入，无锚时沿用 hydrate 的「追加到末尾」口径。
 */
export function mergeCompositionEditorBody(domText: string, storedText: string): string {
  const domSegments = parseInlineBody(domText);
  const storedTokens = parseInlineBody(storedText).filter(
    (segment): segment is Extract<InlineBodySegment, { kind: 'attachment' }> => segment.kind === 'attachment',
  );
  const storedRawByKey = new Map<string, string>();
  for (const segment of storedTokens) storedRawByKey.set(inlineTokenIdentity(segment.token), segment.raw);
  const presentKeys = new Set<string>();
  type Item = { kind: 'text'; text: string } | { kind: 'token'; identity: string; raw: string };
  const items: Item[] = [];
  for (const segment of domSegments) {
    if (segment.kind === 'text') {
      items.push({ kind: 'text', text: segment.text });
      continue;
    }
    const identity = inlineTokenIdentity(segment.token);
    const raw = storedRawByKey.get(identity);
    // 草稿里已没有该 token（组合期间被移除）→ 丢弃，不复活；仍在→换成草稿最新 raw。
    if (raw == null) continue;
    presentKeys.add(identity);
    items.push({ kind: 'token', identity, raw });
  }
  for (let index = 0; index < storedTokens.length; index += 1) {
    const identity = inlineTokenIdentity(storedTokens[index]!.token);
    if (presentKeys.has(identity)) continue;
    let insertAt = items.length;
    // 前一个仍存在的草稿 token 之后最接近 DOM 位置。
    for (let prev = index - 1; prev >= 0; prev -= 1) {
      const prevKey = inlineTokenIdentity(storedTokens[prev]!.token);
      const pos = items.findIndex((item) => item.kind === 'token' && item.identity === prevKey);
      if (pos >= 0) { insertAt = pos + 1; break; }
    }
    if (insertAt === items.length) {
      // 没有前锚时退到后一个仍存在的 token 之前；都没有则追加（hydrate 的既有口径）。
      for (let next = index + 1; next < storedTokens.length; next += 1) {
        const nextKey = inlineTokenIdentity(storedTokens[next]!.token);
        const pos = items.findIndex((item) => item.kind === 'token' && item.identity === nextKey);
        if (pos >= 0) { insertAt = pos; break; }
      }
    }
    presentKeys.add(identity);
    items.splice(insertAt, 0, { kind: 'token', identity, raw: storedTokens[index]!.raw });
  }
  let merged = '';
  let afterToken = false;
  for (const item of items) {
    if (item.kind === 'text') {
      merged += afterToken && item.text.length > 0 && !/^\s/.test(item.text) ? ` ${item.text}` : item.text;
      afterToken = false;
    } else {
      merged += merged.length > 0 && !/\s$/.test(merged) ? ` ${item.raw}` : item.raw;
      afterToken = true;
    }
  }
  return merged;
}

/**
 * 编辑区选择快照（R91）：轮询刷新/回执同步前后保持 selection 方向、区间与滚动位置。
 *
 * `shape` 是「token 按 1 个占位符计」的结构串；只改变 token 原始串长度（upload→file）时
 * shape 不变，恢复时使用 `startUnit/endUnit`（按节点/segment 映射），不会把 token 之后的
 * 文本位置按旧绝对偏移挪走；正文结构真的变了才退回绝对偏移（旧口径）。
 */
interface EditorSelectionSnapshot {
  start: number;
  end: number;
  startUnit: number;
  endUnit: number;
  direction: 'forward' | 'backward';
  scrollTop: number;
  shape: string;
}

const EDITOR_SHAPE_TOKEN = '\u0001';

/** 结构串：文本逐字、token=1 个占位符、<br>=换行——与 token 原始串长度无关。 */
function serializeEditorShape(editor: HTMLElement | null): string {
  if (editor == null) return '';
  let shape = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { shape += node.textContent ?? ''; return; }
    if (node instanceof HTMLElement && node.dataset.zsInlineToken === '1') { shape += EDITOR_SHAPE_TOKEN; return; }
    if (node instanceof HTMLBRElement) { shape += '\n'; return; }
    node.childNodes.forEach(walk);
  };
  editor.childNodes.forEach(walk);
  return shape;
}

/** DOM 点位 → 正文序列化偏移（用与渲染同口径的 serializeEditor 计算前缀长度）。 */
function serializeOffset(editor: HTMLElement, node: Node, offset: number): number | null {
  if (!editor.contains(node)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.appendChild(prefix.cloneContents());
  return serializeEditor(holder).length;
}

/** DOM 点位 → 结构串偏移（token 只占 1 位，用于 token 原始串变化时的稳定映射）。 */
function shapeOffset(editor: HTMLElement, node: Node, offset: number): number | null {
  if (!editor.contains(node)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.appendChild(prefix.cloneContents());
  return serializeEditorShape(holder).length;
}

/** 结构串偏移 → DOM 点位（token 作为原子占 1 位；边界落在 token 前后）。 */
function domPointAtShapeOffset(editor: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);
  const walk = (node: Node): { node: Node; offset: number } | null => {
    const children = Array.from(node.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.nodeType === Node.TEXT_NODE) {
        const length = child.textContent?.length ?? 0;
        if (remaining <= length) return { node: child, offset: remaining };
        remaining -= length;
        continue;
      }
      if (child instanceof HTMLElement && child.dataset.zsInlineToken === '1') {
        if (remaining === 0) return { node, offset: index };
        remaining -= 1;
        if (remaining === 0) return { node, offset: index + 1 };
        continue;
      }
      if (child instanceof HTMLBRElement) {
        if (remaining === 0) return { node, offset: index };
        remaining -= 1;
        if (remaining === 0) return { node, offset: index + 1 };
        continue;
      }
      const nested = walk(child);
      if (nested != null) return nested;
    }
    return remaining === 0 ? { node, offset: children.length } : null;
  };
  return walk(editor) ?? { node: editor, offset: editor.childNodes.length };
}

function captureEditorSelection(editor: HTMLElement | null): EditorSelectionSnapshot | null {
  if (editor == null) return null;
  const serializedLength = serializeEditor(editor).length;
  const shape = serializeEditorShape(editor);
  const scrollTop = editor.scrollTop;
  const selection = window.getSelection();
  if (selection == null || selection.rangeCount === 0 || selection.anchorNode == null || selection.focusNode == null) {
    // 选择不在编辑区：沿用旧行为——重建后光标落在正文末尾（上传/引用插入后的既有口径）。
    return { start: serializedLength, end: serializedLength, startUnit: shape.length, endUnit: shape.length, direction: 'forward', scrollTop, shape };
  }
  const anchor = serializeOffset(editor, selection.anchorNode, selection.anchorOffset);
  const focus = serializeOffset(editor, selection.focusNode, selection.focusOffset);
  const anchorUnit = shapeOffset(editor, selection.anchorNode, selection.anchorOffset);
  const focusUnit = shapeOffset(editor, selection.focusNode, selection.focusOffset);
  if (anchor == null || focus == null || anchorUnit == null || focusUnit == null) {
    return { start: serializedLength, end: serializedLength, startUnit: shape.length, endUnit: shape.length, direction: 'forward', scrollTop, shape };
  }
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    startUnit: Math.min(anchorUnit, focusUnit),
    endUnit: Math.max(anchorUnit, focusUnit),
    direction: anchor <= focus ? 'forward' : 'backward',
    scrollTop,
    shape,
  };
}

/** 重建编辑区后恢复选择：保留非折叠区间与方向（backward 用 setBaseAndExtent 反转），并恢复滚动。 */
function restoreEditorSelection(editor: HTMLElement, snapshot: EditorSelectionSnapshot): void {
  const shapeNow = serializeEditorShape(editor);
  // token 原始串长度可能变了（upload→file）：结构未变时按 token=1 位的映射恢复，
  // 否则 token 之后的文本位置会按旧绝对偏移被挪走。结构真变了才用旧绝对偏移口径。
  const useShape = shapeNow === snapshot.shape;
  const serializedLength = serializeEditor(editor).length;
  const shapeLength = shapeNow.length;
  const start = useShape
    ? Math.max(0, Math.min(snapshot.startUnit, shapeLength))
    : Math.max(0, Math.min(snapshot.start, serializedLength));
  const end = useShape
    ? Math.max(start, Math.min(snapshot.endUnit, shapeLength))
    : Math.max(start, Math.min(snapshot.end, serializedLength));
  editor.focus({ preventScroll: true });
  const startPoint = useShape ? domPointAtShapeOffset(editor, start) : domPointAtOffset(editor, start);
  const endPoint = useShape ? domPointAtShapeOffset(editor, end) : domPointAtOffset(editor, end);
  const selection = window.getSelection();
  if (selection == null) return;
  if (snapshot.direction === 'backward' && start !== end) {
    selection.setBaseAndExtent(endPoint.node, endPoint.offset, startPoint.node, startPoint.offset);
  } else {
    selection.setBaseAndExtent(startPoint.node, startPoint.offset, endPoint.node, endPoint.offset);
  }
  editor.scrollTop = snapshot.scrollTop;
}

/** 重建正文 DOM 并保留当前选择/滚动；用于回执、引用插入、token 删除等**合法**正文同步。 */
function renderEditorBodyKeepingSelection(editor: HTMLElement, body: string, uploads: UploadItem[]): void {
  const snapshot = captureEditorSelection(editor);
  renderEditorBody(editor, body, uploads);
  if (snapshot != null) restoreEditorSelection(editor, snapshot);
}

/** 编辑区未聚焦时只保滚动位置——不把焦点/选择从用户当前位置抢回输入框。 */
function renderEditorBodyKeepingScroll(editor: HTMLElement, body: string, uploads: UploadItem[]): void {
  const scrollTop = editor.scrollTop;
  renderEditorBody(editor, body, uploads);
  editor.scrollTop = scrollTop;
}

function serializeEditorForClipboard(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.dataset.zsInlineToken === '1') return node.dataset.zsFileName ?? '';
  if (node instanceof HTMLBRElement) return '\n';
  let text = '';
  node.childNodes.forEach((child) => { text += serializeEditorForClipboard(child); });
  if (node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P') && text.length > 0 && !text.endsWith('\n')) text += '\n';
  return text;
}

function domPointAtOffset(editor: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);
  const walk = (node: Node): { node: Node; offset: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      return null;
    }
    if (node instanceof HTMLElement && node.dataset.zsInlineToken === '1') {
      const length = node.dataset.zsRawToken?.length ?? 0;
      if (remaining <= length) return { node: node.parentNode!, offset: Array.from(node.parentNode?.childNodes ?? []).indexOf(node) + (remaining === 0 ? 0 : 1) };
      remaining -= length;
      return null;
    }
    if (node instanceof HTMLBRElement) {
      if (remaining === 0) return { node: node.parentNode!, offset: Array.from(node.parentNode?.childNodes ?? []).indexOf(node) };
      remaining -= 1;
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const point = walk(child);
      if (point != null) return point;
    }
    return null;
  };
  return walk(editor) ?? { node: editor, offset: editor.childNodes.length };
}

function editorCaretOffset(editor: HTMLElement | null): number {
  if (editor == null) return 0;
  const selection = window.getSelection();
  if (selection == null || selection.rangeCount === 0) return serializeEditor(editor).length;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return serializeEditor(editor).length;
  const prefix = document.createRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  const holder = document.createElement('div');
  holder.appendChild(prefix.cloneContents());
  return serializeEditor(holder).length;
}

function setEditorCaret(editor: HTMLElement | null, offset?: number): void {
  if (editor == null) return;
  editor.focus();
  const point = domPointAtOffset(editor, offset ?? serializeEditor(editor).length);
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function editorInsertPlainText(editor: HTMLElement, text: string): void {
  const selection = window.getSelection();
  const range = selection != null && selection.rangeCount > 0 && editor.contains(selection.anchorNode)
    ? selection.getRangeAt(0)
    : null;
  if (range == null) {
    editor.appendChild(document.createTextNode(text));
    setEditorCaret(editor);
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createInlineTokenElement(token: InlineAttachmentToken, uploads: UploadItem[]): HTMLElement {
  const upload = token.uploadId != null ? uploads.find((item) => item.uploadId === token.uploadId) : undefined;
  const status = upload?.status === 'preparing'
    ? 'preparing'
    : token.kind === 'upload'
      ? 'uploading'
      : token.kind === 'failed' || upload?.status === 'failed'
        ? 'failed'
        : 'ready';
  const host = document.createElement('span');
  host.className = `composer-file-token is-${status}${token.fileKind === 'image_file' ? ' is-image' : ''}`;
  host.contentEditable = 'false';
  host.draggable = false;
  host.dataset.zsInlineToken = '1';
  host.dataset.zsRawToken = inlineAttachmentToken(token);
  host.dataset.zsFileName = token.name;
  if (token.attachmentId != null) host.dataset.zsAttachmentId = token.attachmentId;
  if (token.uploadId != null) host.dataset.zsUploadId = token.uploadId;
  if (token.fileKind != null) host.dataset.zsFileKind = token.fileKind;
  const detail = status === 'preparing' ? '准备中…' : status === 'uploading' ? '上传中…' : status === 'failed' ? '上传失败' : token.fileKind === 'image_file' ? '图片' : '文件';
  host.title = status === 'failed' ? `${token.name}：${userFacingSystemText(upload?.error ?? '上传失败')}` : status === 'preparing' ? `${token.name}：正在计算内容身份，完成前不会发送` : status === 'uploading' ? `${token.name}：上传中，可移除` : `${token.name} · ${detail}${token.revision != null ? ` · v${token.revision}` : ''}`;

  const icon = document.createElement('span');
  icon.className = 'composer-file-token-icon';
  icon.setAttribute('aria-hidden', 'true');
  host.appendChild(icon);

  if (status === 'ready' && token.attachmentId != null) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'composer-file-token-open';
    open.dataset.zsFileOpen = '1';
    open.textContent = token.name;
    open.title = '打开只读预览';
    host.appendChild(open);
  } else {
    const label = document.createElement('span');
    label.className = 'composer-file-token-open';
    label.textContent = token.name;
    host.appendChild(label);
  }
  const meta = document.createElement('span');
  meta.className = 'composer-file-token-state';
  meta.textContent = detail;
  host.appendChild(meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'composer-file-token-remove';
  remove.dataset.zsFileRemove = '1';
  remove.setAttribute('aria-label', `移除 ${token.name}`);
  remove.title = `移除 ${token.name}`;
  remove.textContent = '×';
  host.appendChild(remove);
  return host;
}

function renderEditorBody(editor: HTMLElement, body: string, uploads: UploadItem[]): void {
  const fragment = document.createDocumentFragment();
  for (const segment of parseInlineBody(body)) {
    if (segment.kind === 'text') {
      if (segment.text.length > 0) fragment.appendChild(document.createTextNode(segment.text));
    } else {
      fragment.appendChild(createInlineTokenElement(segment.token, uploads));
    }
  }
  editor.replaceChildren(fragment);
}

/**
 * 未知信封的**完整意图身份**比较（R66 P3）：文件-only 发送的 body 都为空——r62 的
 * 「正文逐字相等」判据会把两条不同文件的发送误判为同一草稿。身份=正文+意图+@提及+
 * 附件引用集合（排序后比较——同一身份换新号必重复；任一不同=新草稿，允许新号发送）。
 */
export function pendingIdentityMatches(
  env: PendingSendEnvelope,
  text: string,
  mentionIds: string[],
  sendAs: 'ai' | 'record',
  readyAttachmentIds: string[],
  collaboration?:'deliberate',
  budgetMaxTurns?: number,
  defaultBudgetMaxTurns?: number,
  analysisOnly = false,
): boolean {
  if(env.params.collaboration!==collaboration)return false;
  if ((env.params.analysisOnly === true) !== analysisOnly) return false;
  const envBudget = env.params.deliberationBudget?.maxTurns;
  const expectedBudget = budgetMaxTurns ?? defaultBudgetMaxTurns;
  if (collaboration === 'deliberate') {
    // Older UNKNOWN envelopes predate the budget field. Their frozen meaning
    // was the deterministic default for the same roster; an explicit new
    // budget is a different identity and must not reuse that ambiguity.
    if (envBudget == null && budgetMaxTurns != null) return false;
    if (envBudget != null && envBudget !== expectedBudget) return false;
  } else if (envBudget != null) {
    return false;
  }
  const p = env.params as {
    body?: string; intent?: string; mentions?: Array<{ kind: string; memberId?: string }>;
    attachmentRefs?: string[];
  };
  if ((p.body ?? '') !== text) return false;
  if ((p.intent === 'record_only' ? 'record' : 'ai') !== sendAs) return false;
  const envRefs = [...(p.attachmentRefs ?? [])].sort().join('|');
  const curRefs = [...readyAttachmentIds].sort().join('|');
  if (envRefs !== curRefs) return false;
  const envMentions = (p.mentions ?? []).map((m) => (m.kind === 'all' ? 'all' : m.memberId ?? '')).sort().join('|');
  const curMentions = [...mentionIds].sort().join('|');
  return envMentions === curMentions;
}

/** 未知信封摘要（文件-only：正文空→按附件数呈现，不显示空洞的「…」）。 */
function pendingEnvSummary(env: PendingSendEnvelope): string {
  const p = env.params as { body?: string; attachmentRefs?: string[] };
  const body = p.body ?? '';
  if (body.trim().length > 0) return body.slice(0, 60);
  const n = p.attachmentRefs?.length ?? 0;
  return n > 0 ? `仅文件发送（${n} 个附件）` : '（空内容）';
}

/** 正式侧发送回执（第四十七轮）：onSend 可返回 Promise——成功才清空，失败/未知保留草稿。 */
export type FormalSendOutcome =
  | { status: 'ok' }
  | { status: 'failed'; error: string }
  | { status: 'unknown'; error: string };

/** 正式侧能力锁定（第四十七轮）：未接通能力在点击前禁用并说明原因，不出现可选却被忽略。 */
export interface FormalLimits {
  attachments?: string;
  method?: string;
  access?: string;
}

export function Composer({
  target,
  draftKey,
  onSend,
  onClearSubtask,
  insertText,
  sendDisabledReason,
  sendDisabledLabel,
  inputDisabledReason,
  runBudget,
  stop,
  recordThread,
  showMentions = true,
  extraAction,
  formalLimits,
  onRetrySend,
  attachmentUpload,
}: {
  target: ComposerTarget;
  draftKey: string;
  onSend: (payload: {
    body: string;
    /** 普通聊天固定交给 AI；保留字段用于兼容页面既有信封 builder。 */
    sendAs: 'ai' | 'record';
    mentionIds: string[];
    method: { planFirst: boolean; skipFirstDraft: boolean; splitWork: boolean };
    access: AccessMode;
    attachments: HifiDraftAttachment[];
    /** 图片能力门显式选择（一次性）：'omit-images'=仅发送文字（图片不送模型并如实注明）。 */
    imageAck?: 'omit-images';
    collaboration?:'deliberate';
    /** 独立研讨本次调用预算；页面必须冻结进 message.submit，而不是只留在 UI。 */
    budgetMaxTurns?: number;
    /** 兼容既有页面信封 builder 的类型；普通输入不再设置此字段。 */
    analysisOnly?: boolean;
    commandId: string;
    target: ComposerTarget;
    /** 发起时草稿编辑代次（页面冻结进信封——清算判定用）。 */
    draftRev?: number;
  }) => void | Promise<FormalSendOutcome | void> | Promise<void>;
  onClearSubtask?: () => void;
  /** 从消息菜单插入引用或更正提示；只改变草稿，不直接派发任务。 */
  insertText?: { id: number; text: string };
  /** 允许保留草稿但暂时不能发送，例如房间还没有成员。 */
  sendDisabledReason?: string;
  /**
   * `sendDisabledReason` 上方那枚提示的文案（默认「只能存草稿」）。
   * 归档私信不能沿用这句：那里是"只读"，连草稿都发不出去，说成"只能存草稿"会误导。
   */
  sendDisabledLabel?: string;
  /**
   * 整个输入区不可写（私信归档态）：textarea 直接禁用、占位写明原因。
   *
   * 为什么不只用 `sendDisabledReason`：房间的"还没有成员"允许先写草稿，
   * 而归档是**只读**——房间里归档后整个输入条会被只读面板取代，
   * 私信保持同一口径（此前也是 disabled），不然"只读"会退化成"能写但发不出去"。
   */
  inputDisabledReason?: string;
  /**
   * 目标摘要（减负 §2.1/§6.2）—— **2026-09-24 第三轮已按用户要求停用**。
   *
   * 曾经作为"我在对哪个任务说话"的常驻一行；用户看过后要求整行去掉（房间名在正上方、
   * 线程身份在详情与 placeholder 里都有）。prop 与 `.composer-target-*` 样式保留但
   * **不再有任何调用方传入**，这样想恢复时只需重新传值，不必重写模板。
   */
  targetSummary?: {
    /** 主文案，例如「跟进 #12」或「发布到 开发大厅」 */
    label: string;
    /** 简短标题（可省略号截断，完整值放 title） */
    short?: string;
    /** 完整标题/摘要，用于 tooltip */
    full?: string;
    /** 点击摘要的去处（任务串 → 详情的任务概况） */
    onOpen?: () => void;
  };
  /**
   * 本次任务的运行预算（§6.1）：只用**既有** run.budget 数据做提示，
   * 不复制 6N+1/7N+2 公式，避免界面出现两套预算值。
   */
  runBudget?: { used: number; max: number };
  /**
   * 停止任务（减负 §2.3）。
   *
   * 停止以前只在「任务详情」里，现在补一个**详情之外可发现**的入口：
   * 位置在输入区操作区，复用既有 stopTask 与状态判定。
   * 是否出现不由输入框 disabled 推断，而由任务真实状态决定；
   * 关闭/返回永远不会触发它。
   */
  stop?: {
    onStop: () => void;
    /** 真实状态：已发出停止、等活跃 turn 结束时显示"停止中"并防重复点击 */
    stopping: boolean;
  };
  /** 兼容旧调用方；R90 起忽略此值，历史记录串续聊同样交给 AI。 */
  recordThread?: boolean;
  /**
   * 是否显示 @ 提及（默认显示）。
   * 私信关掉：1 对 1 会话里只有一位成员，@ 没有可选项（成员边界仍由该会话决定）。
   */
  showMentions?: boolean;
  /**
   * 操作簇里的额外动作（私信归档态的「取消归档」）。
   * 放在输入区操作簇内，避免像以前那样在提示"取消归档后才能发送"却找不到入口。
   */
  extraAction?: ReactNode;
  /** 正式侧能力锁定：给出原因的控件在点击前禁用（视觉保持，行为如实）。 */
  formalLimits?: FormalLimits;
  /** 结果未知信封的重发通道（review-r47 §2）：严格重发冻结原信封——由页面接正式命令。 */
  onRetrySend?: (env: PendingSendEnvelope) => Promise<FormalSendOutcome | void>;
  /**
   * 正式附件上传通道（第五十一轮 H2）：页面提供 {conversationId} 时 📎 走真实文件选择
   * + attachment.upload*（回执绑定该会话）；未提供时维持 formalLimits 禁用——不 mock。
   */
  attachmentUpload?: { conversationId: string };
}) {
  void recordThread; // 兼容旧页面传参；R90 起不再改变发送意图。
  /**
   * 成员边界（§4.6）：房间/线程取房间名单，私信取该会话的 audience 名单。
   * @ 候选、方式推导、冻结名单都以它为唯一来源。
   */
  const dm = useStore((s) => (target.kind === 'dm' && target.dmId ? s.dms.find((d) => d.id === target.dmId) : undefined));
  const room = useStore((s) => (target.kind === 'dm' ? undefined : roomOf(s, target.roomId)));
  const threadMembers=useStore(s=>target.kind==='thread'&&target.threadId?s.threadMemberships[target.threadId]:undefined);
  const memberIds = useMemo(
    () => (target.kind === 'dm' ? (dm?.memberIds ?? []) : target.kind==='thread'?(threadMembers?.eligibleMemberIds??[]):(room?.memberIds ?? [])),
    [target.kind, dm, room,threadMembers],
  );
  const allMembers = useStore((s) => s.members);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const memberRuntimes = useStore((s) => s.memberRuntimes);
  const profiles = useStore((s) => s.profiles);
  const runtimes = useStore((s) => s.runtimeInstallations);

  const members = useMemo(
    () => (memberIds.map((id) => allMembers.find((m) => m.id === id)).filter(Boolean) as ProjectMember[]),
    [memberIds, allMembers],
  );

  /** 成员 → runtime 显示名（成员设置里可改；这里用于 @ 候选） */
  const runtimeLabelOf = useMemo(() => {
    const byId = new Map(runtimes.map((r) => [r.id, r.label]));
    const profById = new Map(profiles.map((p) => [p.id, p]));
    return (m: ProjectMember) => {
      const actual=memberRuntimes[m.id];
      if(actual?.status==='bound')return actual.kind==='fake'?'测试环境':`${actual.kind} · ${actual.model??'渠道默认模型'}`;
      if(actual?.status==='unbound')return '全局默认渠道';
      const prof = profById.get(m.profileId);
      const label=prof ? byId.get(prof.runtimeInstallationId) : undefined;
      return label==='fake'?'测试环境':label ?? '未配置';
    };
  }, [runtimes, profiles,memberRuntimes]);

  const mentionTokenById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) counts.set(member.displayName, (counts.get(member.displayName) ?? 0) + 1);
    return new Map(members.map((member) => {
      const duplicate = (counts.get(member.displayName) ?? 0) > 1;
      const qualifier = runtimeLabelOf(member).replace(/\s+/g, '');
      const token = member.displayName + (duplicate ? `（${qualifier}）` : '');
      return [member.id, token] as const;
    }));
  }, [members, runtimeLabelOf]);

  const mentionIdByToken = useMemo(
    () => new Map([...mentionTokenById].map(([id, token]) => [token, id] as const)),
    [mentionTokenById],
  );

  const resolveMentionsFromBody = useCallback((text: string): string[] => {
    return resolveMentionIds(text, mentionIdByToken);
  }, [mentionIdByToken]);

  const bodyRef = useRef('');
  const [body, setBody] = useState('');
  bodyRef.current = body;
  /**
   * 普通聊天只有一种发送语义：交给 AI。历史 record 消息仍按原数据展示/留账；
   * 在历史记录串里继续聊天也会自然发起新的 AI 请求，不再静默 record_only。
   */
  // 旧草稿的 analysisOnly 不再参与新发送；历史权限仅由原任务/冻结信封保留。
  const sendAs = 'ai' as const;
  const [deliberate,setDeliberate]=useState(false);
  const [deliberateMemberIds,setDeliberateMemberIds]=useState<string[]>([]);
  const [budgetMaxTurns,setBudgetMaxTurns]=useState<number | null>(null);
  const [callBudgetEnabled,setCallBudgetEnabled]=useState<boolean | null>(null);
  const [callBudgetReadError,setCallBudgetReadError]=useState<string | null>(null);
  const [budgetInput,setBudgetInput]=useState('');
  const [modeMenuAnchor,setModeMenuAnchor]=useState<{x:number;y:number}|null>(null);
  const [budgetMenuAnchor,setBudgetMenuAnchor]=useState<{x:number;y:number}|null>(null);
  const [dragActive,setDragActive]=useState(false);
  useEffect(() => {
    let alive = true;
    setCallBudgetReadError(null);
    void command<{ values: Record<string, string | null> }>('app.settings.get', {
      keys: [CALL_BUDGET_ENABLED_SETTING_KEY],
    }).then((result) => {
      if (!alive) return;
      const enabled = parseCallBudgetEnabledSetting(result.values[CALL_BUDGET_ENABLED_SETTING_KEY]);
      setCallBudgetEnabled(enabled);
      if (!enabled) setBudgetMaxTurns(null);
    }).catch((error: unknown) => {
      if (!alive) return;
      setCallBudgetEnabled(null);
      setCallBudgetReadError(error instanceof Error ? error.message : String(error));
    });
    return () => { alive = false; };
  }, []);
  const collaboration=target.kind!=='dm'&&deliberate?'deliberate' as const:undefined;
  const [mentions, setMentions] = useState<string[]>([]);
  const availableDeliberateIds = useMemo(
    () => members.filter((member) => member.enabled && member.principalType === 'agent').map((member) => member.id),
    [members],
  );
  const effectiveMentionIds = useMemo(() => {
    if (!deliberate) return mentions;
    const selected = deliberateMemberIds.filter((id) => availableDeliberateIds.includes(id));
    const bodyMentions = mentions.filter((id) => id === 'all' || availableDeliberateIds.includes(id));
    return [...new Set([...selected, ...bodyMentions])];
  }, [deliberate, mentions, deliberateMemberIds, availableDeliberateIds]);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDocs, setMentionDocs] = useState<MentionDocument[]>([]);
  const [mentionDocsLoading, setMentionDocsLoading] = useState(false);
  const [mentionDocsError, setMentionDocsError] = useState<string | null>(null);
  const [documentBusy, setDocumentBusy] = useState<string | null>(null);
  useEffect(() => {
    setDocumentBusy(null);
    setMentionDocsError(null);
  }, [draftKey, activeProjectId]);
  const [skipFirstDraft, setSkipFirstDraft] = useState(false);
  const [splitWork, setSplitWork] = useState(false);
  const [access, setAccess] = useState<AccessMode>('plan');
  const [accessOpen, setAccessOpen] = useState(false);
  // 附件真源=store.uploadItems（review-r51 §2 反例修复）：每笔上传绑定发起草稿键+独立
  // uploadId——迟到回执按 (draftKey, uploadId) 精确收敛；切走/卸载/同名文件/上传中移除都
  // 不串到其它草稿、不复活已移除项；A→B→A 回来芯片由 store 恢复。本地不再持有附件状态。
  const uploadItemsRaw = useStore((st) => st.uploadItems[draftKey] ?? EMPTY_UPLOADS);
  const attachments = useMemo(() => uploadItemsRaw.filter((x) => x.removed !== true), [uploadItemsRaw]);
  /** 就绪附件数（R66 P3 文件-only 发送判据：只有 ready 状态才是可发送附件——上传中/失败不算）。 */
  const readyAttachmentCount = useMemo(() => attachments.filter((x) => x.status === 'ready').length, [attachments]);
  const pendingAttachmentCount = useMemo(() => attachments.filter((x) => x.status === 'preparing' || x.status === 'uploading').length, [attachments]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 图片能力门待选（第五十二轮：显式二选一，不再硬拦——发送暂停在选择上）。 */
  const [imageGate, setImageGate] = useState<{ names: string[]; reason?: string } | null>(null);

  /**
   * 附件按类型上传，内容校验由服务端裁决。成功回执经
   * settleUploadReady **原子结算**（r53 §3）：store 同时核 uploadId 存在/未移除/发起会话一致，
   * 通过才置 ready 并写草稿 ref——上传中被移除的回执整体丢弃，组件不再自行写草稿（那正是
   * 「芯片消失但草稿仍带已移除资源」的根因）。
   */
  const uploadPickedFiles = async (files: File[]): Promise<void> => {
    if (attachmentUpload == null) return;
    const startDraftKey = draftKey;
    const startProjectId = activeProjectId;
    const startConversationId = attachmentUpload.conversationId;
    type PlannedUpload = { file: File; uploadId: string; cls: UploadClassification; error?: string };
    const planned: PlannedUpload[] = files.map((file) => {
      const cls = classifyAttachmentFile(file.name, file.size);
      return {
        file,
        uploadId: `upl_${Math.random().toString(36).slice(2, 10)}`,
        cls,
        ...(cls.cls === 'unsupported' ? { error: `${userFacingSystemText(cls.reason ?? '不支持的附件类型')}（${file.name} · ${file.size}B）——可换支持类型重选` } : {}),
      };
    });
    if (planned.length === 0) return;

    for (const item of planned) {
      addUploadItem({
        uploadId: item.uploadId,
        draftKey: startDraftKey,
        conversationId: startConversationId,
        name: item.file.name,
        size: item.file.size,
        sourceLastModified: item.file.lastModified,
        sourceType: item.file.type,
        status: item.error == null ? 'preparing' : 'failed',
        ...(item.error != null ? { error: item.error } : {}),
      });
    }

    const insertionAt = draftKeyRef.current === startDraftKey ? editorCaretOffset(editorRef.current) : getDraftFull(startDraftKey).body.length;
    const base = getDraftFull(startDraftKey);
    const bodyNow = draftKeyRef.current === startDraftKey ? bodyRef.current : base.body;
    const tokens = planned.map((item) => inlineAttachmentToken({
      kind: item.error == null ? 'upload' : 'failed',
      uploadId: item.uploadId,
      name: item.file.name,
      fileKind: item.cls.cls === 'image' ? 'image_file' : undefined,
    }));
    const before = bodyNow.slice(0, Math.min(insertionAt, bodyNow.length));
    const after = bodyNow.slice(Math.min(insertionAt, bodyNow.length));
    const joiner = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const tailJoiner = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const nextBody = `${before}${joiner}${tokens.join(' ')}${tailJoiner}${after}`;
    setDraftFull(startDraftKey, { ...base, body: nextBody });
    if (draftKeyRef.current === startDraftKey) {
      setBody(nextBody);
      const editor = editorRef.current;
      if (editor != null) {
        renderEditorBody(editor, nextBody, getState().uploadItems[startDraftKey] ?? []);
        setEditorCaret(editor, before.length + joiner.length + tokens.join(' ').length);
      }
    }

    for (const item of planned) {
      if (item.error != null) continue;
      const current = () => (getState().uploadItems[startDraftKey] ?? []).find((upload) => upload.uploadId === item.uploadId);
      const beforeHash = current();
      if (beforeHash == null || beforeHash.removed === true) continue;
      const contentHash = await uploadFileContentHash(item.file);
      const afterHash = current();
      if (afterHash == null || afterHash.removed === true) continue;
      const identity = contentHash == null ? null : `${item.file.name}\u0000${item.file.size}\u0000${contentHash}`;
      const duplicate = identity != null && (getState().uploadItems[startDraftKey] ?? []).some((upload) => upload.uploadId !== item.uploadId && uploadContentIdentity(upload) === identity);
      if (duplicate) {
        removeUploadItem(startDraftKey, item.uploadId);
        syncDraftBodyToEditor(startDraftKey);
        continue;
      }
      settleUpload(startDraftKey, item.uploadId, { status: 'uploading', ...(contentHash != null ? { contentHash } : {}) });
      syncDraftBodyToEditor(startDraftKey);
      const uploading = current();
      if (uploading == null || uploading.removed === true) continue;
      try {
        const r = await uploadAttachmentFile(startConversationId, item.file);
        if (draftKeyRef.current !== startDraftKey || getState().activeProjectId !== startProjectId) {
          // 迟到回执仍按发起草稿键结算；页面切换只影响当前 DOM，不把附件写进新目标。
        }
        const accepted = settleUploadReady(startDraftKey, item.uploadId, startConversationId, {
          name: item.file.name, size: item.file.size, attachmentId: r.attachmentId,
          hash: r.hash, revision: r.revision, kind: r.kind,
        });
        void accepted; // 被丢弃=用户已在上传中移除——不写任何草稿 ref，芯片保持消失
        syncDraftBodyToEditor(startDraftKey);
        // R69 P1-D：已保存但提取不可用（分列状态）——芯片就地警示，不算上传失败。
        if (r.previewWarning != null) settleUpload(startDraftKey, item.uploadId, { warning: r.previewWarning });
        if (r.extractionFailed != null) settleUpload(startDraftKey, item.uploadId, { warning: r.extractionFailed });
      } catch (e) {
        // R69 P1-C：失败原因就地可见（文件/阶段/可行操作），不再只藏 title。
        settleUpload(startDraftKey, item.uploadId, { status: 'failed', error: `${item.file.name}（${item.file.size}B）：${userFacingSystemText((e as Error).message ?? '')}` });
        syncDraftBodyToEditor(startDraftKey);
      }
    }
  };
  /** 移除上传项：在途→标记（回执到达即弃，不复活）；已就绪→连同草稿引用一并移除（不再随发送携带）。 */
  const removeAttachment = (uploadId: string): void => {
    removeUploadItem(draftKey, uploadId);
    syncDraftBodyToEditor(draftKey);
  };
  /** 上传回执/结构化引用可能更新 store 正文；仅同步其发起草稿，不污染当前其它目标。 */
  const syncDraftBodyToEditor = (key: string): void => {
    if (draftKeyRef.current !== key) return;
    if (composingRef.current) {
      // IME 组合期间禁止重建子树（会打断组合、丢候选、把光标弹回开头）：先记账，
      // compositionend 后再用 DOM 文本 + 草稿里较新的 token 一次性收敛。
      pendingCompositionSyncRef.current = key;
      return;
    }
    const stored = getDraftFull(key).body;
    if (stored === bodyRef.current) return;
    setBody(stored);
    const editor = editorRef.current;
    if (editor == null) return;
    const uploads = getState().uploadItems[key] ?? [];
    if (document.activeElement === editor) renderEditorBodyKeepingSelection(editor, stored, uploads);
    else renderEditorBodyKeepingScroll(editor, stored, uploads);
  };
  /**
   * 组合结束后的回执收敛：DOM 文本是用户最终输入（含组合串），草稿 token 是最新附件身份。
   * 合并后写回草稿并重建一次（此时组合已结束）——不丢字、不丢已结算/新增附件、不复活已移除
   * 附件，selection 按结构映射保持。
   */
  const flushCompositionSync = (key: string): void => {
    pendingCompositionSyncRef.current = null;
    if (composingRef.current || draftKeyRef.current !== key) return;
    const editor = editorRef.current;
    if (editor == null) return;
    const merged = mergeCompositionEditorBody(serializeEditor(editor), getDraftFull(key).body);
    setBody(merged);
    setMentions(resolveMentionsFromBody(merged));
    setDraftFull(key, { ...getDraftFull(key), body: merged });
    const uploads = getState().uploadItems[key] ?? [];
    if (document.activeElement === editor) renderEditorBodyKeepingSelection(editor, merged, uploads);
    else renderEditorBodyKeepingScroll(editor, merged, uploads);
    detectMentionTrigger(editor);
  };
  /** 行内发送错误（按发起目标键归属——迟到回执不污染当前目标，review-r47 §3）。 */
  const [sendErrorFor, setSendErrorState] = useState<{ key: string; text: string; commandId?:string } | null>(null);
  const sendError = sendErrorFor != null && sendErrorFor.key === draftKey ? sendErrorFor.text : null;
  const setSendErrorFor = (key: string, text: string, commandId?:string) => setSendErrorState({
    key,
    commandId,
    text: text.replace(/(?:^|[\s：])([A-Z][A-Z0-9_]{3,})\s*[:：]\s*/g, ' ').replace(/\s+/g, ' ').trim(),
  });
  /** 当前挂载目标键（结算时核对——迟到回执只在同键在挂时同步当前输入）。 */
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const imageProjectId = useStore((s) => s.activeProjectId);
  const [imageStatus, setImageStatus] = useState<{ key: string; text: string } | null>(null);
  const imageContext = JSON.stringify({ projectId: imageProjectId, target, conversationId: attachmentUpload?.conversationId,
    mentions: effectiveMentionIds, collaboration, images: attachments.filter(a => a.status === 'ready' && a.kind === 'image_file').map(a => a.attachmentId) });
  const threadFactRevision=useStore(s=>target.kind==='thread'&&target.threadId?s.threadTasks[target.threadId]?.revision:null);
  const writeContext=JSON.stringify({projectId:imageProjectId,target,conversationId:attachmentUpload?.conversationId,mentions:effectiveMentionIds,collaboration,threadFactRevision});
  const [writeHint,setWriteHint]=useState<{key:string;authorized:boolean;fullAccess?:boolean;willDispatch?:boolean;blocked?:boolean;reason:string;readAt:number;error?:string}|null>(null);
  useEffect(()=>{
    if(!formalLimits?.access||sendAs!=='ai')return;
    if (sendDisabledReason != null || inputDisabledReason != null) {
      setWriteHint(null);
      return;
    }
    let cancelled=false,reading=false;
    const read=async()=>{
      if(cancelled||reading||document.visibilityState!=='visible')return;reading=true;
      const conversationId=attachmentUpload?.conversationId??target.dmId??'';
      const formalTarget=target.kind==='room_root'?{kind:target.kind,projectId:imageProjectId,conversationId,roomId:target.roomId}:target.kind==='thread'?{kind:target.kind,projectId:imageProjectId,conversationId,threadId:target.threadId}:{kind:target.kind,projectId:imageProjectId,conversationId};
      try{const c=await command<{modificationAuthorized:boolean;fullAccess?:boolean;willDispatch:boolean;blocked?:boolean;reason:string}>('message.writeCapability',{target:formalTarget,...(collaboration?{collaboration}:{}),mentions:effectiveMentionIds.map(id=>id==='all'?{kind:'all'}:{kind:'member',memberId:id})});if(!cancelled&&draftKeyRef.current===draftKey)setWriteHint({key:writeContext,authorized:c.modificationAuthorized,fullAccess:c.fullAccess,willDispatch:c.willDispatch,blocked:c.blocked,reason:c.reason,readAt:Date.now()});}
      catch(e){if(!cancelled&&draftKeyRef.current===draftKey)setWriteHint(old=>old?.key===writeContext?{...old,error:(e as Error).message}:{key:writeContext,authorized:false,reason:'尚未确认执行权限',readAt:0,error:(e as Error).message});}
      finally{reading=false;}
    };
    void read();const timer=window.setInterval(()=>void read(),5000),visible=()=>void read();document.addEventListener('visibilitychange',visible);
    return()=>{cancelled=true;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[writeContext,draftKey,sendAs,formalLimits?.access,sendDisabledReason,inputDisabledReason]);
  useEffect(() => {
    if (!attachments.some(a => a.status === 'ready' && a.kind === 'image_file')) return;
    let cancelled = false; let reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      const conversationId = attachmentUpload?.conversationId ?? target.dmId ?? '';
      const formalTarget = target.kind === 'room_root' ? { kind: target.kind, projectId: imageProjectId, conversationId, roomId: target.roomId }
        : target.kind === 'thread' ? { kind: target.kind, projectId: imageProjectId, conversationId, threadId: target.threadId }
        : { kind: target.kind, projectId: imageProjectId, conversationId };
      try {
        const c = await command<{ willDispatch: boolean; members: Array<{kind:string;model:string;channel:string;configuration:string;protocol:string;status:string;reason:string}> }>('message.imageCapability', { target: formalTarget, ...(collaboration?{collaboration}:{}), mentions: effectiveMentionIds.map(id => id === 'all' ? {kind:'all'} : {kind:'member',memberId:id}) });
        if (!cancelled && draftKeyRef.current === draftKey) setImageStatus({key:imageContext,text:c.willDispatch ? c.members.length&&c.members.every(m=>m.status==='supported')?'图片会随消息发送给所选 AI。':'部分 AI 暂不能接收图片，可换成员或移除图片。' : '图片会保存到本机，可点击预览。'});
      } catch (e) { if (!cancelled) setImageStatus({key:imageContext,text:`图片能力读取失败：${userFacingSystemText((e as Error).message ?? '')}；仍可本地预览，发送前可重试`}); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
    // imageContext includes the complete read scope; avoid unstable parent target objects.
  }, [imageContext, draftKey]);
  /** 本目标的结果未知信封（store 持有——切走/卸载不丢）。 */
  const pendingEnv = useStore((st) => st.pendingSends[draftKey]);
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  useEffect(() => {
    if (!mentionOpen) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMentionTrigger(null);
      setMentionOpen(false);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [mentionOpen]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    setMentionDocsLoading(true);
    setMentionDocsError(null);
    void (async () => {
      const loaded: MentionDocument[] = [];
      try {
        if (activeProjectId) {
          const files = await command<{ entries: Array<{ name: string; kind: 'dir' | 'file'; sizeBytes: number | null }> }>('project.files.list', { projectId: activeProjectId, path: '' });
          for (const entry of files.entries) {
            if (entry.kind !== 'file') continue;
            loaded.push({ key: `workspace:${entry.name}`, kind: 'workspace', name: entry.name, path: entry.name, sizeBytes: entry.sizeBytes });
          }
        }
        if (attachmentUpload != null) {
          const uploaded = await command<{ items: Array<{ attachmentId: string; filename: string; kind: string; hash: string; revision: number }> }>('attachment.listByConversation', { conversationId: attachmentUpload.conversationId });
          for (const item of uploaded.items) {
            loaded.push({ key: `uploaded:${item.attachmentId}`, kind: 'uploaded', name: item.filename, attachmentId: item.attachmentId, fileKind: item.kind, hash: item.hash, revision: item.revision });
          }
        }
        if (!cancelled) setMentionDocs(loaded);
      } catch (error) {
        if (!cancelled) {
          setMentionDocs([]);
          setMentionDocsError(`文档候选读取失败：${userFacingSystemText((error as Error).message ?? '')}`);
        }
      } finally {
        if (!cancelled) setMentionDocsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mentionOpen, activeProjectId, attachmentUpload?.conversationId]);

  useEffect(() => {
    setMentionActive(0);
  }, [mentionQuery, mentionOpen]);
  /**
   * @ 触发位置（r55 T2 完整修复）：记录**本次打开候选框的那个 @ 的下标**。选中成员后只
   * 消费这一处触发字符——中文紧邻（「整理任务要点@」）、行首/空白、光标处触发全部覆盖；
   * 不再对正文做全局正则替换（旧实现只匹配行首/空白后的末尾 @，中文紧邻反例即由此残留）。
   * 工具栏 @ 按钮打开=无触发字符（null，选人不动正文）；取消/切草稿/草稿被引用插入等
   * 外部变更都会清掉——正文里其它合法 @/邮箱文本永不被触碰。draftKey 一起记录：迟到
   * 的选择不跨草稿消费。
   */
  const [mentionTrigger, setMentionTrigger] = useState<{ index: number; end: number; draftKey: string } | null>(null);
  /** 「本次运行设置」弹层（低频选项的收纳处，§6） */
  const [runSettingsAnchor, setRunSettingsAnchor] = useState<{ x: number; y: number } | null>(null);
  /**
   * 草稿保存失败必须可见（§6.2；r61 P5 改接持久化状态位）。
   * 普通保存成功**不作常驻提示**：原来那枚"草稿已保存"的勾一直占位，
   * 而它几乎永远为真，属于无信息的常驻状态。持久化失败/身份不可用时如实提示
   * 「未持久化」及其后果（刷新/崩溃会丢），不静默。
   */
  const draftPersist = useStore((st) => st.draftPersist);
  // commandId 在"发送中"保持不变：重复点击不会创建多个任务（RT-01）
  const commandIdRef = useRef<string>(newId());
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  /** IME 组合期间收到的回执同步：组合结束（compositionend）后一次性收敛（R91）。 */
  const pendingCompositionSyncRef = useRef<string | null>(null);
  const appliedInsertRef = useRef<number | null>(null);
  /** 刚载入过草稿的 key：让紧接着的一次保存 effect 跳过，避免把草稿清空 */
  const skipSaveRef = useRef<string | null>(null);

  // 载入该目标的草稿；主池与线程草稿分别保存、互不转移（§17.4、TH-04）。
  //
  // 评审指出：只恢复正文、清空 @ 与附件，会**改变发送意图** ——
  // 你原本点名了某人，回来文字还在、接收对象却没了。所以结构化选择一并保存。
  //
  // 两个必须处理的时序问题（都是实测踩出来的）：
  //  1) 初次挂载时 useRef(draftKey) 已经等于 draftKey，若用 `!== draftKey` 做守卫，
  //     载入分支永远不会执行 —— 直接打开某个线程时草稿读不出来。
  //  2) setBody 是异步的：载入后本次渲染里 body 仍是旧值 ''，紧接着保存 effect 会把
  //     空串写回存储，把草稿清掉。因此载入后要让"下一个保存 effect"跳过一轮。
  //
  // R91 根因修复：恢复**只能由 draftKey 真正切换触发**。此前依赖
  // `mentionTokenById / allMembers / resolveMentionsFromBody / availableDeliberateIds`
  // ——成员、runtime 绑定、线程名单/进度每 5s 轮询都会换引用，effect 随之重跑：
  // renderEditorBody → replaceChildren 重建编辑区，光标弹回正文开头、非折叠选区丢失、
  // 输入框滚动复位、@ 候选被 setMentionOpen(false) 清掉、中文 IME 组合被 DOM 重建打断。
  // 恢复时仍需要**当次最新名单**解析 @token（不能留旧闭包），因此这些值走 latest-ref；
  // 轮询只让 @ 候选/资格等派生数据随名单更新，不再重载正文。
  const targetKindRef = useRef(target.kind);
  targetKindRef.current = target.kind;
  const attachmentUploadRef = useRef(attachmentUpload);
  attachmentUploadRef.current = attachmentUpload;
  const mentionTokenByIdRef = useRef(mentionTokenById);
  mentionTokenByIdRef.current = mentionTokenById;
  const allMembersRef = useRef(allMembers);
  allMembersRef.current = allMembers;
  const resolveMentionsFromBodyRef = useRef(resolveMentionsFromBody);
  resolveMentionsFromBodyRef.current = resolveMentionsFromBody;
  const availableDeliberateIdsRef = useRef(availableDeliberateIds);
  availableDeliberateIdsRef.current = availableDeliberateIds;

  useEffect(() => {
    const saved = getDraftFull(draftKey);
    const uploadChannel = attachmentUploadRef.current;
    if (uploadChannel != null) hydrateUploadRefs(draftKey, uploadChannel.conversationId, saved.attachments);
    const resolveMentions = resolveMentionsFromBodyRef.current;
    const tokenById = mentionTokenByIdRef.current;
    const membersAll = allMembersRef.current;
    const availableIds = availableDeliberateIdsRef.current;
    // 旧草稿只有 attachment refs、没有行内 token：hydrate 会补齐 token，这里以补齐后的正文为准。
    let restoredBody = getDraftFull(draftKey).body;
    const existingTokens = resolveMentions(restoredBody);
    const missingTokens = saved.mentions.filter((id) => id !== 'all' && !existingTokens.includes(id));
    if (saved.mentions.includes('all') && !existingTokens.includes('all') && !restoredBody.includes('@全体')) missingTokens.unshift('all');
    if (missingTokens.length > 0) {
      const prefix = missingTokens.map((id) => id === 'all' ? '@全体' : `@${tokenById.get(id) ?? memberLabel(membersAll.find((m) => m.id === id))}`).join(' ');
      restoredBody = `${prefix} ${restoredBody}`.trimStart();
    }
    setBody(restoredBody);
    const editor = editorRef.current;
    const editorWasFocused = editor != null && document.activeElement === editor;
    if (editor != null) {
      renderEditorBody(editor, restoredBody, getState().uploadItems[draftKey] ?? []);
      // 真正切串时把光标放到该草稿末尾（旧实现重建后选择塌到开头）；未聚焦则不抢焦点。
      if (editorWasFocused) setEditorCaret(editor);
    }
    setMentions(resolveMentions(restoredBody));
    const restoredDeliberate = saved.collaboration === 'deliberate' && targetKindRef.current === 'room_root';
    setDeliberate(restoredDeliberate);
    setDeliberateMemberIds(
      restoredDeliberate
        ? (saved.deliberateMemberIds ?? availableIds).filter((id) => availableIds.includes(id))
        : availableIds,
    );
    const restoredBudget = saved.budgetMaxTurns != null && Number.isInteger(saved.budgetMaxTurns) && saved.budgetMaxTurns >= 1
      ? saved.budgetMaxTurns : null;
    setBudgetMaxTurns(restoredBudget);
    setBudgetInput(restoredBudget == null ? '' : String(restoredBudget));
    setAccess(saved.access as AccessMode);
    setMentionOpen(false);
    setMentionTrigger(null); // 切草稿即取消：旧触发位置对新草稿无意义
    setAccessOpen(false);
    commandIdRef.current = newId();
    skipSaveRef.current = draftKey;
    // 切串会换掉编辑区内容：上一目标的组合/待收敛回执在这里作废（不能带进新草稿）。
    composingRef.current = false;
    pendingCompositionSyncRef.current = null;
    // r61 G7：目标未挂载期间排队的摘录/正文插入在此消费（一次性取走——旧队列不在后续
    // 新点击时批量灌入；每条插入恰好一次落正文）。
    applyDraftInserts(takeDraftInserts(draftKey));
    // 依赖只有 draftKey：名单/进度轮询换引用不得重放本恢复（R91 根因修复）。
  }, [draftKey]);

  /**
   * 会话通道迟到就绪（线程 conversationId 异步装载 / 私信会话出现）时，只补草稿引用与
   * 缺失的行内 token，再同步编辑区；不重放整份草稿恢复——selection/滚动/@候选都保持。
   * 同步统一走 syncDraftBodyToEditor：IME 组合期间同样只记账（compositionend 后收敛）。
   */
  useEffect(() => {
    const conversationId = attachmentUpload?.conversationId;
    if (conversationId == null) return;
    hydrateUploadRefs(draftKey, conversationId, getDraftFull(draftKey).attachments);
    if (draftKeyRef.current !== draftKey) return;
    const editor = editorRef.current;
    // DOM 与草稿已经一致（hydration 没有新增 token）时不重排。
    if (editor != null && !composingRef.current && serializeEditor(editor) === getDraftFull(draftKey).body) return;
    syncDraftBodyToEditor(draftKey);
    // eslint 不使用 react-hooks 插件；此处以 syncDraftBodyToEditor 的 IME 守卫为准。
  }, [draftKey, attachmentUpload?.conversationId]);

  useEffect(() => {
    const derived = resolveMentionsFromBody(body);
    setMentions((current) => current.length === derived.length && current.every((id, index) => id === derived[index]) ? current : derived);
  }, [body, resolveMentionsFromBody]);

  // 正文与结构化选择变化即写入草稿（草稿不是命令，commandId 保持不变）；持久化状态由
  // store.draftPersist 统一呈现（内存写不失败——失败的是 localStorage 快照，见 persistence 注释）。
  useEffect(() => {
    if (skipSaveRef.current === draftKey) {
      skipSaveRef.current = null;
      return;
    }
    // R91：组合输入期间（以及组合刚结束、回执合并尚未收敛的窗口）不落库。此时 onInput 的
    // DOM 快照可能落后于 store（上传回执/引用 hydrate 已在组合中途结算）——照写会覆盖掉刚
    // 新增/结算的 token。组合结束由 onCompositionEnd 的 onInput 或 flushCompositionSync
    // 一次性收敛。
    if (composingRef.current || pendingCompositionSyncRef.current != null) return;
    // 附件引用由上传/移除动作维护（防串写），这里只落正文/提及/意图/权限——读取现草稿合并。
    const cur = getDraftFull(draftKey);
    // r61：内容未变不重写——重挂载（切页签回来/崩溃恢复重载）会先 setBody(草稿值)再触发本
    // 效应；若照写一遍会把编辑代次无谓 +1，未知信封重试清算的「代次未变才剥离已发正文」
    // 判定随即失效（发送成功后正文残留）。同内容跳写=代次只在真实编辑时递增。
    const same = cur.body === body
      && cur.mentions.length === mentions.length
      && cur.mentions.every((m, i) => m === mentions[i])
      && cur.access === access
      && cur.sendAs === sendAs
      && cur.collaboration === collaboration
      && cur.budgetMaxTurns === (budgetMaxTurns ?? undefined)
      && (cur.deliberateMemberIds ?? []).length === deliberateMemberIds.length
      && (cur.deliberateMemberIds ?? []).every((id, index) => id === deliberateMemberIds[index]);
    if (same) return;
    setDraftFull(draftKey, {
      ...cur, body, mentions, access, sendAs, collaboration,
      ...(budgetMaxTurns != null ? { budgetMaxTurns } : { budgetMaxTurns: undefined }),
      deliberateMemberIds,
    });
  }, [draftKey, body, mentions, access, sendAs, collaboration, budgetMaxTurns, deliberateMemberIds]);

  useEffect(() => {
    if (!insertText || appliedInsertRef.current === insertText.id) return;
    appliedInsertRef.current = insertText.id;
    setMentionOpen(false); // 正文被外部插入——打开中的候选框触发位置已失效
    setMentionTrigger(null);
    const current = bodyRef.current;
    const next = current.trim() ? `${current}\n\n${insertText.text}` : insertText.text;
    setBody(next);
    const editor = editorRef.current;
    if (editor != null) {
      renderEditorBody(editor, next, uploadItemsRaw);
      setEditorCaret(editor);
    }
  }, [insertText]);

  /** 正文插入应用（r61 G7：摘录等文本块——一次一条，正文保持用户文字，新插入追加不覆盖）。 */
  const applyDraftInserts = (items: Array<{ id: number; text: string }>): void => {
    if (items.length === 0) return;
    setMentionOpen(false);
    setMentionTrigger(null);
    const next = items.reduce((acc, it) => (acc.trim() ? `${acc}\n\n${it.text}` : it.text), bodyRef.current);
    setBody(next);
    const editor = editorRef.current;
    if (editor != null) {
      renderEditorBody(editor, next, getState().uploadItems[draftKey] ?? []);
      setEditorCaret(editor);
    }
  };

  /**
   * zs:focus-composer（r56 起；r61 G7 修订）：预览「摘录」/「引用文件」后由 PreviewPane
   * 派发——这里消费该目标的待插入文本并聚焦输入框（文件引用卡本身由 store 驱动，无需消费）。
   */
  useEffect(() => {
    const onFocusComposer = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== draftKey) return;
      applyDraftInserts(takeDraftInserts(draftKey));
      syncDraftBodyToEditor(draftKey);
      editorRef.current?.focus();
    };
    window.addEventListener('zs:focus-composer', onFocusComposer);
    return () => window.removeEventListener('zs:focus-composer', onFocusComposer);
  }, [draftKey]);

  /**
   * 输入框随内容自动增高（规范 §5.6）。
   *
   * 规范要求："默认两行高（54px），**随内容增长到 200px 上限后内部滚动**"。
   * 实测原实现只有 CSS `height:54px; max-height:200px`，
   * **没有任何 JS 增高逻辑** —— 于是 `max-height` 永远不会被触及，
   * 输入超过两行时直接在 54px 里滚动，多行需求实际上没有兑现
   * （`scrollHeight` 恒等于 `clientHeight`，行数一多就只能看到两行）。
   *
   * 做法：先把高度重置为 auto 读 `scrollHeight`，再钳到 [54, 200]。
   * 重置这一步是必需的 —— 否则内容变少时高度不会回落（scrollHeight
   * 只会等于或大于当前 height）。
   * `body` 进依赖：所有变更都经 setBody，包括草稿恢复与引用插入。
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = 'auto';
    const next = Math.min(200, Math.max(54, editor.scrollHeight));
    editor.style.height = `${next}px`;
  }, [body]);

  const route = useMemo(() => deriveRoute(effectiveMentionIds, sendAs, memberIds,collaboration), [effectiveMentionIds, sendAs, memberIds,collaboration]);
  const budgetBounds = deliberationBudgetBounds(effectiveMentionIds, availableDeliberateIds);
  const budgetBelowMinimum = callBudgetEnabled === true && deliberate && budgetMaxTurns != null && budgetMaxTurns < budgetBounds.minimum;
  const budgetAboveMaximum = callBudgetEnabled === true && deliberate && budgetMaxTurns != null && budgetMaxTurns > budgetBounds.maximum;

  const currentMode = ACCESS_MODES.find((m) => m.value === access) ?? ACCESS_MODES[0];

  const hasAll = effectiveMentionIds.includes('all');
  const namedCount = effectiveMentionIds.filter((m) => m !== 'all').length;

  /* E6：方式芯片随 @ 结构切换；默认全关。
     注意：决策 03「先给方案再执行」已并入右侧的「计划模式」权限档，
     因此不 @ 时这里不再重复出现同义开关。 */
  const methodChip = useMemo(() => {
    if (hasAll) {
      return {
        key: 'skip_first_draft' as const,
        label: '跳过独立首稿',
        hint: '决策 05：@全体 默认先各自独立出稿再互评；开启后直接进入共同讨论，会削弱独立意见的保留程度。',
        on: skipFirstDraft,
        set: setSkipFirstDraft,
      };
    }
    if (namedCount >= 2) {
      return {
        key: 'split_work' as const,
        label: '分工执行',
        hint: '决策 09：多个 @ 默认是"共同研讨"（各自出报告）；开启后改为由一个成员统筹分工执行。',
        on: splitWork,
        set: setSplitWork,
      };
    }
    return null;
  }, [hasAll, namedCount, skipFirstDraft, splitWork]);

  function newId() {
    return `cmd_${Math.random().toString(36).slice(2, 10)}`;
  }

  async function submit(imageAck?: 'omit-images') {
    const text = stripInlineAttachmentTokens(body).trim();
    // 普通聊天固定交给 AI；没有正文但有 ready 附件仍可发送。
    const refsAtGuard = getDraftFull(draftKey).attachments.filter((a) => a.attachmentId != null && a.attachmentId.length > 0);
    if (text.length === 0 && refsAtGuard.length === 0) return;
    const busyAttachments = (getState().uploadItems[draftKey] ?? []).filter((item) => item.removed !== true && (item.status === 'preparing' || item.status === 'uploading'));
    if (busyAttachments.length > 0) {
      setSendErrorFor(draftKey, `仍有 ${busyAttachments.length} 个文件正在准备或上传；完成或移除后再发送，避免文件落到下一条草稿`);
      return;
    }
    if (sendDisabledReason) return;
    if (deliberate && effectiveMentionIds.filter((id) => id !== 'all').length < 2 && !effectiveMentionIds.includes('all')) {
      setSendErrorFor(draftKey, '请添加至少2位AI');
      return;
    }
    if (callBudgetEnabled === true && deliberate && budgetMaxTurns != null && !isValidDeliberationBudget(budgetMaxTurns, effectiveMentionIds, availableDeliberateIds)) {
      setSendErrorFor(draftKey, budgetBelowMinimum
        ? `本次上限至少 ${budgetBounds.minimum} 次`
        : `本次上限最多 ${budgetBounds.maximum} 次`);
      return;
    }
    // r62 P1 防重复守卫（R66 P3 修订）：文件-only 的 body 都为空——不能只比 body，须比**完整
    // 意图身份**（正文+意图+@提及+附件引用集合）。同一身份=换新号必重复，只允许同号重发或
    // 显式放弃；等待期改了正文/附件/提及=不同身份，允许新号发送（未知信封仍保留）。
    if (pendingEnv != null && pendingIdentityMatches(
      pendingEnv, text, effectiveMentionIds, sendAs, refsAtGuard.map((a) => a.attachmentId!),
      collaboration,
      callBudgetEnabled === true ? budgetMaxTurns ?? undefined : undefined,
      callBudgetEnabled === true && collaboration ? budgetPreview?.calls ?? undefined : undefined,
      // 旧只读信封仍须同号同参恢复；撤掉开关不能让相同内容换号扩大权限。
      pendingEnv.params.analysisOnly === true,
    )) {
      setSendErrorFor(draftKey, '上次发送结果还未确认，内容未改。请先查询发送状态，或点击「重发原内容」，避免重复发送。',pendingEnv.commandId);
      return;
    }
    // 防重按**目标键**锁（review-r47 §3/r48 §4）：同一目标在途时挡双击/Enter 并发；其它目标
    // 独立可发；A 的回执 finally 只删 A 的键（不清 B 的锁）。
    if (sendingKeys.has(draftKey) || imageCheckingKeys.has(draftKey)) return;
    // 图片能力未确认时先给出一次明确选择；普通聊天不存在“改为仅记录”。
    const draftRefs = getDraftFull(draftKey).attachments;
    const imageNames = draftRefs.filter((a) => a.kind === 'image_file').map((a) => a.name);
    if (imageNames.length > 0 && sendAs === 'ai' && imageAck !== 'omit-images') {
      const revisionAtCheck = getDraftFull(draftKey).rev;
      imageCheckingKeys.add(draftKey);
      try {
        const projectId = getState().activeProjectId;
        const conversationId = attachmentUpload?.conversationId ?? target.dmId ?? '';
        const formalTarget = target.kind === 'room_root' ? { kind: target.kind, projectId, conversationId, roomId: target.roomId }
          : target.kind === 'thread' ? { kind: target.kind, projectId, conversationId, threadId: target.threadId }
          : { kind: target.kind, projectId, conversationId };
        const capability = await command<{ supported: boolean; willDispatch: boolean; members: Array<{ kind: string; model: string; status: string; channel: string; reason: string; configuration: string; protocol: string }> }>('message.imageCapability', {
          target: formalTarget, ...(collaboration?{collaboration}:{}), mentions: effectiveMentionIds.map((id) => id === 'all' ? { kind: 'all' } : { kind: 'member', memberId: id }),
        });
        if (draftKeyRef.current !== draftKey || getDraftFull(draftKey).rev !== revisionAtCheck || getState().activeProjectId !== projectId) return;
        if (!capability.supported) { setImageGate({ names: imageNames, reason: '当前所选 AI 尚不能确认接收图片' }); return; }
      } catch (error) {
        setSendErrorFor(draftKey, `图片发送能力读取失败：${userFacingSystemText((error as Error).message ?? '')}。草稿与原件保留，可重试、换成员或移除图片。`);
        return;
      } finally { imageCheckingKeys.delete(draftKey); }

    }
    if (imageAck === 'omit-images' && text.length === 0 && draftRefs.every((a) => a.kind === 'image_file')) {
      setSendErrorFor(draftKey, '已选「仅发送文字」，但没有可用文字（正文为空且附件只有未认证图片）——请先添加文字或换非图片附件');
      return;
    }
    sendingKeys.add(draftKey);
    setSending(true);
    setSendErrorState(null);
    setImageGate(null);
    const keyAtSend = draftKey;
    const commandIdAtSend = commandIdRef.current;
    const sentMentions = effectiveMentionIds;
    /** 本次实际发送的附件引用（refs 身份——不再按文件名/大小识别，review-r51 §2）。 */
    const sentAttachmentIds = draftRefs.map((a) => a.attachmentId);
    const sentAttachments = draftRefs;
    const sentBudget = callBudgetEnabled === true && collaboration
      ? (budgetMaxTurns ?? budgetPreview?.calls)
      : undefined;

    const outcome = onSend({
      body: text,
      sendAs,
      mentionIds: effectiveMentionIds,
      ...(collaboration?{collaboration}:{}),
      ...(sentBudget != null ? { budgetMaxTurns: sentBudget } : {}),
      method: { planFirst: access === 'plan', skipFirstDraft, splitWork },
      access,
      attachments: sentAttachments,
      commandId: commandIdAtSend,
      target,
      draftRev: getDraftFull(draftKey).rev,
      ...(imageAck === 'omit-images' ? { imageAck: 'omit-images' as const } : {}),
    });

    /** 按**发起目标键**结算 STORED 草稿（review-r47 §3：迟到回执只清发起目标的已发内容，
     * 等待期/切目标后的其它草稿与编辑不动）；返回结算后的草稿供同键在挂时同步当前输入。
     * r53 §4 收口：**已发 refs 清算独立于正文保护**——无论等待期是否编辑（代次变没变），
     * 都只剥本次确实发送的 attachmentId 集合并清 store 已结算上传项；正文/提及剥离仍按
     * 代次门（等待期编辑过则保留）。等待期新选的附件（新 attachmentId）不受影响；已发出
     * 的资源不会默默留在草稿里进入下一条信封。 */
    const revAtSend = getDraftFull(keyAtSend).rev;
    const settleForKey = (key: string): HifiDraft => {
      const d = getDraftFull(key);
      const unchanged = d.rev === revAtSend;
      const nextBody = unchanged ? stripInlineAttachmentTokens(d.body).replace(/^\s+/, '') : d.body;
      const mentionsClear = unchanged && d.mentions.length === sentMentions.length && d.mentions.every((m, i) => m === sentMentions[i]);
      const sentIds = new Set(sentAttachmentIds);
      const keptAttachments = d.attachments.filter((a) => !sentIds.has(a.attachmentId));
      const settled: HifiDraft = {
        ...d,
        body: nextBody,
        mentions: mentionsClear ? [] : d.mentions,
        attachments: keptAttachments,
        sendAs: 'ai',
      };
      setDraftFull(key, settled);
      clearSettledUploads(key, sentAttachmentIds);
      return settled;
    };
    const syncIfMounted = (key: string, settled: HifiDraft) => {
      if (draftKeyRef.current !== key) return; // 已切目标：不动当前输入（B 的草稿不受 A 回执影响）
      setBody(settled.body);
      setMentions(settled.mentions); // r63：已发 @ 的清理结果随统一清结算同步（此前不同步=芯片残留）
      // 附件芯片由 store 驱动（clearSettledUploads 已按 refs 清）——不同步本地状态。
      if (editorRef.current != null) {
        renderEditorBody(editorRef.current, settled.body, getState().uploadItems[key] ?? []);
        setEditorCaret(editorRef.current);
      }
      setMentionOpen(false);
    };

    // 正式异步合同：onSend 返回 Promise 时等待可判定结果——成功按发起键结算；确定失败保留
    // 草稿+行内错误（按发起键）+换新命令号；**结果未知**：冻结完整原信封（commandId+target+
    // body+mentions+intent）到 store，立即换新命令号（此后正常发送=新信封，不会同号改参触发
    // IDEMPOTENCY_CONFLICT），重试走「重发原信封」。未返回 Promise（原型同步形态）保持原行为。
    if (outcome != null && typeof (outcome as Promise<unknown>).then === 'function') {
      (outcome as Promise<FormalSendOutcome | void>).then((r) => {
        if (r == null || r.status === 'ok') {
          // r63 P1（review-r62 §2）：成功清算是**页面在 store 层的 settleOutbound 单一来源**
          //（正文/mentions/refs/一次性意图/账本一次写，先剥内容后删账）。此处只读结算后的草稿
          // 同步现挂 UI——不再二次 setDraftFull（双结算递增代次→revAtSend 门失效→已发 @ 残留）。
          syncIfMounted(keyAtSend, getDraftFull(keyAtSend));
          commandIdRef.current = newId(); // 成功后下一次是新的命令
        } else if (r.status === 'failed') {
          commandIdRef.current = newId(); // 确定失败：新命令号重发
          setSendErrorFor(keyAtSend, `发送失败：${userFacingSystemText(r.error ?? '')}——内容已保留，修正后可重发`,commandIdAtSend);
        } else {
          // 页面已在发送前用正式 builder 冻结完整信封并按 unknown 入库（park）——此处只换新号。
          commandIdRef.current = newId();
          setSendErrorFor(keyAtSend, `发送结果未知（${userFacingSystemText(r.error ?? '')}）——上次发送记录已保留，可「重发原内容」（保留原发送编号，避免重复）`,commandIdAtSend);
        }
      }).catch((e: unknown) => {
        // 无明确业务回执的异常：页面按 unknown 已冻结原信封——此处只换新号。
        commandIdRef.current = newId();
        setSendErrorFor(keyAtSend, `发送结果未知（${e instanceof Error ? e.message : String(e)}）——上次发送记录已保留，可「重发原内容」`,commandIdAtSend);
      }).finally(() => {
        sendingKeys.delete(keyAtSend); // 只清发起键（不清其它在途目标——r48 §4）
        setSending(false);
      });
      return;
    }
    // 原型同步形态（onSend 不返回 Promise）兼容分支——正式三页均异步并已在 store 层走
    // settleOutbound 统一清算；此分支不构成第二结算源（r63 P1）。
    const settled = settleForKey(keyAtSend);
    syncIfMounted(keyAtSend, settled);
    commandIdRef.current = newId();
    queueMicrotask(() => {
      sendingKeys.delete(keyAtSend);
      setSending(false);
    });
  }

  /** 重发原信封（结果未知专用）：严格使用冻结参数；成功按发起键结算+清信封；确定失败清信封。 */
  function retryUnknown(env: PendingSendEnvelope): void {
    if (onRetrySend == null) return;
    const busyAttachments = (getState().uploadItems[draftKey] ?? []).filter((item) => item.removed !== true && (item.status === 'preparing' || item.status === 'uploading'));
    if (busyAttachments.length > 0) {
      setSendErrorFor(draftKey, `仍有 ${busyAttachments.length} 个文件正在准备或上传；本目标完成后才能重发待确认的发送`);
      return;
    }
    if (sendingKeys.has(draftKey)) return;
    sendingKeys.add(draftKey);
    setSending(true);
    setSendErrorState(null);
    const keyAtSend = draftKey;
    void onRetrySend(env).then((r) => {
      if (r == null || r.status === 'ok') {
        // r63 P1：重试成功与普通成功共用 settleOutbound 统一清算（正文/mentions/refs/一次性
        // 意图/账本+pendingSends 同号收口与队首顶替；先剥内容后删账的崩溃安全顺序不变）。
        settleOutbound(keyAtSend, env);
        const settled = getDraftFull(keyAtSend);
        if (draftKeyRef.current === keyAtSend) {
          setBody(settled.body);
          setMentions(settled.mentions);
          if (editorRef.current != null) {
            renderEditorBody(editorRef.current, settled.body, getState().uploadItems[keyAtSend] ?? []);
            setEditorCaret(editorRef.current);
          }
        }
        return;
      }
      if (r.status === 'failed') {
        clearUnknownEnvelope(keyAtSend); // 原信封被服务明确拒绝：信封作废
        setSendErrorFor(keyAtSend, `重发失败：${userFacingSystemText(r.error ?? '')}`,env.commandId);
        return;
      }
      setSendErrorFor(keyAtSend, `重发仍未知（${userFacingSystemText(r.error ?? '')}）——上次发送记录继续保留，可再重试`,env.commandId);
    }).catch((e: unknown) => {
      setSendErrorFor(keyAtSend, `重发仍未知（${e instanceof Error ? e.message : String(e)}）——上次发送记录继续保留`,env.commandId);
    }).finally(() => {
      sendingKeys.delete(keyAtSend);
      setSending(false);
    });
  }

  function replaceMentionTriggerWithToken(token: string) {
    const current = serializeEditor(editorRef.current) || bodyRef.current;
    const trigger = mentionTrigger?.draftKey === draftKey ? mentionTrigger : { index: 0, end: 0, draftKey };
    const insertion = `@${token} `;
    const next = `${current.slice(0, trigger.index)}${insertion}${current.slice(trigger.end)}`.replace(/^\s+/, '');
    setBody(next);
    setMentions(resolveMentionsFromBody(next));
    setMentionTrigger(null);
    setMentionQuery('');
    setMentionOpen(false);
    const editor = editorRef.current;
    if (editor != null) {
      renderEditorBody(editor, next, uploadItemsRaw);
      setEditorCaret(editor, trigger.index + insertion.length);
    }
  }

  function insertMention(id: string) {
    const token = id === 'all' ? '全体' : mentionTokenById.get(id) ?? memberLabel(allMembers.find((member) => member.id === id));
    replaceMentionTriggerWithToken(token);
  }

  function openMentionPickerFromToolbar() {
    const editor = editorRef.current;
    const current = serializeEditor(editor) || bodyRef.current;
    const at = editorCaretOffset(editor);
    const separator = at > 0 && !/\s$/.test(current.slice(0, at)) ? ' ' : '';
    const inserted = `${separator}@`;
    const next = `${current.slice(0, at)}${inserted}${current.slice(at)}`;
    const index = at + separator.length;
    setBody(next);
    setMentions(resolveMentionsFromBody(next));
    setMentionTrigger({ index, end: index + 1, draftKey });
    setMentionQuery('');
    setMentionOpen(true);
    if (editor != null) {
      renderEditorBody(editor, next, uploadItemsRaw);
      setEditorCaret(editor, index + 1);
    }
  }

  /**
   * @ 触发检测（r55 T2）：以**光标位置**为准——光标前一位是 @ 即打开候选并记录该下标
   * （不再只认「正文末尾的 @」，光标处/中文紧邻触发同判）；IME 组合中不触发（组合结束
   * 再判定一次——输入法过程不被打断，结束时若光标前恰为 @ 候选照常打开）。
   */
  function detectMentionTrigger(editor: HTMLDivElement | null): void {
    if (editor == null || composingRef.current) return;
    const v = serializeEditor(editor);
    const cur = editorCaretOffset(editor);
    const range = detectMentionRange(v, cur);
    if (range != null) {
      setMentionOpen(true);
      setMentionTrigger({ index: range.index, end: range.end, draftKey });
      setMentionQuery(range.query);
      setMentionActive(0);
    } else {
      setMentionOpen(false);
      setMentionTrigger(null);
      setMentionQuery('');
    }
  }

  function onInput(editor: HTMLDivElement) {
    const next = serializeEditor(editor);
    setBody(next);
    setMentions(resolveMentionsFromBody(next));
    const missing = staleAttachmentUploadIds(next, getState().uploadItems[draftKey] ?? []);
    if (missing.length > 0) {
      // Keep the visible edit made by the user, then atomically retire the
      // attachment identities that no longer have a body token.
      setDraftFull(draftKey, { ...getDraftFull(draftKey), body: next });
      for (const uploadId of missing) removeUploadItem(draftKey, uploadId);
      syncDraftBodyToEditor(draftKey);
    }
    detectMentionTrigger(editor);
  }

  const normalizedMentionQuery = mentionQuery.trim().toLocaleLowerCase();
  const mentionMemberCandidates = (showMentions ? members : []).filter((member) => {
    if (!member.enabled) return false;
    const haystack = `${member.displayName} ${member.description ?? ''} ${runtimeLabelOf(member)}`.toLocaleLowerCase();
    return normalizedMentionQuery.length === 0 || haystack.includes(normalizedMentionQuery);
  });
  const mentionDocumentCandidates = mentionDocs.filter((doc) => {
    const already = doc.attachmentId != null && attachments.some((item) => item.attachmentId === doc.attachmentId);
    return !already && (normalizedMentionQuery.length === 0 || doc.name.toLocaleLowerCase().includes(normalizedMentionQuery));
  });
  const showAllCandidate = showMentions && ('全体'.includes(normalizedMentionQuery) || normalizedMentionQuery.length === 0);
  const mentionCandidates: Array<{ kind: 'all' } | { kind: 'member'; id: string } | { kind: 'document'; doc: MentionDocument }> = [
    ...(showAllCandidate ? [{ kind: 'all' as const }] : []),
    ...mentionMemberCandidates.map((member) => ({ kind: 'member' as const, id: member.id })),
    ...mentionDocumentCandidates.map((doc) => ({ kind: 'document' as const, doc })),
  ];

  async function insertDocument(doc: MentionDocument) {
    if (documentBusy != null) return;
    const startDraftKey = draftKey;
    const startProjectId = activeProjectId;
    const startValue = serializeEditor(editorRef.current) || bodyRef.current;
    const trigger = mentionTrigger?.draftKey === startDraftKey
      ? { index: mentionTrigger.index, end: mentionTrigger.end }
      : { index: editorCaretOffset(editorRef.current), end: editorCaretOffset(editorRef.current) };
    const insertionContextIsCurrent = () => draftKeyRef.current === startDraftKey
      && getState().activeProjectId === startProjectId;
    setDocumentBusy(doc.key);
    setMentionDocsError(null);
    try {
      if (doc.kind === 'uploaded') {
        if (doc.attachmentId == null || doc.fileKind == null) throw Error('上传文档身份不完整');
        if (attachmentUpload == null) throw Error('当前页面没有可用的会话附件通道');
        const added = addFileRefToDraft(draftKey, attachmentUpload.conversationId, {
          attachmentId: doc.attachmentId,
          name: doc.name,
          kind: doc.fileKind,
          hash: doc.hash,
          revision: doc.revision,
        }, { replaceRange: { start: trigger.index, end: trigger.end } });
        if (!added.ok) throw Error(added.error ?? '文档引用保存失败');
        if (added.existed === true) {
          const d = getDraftFull(startDraftKey);
          const cleaned = `${startValue.slice(0, trigger.index)}${startValue.slice(trigger.end)}`;
          setDraftFull(startDraftKey, { ...d, body: cleaned });
        }
      } else {
        if (doc.path == null || !activeProjectId) throw Error('工作区文件身份不完整');
        if (attachmentUpload == null) throw Error('当前页面没有可用的会话附件通道');
        const cleaned = `${startValue.slice(0, trigger.index)}${startValue.slice(trigger.end)}`;
        const beforeAdd = getDraftFull(startDraftKey);
        setDraftFull(startDraftKey, { ...beforeAdd, body: cleaned });
        if (draftKeyRef.current === startDraftKey) {
          setBody(cleaned);
          if (editorRef.current != null) {
            renderEditorBody(editorRef.current, cleaned, getState().uploadItems[startDraftKey] ?? []);
            setEditorCaret(editorRef.current, trigger.index);
          }
        }
        const original = await command<{ bytesBase64: string; filename: string }>('project.file.originalFile', {
          projectId: activeProjectId,
          path: doc.path,
        });
        const binary = atob(original.bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        await uploadPickedFiles([new File([bytes], original.filename)]);
        const stored = getDraftFull(startDraftKey).attachments.find((item) => item.name === original.filename);
        if (stored == null) throw Error('文件未形成可发送的托管快照（上传或提取失败，详见附件提示）');
      }
      if (!insertionContextIsCurrent()) return;
      syncDraftBodyToEditor(startDraftKey);
      setMentionTrigger(null);
      setMentionQuery('');
      setMentionOpen(false);
    } catch (error) {
      if (insertionContextIsCurrent()) {
        setMentionDocsError(`引用「${doc.name}」失败：${userFacingSystemText((error as Error).message ?? '')}。输入与已选内容保留。`);
        setMentionOpen(true);
      }
    } finally {
      if (draftKeyRef.current === startDraftKey) setDocumentBusy(null);
    }
  }

  function chooseMentionCandidate(candidate: typeof mentionCandidates[number]) {
    if (candidate.kind === 'all') insertMention('all');
    else if (candidate.kind === 'member') insertMention(candidate.id);
    else void insertDocument(candidate.doc);
  }

  /** 参与者名：用于 @ 按钮的 tooltip，让发送前能看到这次会叫上谁 */
  const participantNames = (effectiveMentionIds.length===0&&route.mode==='AUTO'&&room?.coordinatorMemberId?[room.coordinatorMemberId]:route.resolvedMemberIds)
    .map((id) => memberLabel(allMembers.find((m) => m.id === id)))
    .join('、');

  /**
   * 发送前推导预算（E12 / §10.4）。
   * DELIBERATE 按冻结名单推导：核心 6N+1，含一次修订 7N+2；
   * 并为 SYNTHESIS(1) + RATIFY(N) 预留尾部配额。
   * 原来只在发送后的系统卡里出现，不满足"发送前显示推导值"。
   */
  const budgetPreview = useMemo(() => {
    if (callBudgetEnabled !== true) {
      return {
        calls: null as number | null,
        detail: callBudgetReadError != null
          ? `调用次数预算设置读取失败：${userFacingSystemText(callBudgetReadError ?? '')}。服务端仍会在提交时核对；草稿保留。`
          : '调用次数预算已关闭：真实记账，但不按次数拦截。可在应用设置开启。',
      };
    }
    const n = route.mode === 'DELIBERATE' ? budgetBounds.rosterSize : route.resolvedMemberIds.length;
    if (route.mode === 'DELIBERATE' && n > 0) {
      const core = defaultDeliberationMaxTurns(n);
      return {
        calls: core,
        // 公式与推导明细收进 tooltip：主界面只显示"最多 N 次调用"
        detail: `默认按本次参与成员 ${n} 人、一次检查点及一次整合修订推导 7N+3=${core}；整合与确认预留 ${1+n} 次。实际预算以任务开始时的设置为准。`,
      };
    }
    if (route.mode === 'DIRECT') {
      return { calls: DEFAULT_CALL_BUDGET_LIMITS.DIRECT, detail: 'DIRECT：用户最初输入引发的模型调用；额外输入创建新的预算段。' };
    }
    return { calls: DEFAULT_CALL_BUDGET_LIMITS.AUTO, detail: `AUTO 本轮共用最多${DEFAULT_CALL_BUDGET_LIMITS.AUTO}次，规划、全部子任务、修复和整合计入，预留2次整合；遵守更小任务预算。以任务开始时的设置为准。` };
  }, [callBudgetEnabled, callBudgetReadError, route.mode, route.resolvedMemberIds.length, budgetBounds.rosterSize]);

  const effectiveBudget = callBudgetEnabled === true
    ? budgetMaxTurns ?? budgetPreview?.calls ?? null
    : null;
  const modeInvalid = deliberate && effectiveMentionIds.filter((id) => id !== 'all').length < 2 && !effectiveMentionIds.includes('all');
  const canUseDeliberate = target.kind === 'room_root' || target.kind === 'thread';
  const hasSendableBody = stripInlineAttachmentTokens(body).trim().length > 0;

  function enableDeliberate(): void {
    const explicitlyNamed = mentions.filter((id) => availableDeliberateIds.includes(id));
    const initial = explicitlyNamed.length >= 2 ? explicitlyNamed : availableDeliberateIds;
    setDeliberateMemberIds(initial);
    setDeliberate(true);
    setModeMenuAnchor(null);
  }

  function saveBudget(): void {
    if (callBudgetEnabled !== true || !deliberate) return;
    const parsed = Number(budgetInput);
    if (!isValidDeliberationBudget(parsed, effectiveMentionIds, availableDeliberateIds)) return;
    setBudgetMaxTurns(parsed);
    setDraftFull(draftKey, { ...getDraftFull(draftKey), body: bodyRef.current, budgetMaxTurns: parsed });
    setBudgetMenuAnchor(null);
  }

  function toggleDeliberateMember(memberId: string): void {
    setDeliberateMemberIds((current) => current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId]);
  }

  /**
   * 预算可见性（减负 §6.1 / D5 决议）。
   *
   * 开发报告 §10.4 两处明文要求 **DELIBERATE 的推导值发送前显示**（E12），
   * 所以多成员研讨继续保留输入区那枚紧凑 chip（它已经是极简形态）。
   * 普通任务的预算明细收进「本次运行设置」；只有当它**影响本次执行**时
   * （预算已用完 / 接近上限）才在输入区显式提示。
   */
  const budgetVisible = callBudgetEnabled === true && !modeInvalid && effectiveBudget != null;
  const budgetReadFailed = callBudgetEnabled === null && callBudgetReadError != null;
  const budgetDetailsVisible = callBudgetEnabled === true || budgetReadFailed;
  const budgetAlert = useMemo(() => {
    if (callBudgetEnabled !== true || !runBudget) return null;
    const { used, max } = runBudget;
    if (max <= 0) return null;
    if (used >= max) return `本次运行预算已用完（${used}/${max} 次），继续会创建新的预算段`;
    if (used >= max - 1) return `本次运行接近上限（${used}/${max} 次）`;
    return null;
  }, [runBudget]);

  /**
   * r63：runtime 未绑定提示（发送区就地）——@ 指派成员未绑定（或未指派且项目无任何已绑定
   * agent）时给出原因与直达入口（成员页「配置 runtime」）；能力未认证不在发送前硬拦（派发侧
   * 按认证边界处理），未绑定是明确的配置缺失。
   */
  const navigateToMembers = (): void => { void import('../lib/router').then((m) => m.navigate('/members')); };
  useEffect(() => {
    const preventNavigation = (event: DragEvent): void => {
      if (event.dataTransfer != null && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  const handleComposerDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    if (attachmentUpload == null) {
      setSendErrorFor(draftKey, '当前页面没有可用的会话附件通道，文件未加入草稿');
      return;
    }
    void uploadPickedFiles(files);
  };

  const handleInlineTokenClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const host = target.closest<HTMLElement>('[data-zs-inline-token="1"]');
    if (host == null) return;
    const remove = target.closest<HTMLElement>('[data-zs-file-remove="1"]');
    if (remove != null) {
      event.preventDefault();
      event.stopPropagation();
      const uploadId = host.dataset.zsUploadId;
      if (uploadId != null) removeAttachment(uploadId);
      return;
    }
    if (target.closest<HTMLElement>('[data-zs-file-open="1"]') == null) return;
    const attachmentId = host.dataset.zsAttachmentId;
    if (attachmentId == null || attachmentUpload == null) return;
    event.preventDefault();
    openPreview({
      attachmentId,
      filename: host.dataset.zsFileName ?? '附件',
      kind: host.dataset.zsFileKind ?? 'text_file',
      conversationId: attachmentUpload.conversationId,
      origin: '输入区附件',
      draftKey,
    });
  };

  const runtimeHint = useMemo(() => {
    if (target.kind === 'dm') return null; // DM 走成员自身绑定链
    // 房间根输入在 M0 非 DIRECT 时先要选定单个成员；此刻未绑定提示指向尚未确定的执行
    // 成员，会与同位置的 M0 派发提示叠成两张警示。选定成员后再核其真实 runtime。
    const bound = (id: string) => memberRuntimes[id]?.status === 'bound';
    const agentIds = memberIds.filter((id) => allMembers.find((m) => m.id === id)?.principalType === 'agent');
    if (agentIds.length === 0) return null;
    const named = effectiveMentionIds.length===0&&route.mode==='AUTO'&&room?.coordinatorMemberId?[room.coordinatorMemberId]:route.resolvedMemberIds.filter((id) => id !== 'all');
    if (named.length > 0) {
      const namedUnbound = named.filter((id) => !bound(id));
      if (namedUnbound.length === 0) return null;
      const names = namedUnbound.map((id) => allMembers.find((m) => m.id === id)?.displayName ?? id).join('、');
      return { text: `${route.mode==='AUTO'?'协调成员':'选中成员'}（${names}）未绑定 runtime——派发前请先在成员页配置渠道与模型`, who: namedUnbound.length };
    }
    if (route.resolvedMemberIds.includes('all') || named.length === 0) {
      // AUTO/全体：项目内没有任何已绑定 agent 时提示（有部分可用即不拦 AUTO 语义之外的行为）
      if (!agentIds.some((id) => bound(id))) return { text: '项目成员都还没绑定 runtime——发送给 AI 前请先在成员页配置渠道与模型', who: agentIds.length };
    }
    return null;
  }, [target.kind, memberIds, memberRuntimes, allMembers, route.mode, route.resolvedMemberIds,room?.coordinatorMemberId,effectiveMentionIds.length]);

  return (
    <div
      className={`composer${dragActive ? ' is-drag-over' : ''}`}
      data-zs-composer-mentions={mentions.join('|')}
      data-zs-composer-documents={attachments.filter((item) => item.status === 'ready').map((item) => item.attachmentId ?? '').join('|')}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={handleComposerDrop}
    >
      {dragActive ? (
        <div className="composer-drop-hint" data-zs-composer-drop-target="1" role="status">
          <Icon name="paperclip" size={14} /> 松开以加入当前草稿
        </div>
      ) : null}
      {/**
       * 目标摘要行已按用户要求**整行移除**（2026-09-24 第三轮）。
       *
       * 原来这里是"我在对谁说"的常驻身份行（`发布到 开发大厅` / `跟进 #N · 标题`）。
       * 用户看到后明确要求去掉：房间名就在正上方的房间头部、线程身份在
       * 「详情 → 任务概况」与输入框 placeholder 里都有，这一行是重复占位。
       *
       * ⚠ 代价（已在施工报告与本文件注释中留痕）：placeholder 在**输入后就隐藏**，
       * 所以"正在写长回复时还能一眼看到发给谁"这件事不再由常驻元素保证；
       * 身份仍可从「详情 → 任务概况」（任务号/状态/方式/来源/原始要求）与
       * 归档只读提示里查到。若日后需要恢复，恢复这一行即可（props 与样式都还在）。
       */}

      {/* 目标标签行：E3 子任务定向跟进（定向时覆盖整串目标） */}
      {target.subtask ? (
        <div className="composer-target">
          <span
            className="chip"
            style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
          >
            <Icon name="corner-down-right" size={11} />
            → 子任务 #{target.subtask.number}
            <span className="faint" style={{ marginLeft: 2 }}>{target.subtask.title}</span>
            {onClearSubtask ? (
              <button onClick={onClearSubtask} title="取消定向，回到整串">
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </span>
          <span className="small faint">这条内容直接交给该子任务负责人，不经协调者转述；取消定向即回到整串</span>
        </div>
      ) : null}

      {/* 发送前说明真实协作路由；不更改草稿中的提及或发送意图。 */}
      {writeHint?.key===writeContext&&writeHint.error?<div className="composer-mentions" data-zs-write-hint-error role="status"><span className="chip composer-info-chip" title={userFacingSystemText(writeHint.error)}>权限暂未刷新，发送时会重新核对。</span></div>:null}
      {runtimeHint != null && sendDisabledReason == null && inputDisabledReason == null ? (
        <div className="composer-mentions" data-zs-runtime-hint="1">
          <span className="chip composer-info-chip" title={runtimeHint.text}>
            <Icon name="alert-triangle" size={11} />
            {runtimeHint.text}
            <button title="打开成员页配置 runtime（渠道/模型/权限模式）" onClick={() => { navigateToMembers(); }}>去成员页配置</button>
          </span>
        </div>
      ) : null}

      {/* 空文件门：不造空派发，也不提供“仅记录”逃生口。 */}
      {stripInlineAttachmentTokens(body).trim().length === 0 && readyAttachmentCount > 0
        && attachments.filter((x) => x.status === 'ready').every((x) => x.size === 0 && (x.kind === 'text_file' || x.kind === 'code_file')) ? (
        <div className="composer-mentions" data-zs-empty-text-gate="1">
          <span className="chip composer-info-chip" title="这些附件都是 0 字节空文本——发给 AI 不会带上任何可用内容">
            <Icon name="alert-triangle" size={11} />
            空文件没有可发送给 AI 的内容（{attachments.filter((x) => x.status === 'ready' && x.size === 0).map((x) => x.name).join('、')}）
            <button title="移除所有空文件后继续输入" onClick={() => {
              for (const item of attachments.filter((x) => x.status === 'ready' && x.size === 0 && (x.kind === 'text_file' || x.kind === 'code_file'))) removeAttachment(item.uploadId);
            }}>移除空文件</button>
          </span>
        </div>
      ) : null}

      {/* 图片能力门（第五十二轮 §6.3）：显式二选一——选择前不发送；结果一次性冻结进信封。 */}
      {imageStatus?.key === imageContext && attachments.some(a => a.status === 'ready' && a.kind === 'image_file') ? <div className="composer-mentions" data-zs-image-status="1">
        <span className="chip composer-info-chip" style={{ whiteSpace: 'normal' }}>{imageStatus.text}</span>
      </div> : null}
      {imageGate != null ? (
        <div className="composer-mentions">
          <span className="chip composer-info-chip" title="当前目标未能确认图片输入能力；图片默认不会作为模型输入">
            <Icon name="image" size={11} />
            {userFacingSystemText(imageGate.reason ?? '当前目标图片输入尚未认证')}：{imageGate.names.join('、')}
            <button disabled={stripInlineAttachmentTokens(body).trim().length === 0 && attachments.filter((a) => a.status === 'ready').every((a) => a.kind === 'image_file')} title="图片保留在聊天中，本次只把文字发送给 AI" onClick={() => submit('omit-images')}>仅发送文字（图片不送模型）</button>
            <button title="移除本草稿图片引用；已保存原件保留，其余内容可继续发送" onClick={() => { for (const a of attachments) if (a.kind === 'image_file') removeAttachment(a.uploadId); setImageGate(null); }}>移除图片继续</button>
            {showMentions ? <button title="重新选择已认证图片输入的成员后发送" onClick={() => { setImageGate(null); setMentionTrigger(null); setMentionOpen(true); }}>换可用成员</button> : <button onClick={navigateToMembers}>成员配置</button>}
            <button title="暂不发送" onClick={() => setImageGate(null)}>取消</button>
          </span>
        </div>
      ) : null}

      {/* 结果未知的在途信封（review-r47 §2）：与当前草稿分列——重试严格重发原信封。
          R66 P3：文件-only 信封 body 为空——摘要显示附件数而不是空正文。 */}
      <SendRecoveryAction draftKey={draftKey} onRecovered={(settled,recovered)=>{
        if(draftKeyRef.current!==recovered.draftKey)return;
        setSendErrorState(previous=>previous?.key===recovered.draftKey&&previous.commandId===recovered.commandId?null:previous);
        setBody(settled.body);setMentions(settled.mentions);
        if(editorRef.current){renderEditorBody(editorRef.current,settled.body,getState().uploadItems[draftKey]??[]);setEditorCaret(editorRef.current);}
      }}/>
      {pendingEnv != null ? (
        <div className="composer-mentions">
          <span className="chip composer-info-chip" title={`结果未知的发送：${pendingEnvSummary(pendingEnv)}（${new Date(pendingEnv.at).toLocaleTimeString()}）`}>
            <Icon name="alert-triangle" size={11} />
            上次发送结果未知：{pendingEnvSummary(pendingEnv).slice(0, 24)}…
            <button title="按上次的内容重试发送，保留原发送编号以避免重复" onClick={() => retryUnknown(pendingEnv)}>重发原内容</button>
            <button title="放弃重试；如果消息已经保存，下次刷新时仍会显示" onClick={() => clearUnknownEnvelope(draftKey)}>放弃</button>
          </span>
        </div>
      ) : null}

      <div className="composer-box">
        <div
          ref={editorRef}
          className="composer-input composer-editor"
          contentEditable={!inputDisabledReason}
          suppressContentEditableWarning
          role="textbox"
          aria-label="输入消息"
          aria-multiline="true"
          aria-disabled={Boolean(inputDisabledReason)}
          data-placeholder={
            inputDisabledReason
              ? inputDisabledReason
              : target.kind === 'dm'
                ? `给 ${dm?.title ?? '这个成员'} 发消息…`
                : target.kind === 'room_root'
                  ? '发送消息，可 @ 指定成员或文件…'
                  : '跟进当前任务，可 @ 指定成员或文件…'
          }
          onInput={(e) => onInput(e.currentTarget)}
          onClick={handleInlineTokenClick}
          onCopy={(event) => {
            const selection = window.getSelection();
            if (selection == null || selection.rangeCount === 0 || selection.isCollapsed) return;
            event.preventDefault();
            const holder = document.createElement('div');
            holder.appendChild(selection.getRangeAt(0).cloneContents());
            event.clipboardData.setData('text/plain', serializeEditorForClipboard(holder).replace(/\n+$/, ''));
          }}
          onPaste={(e) => {
            if (inputDisabledReason) return;
            const files = Array.from(e.clipboardData.files ?? []);
            if (files.length > 0) {
              e.preventDefault();
              void uploadPickedFiles(files);
              return;
            }
            const text = e.clipboardData.getData('text/plain');
            if (text.length === 0) return;
            e.preventDefault();
            const editor = e.currentTarget;
            editorInsertPlainText(editor, text);
            onInput(editor);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            const pendingKey = pendingCompositionSyncRef.current;
            if (pendingKey != null) {
              // R91：组合期间收到的回执同步被推迟。组合文本此刻已落进 DOM，放到下一拍
              // 再做「DOM 文本 + 草稿 token」合并重建——组合本身不被破坏，芯片状态也追上。
              window.setTimeout(() => {
                if (!composingRef.current) flushCompositionSync(pendingKey);
              }, 0);
              return;
            }
            // 组合结束再判一次（IME：组合过程不触发，提交后光标前恰为 @ 照常打开候选）。
            onInput(editorRef.current!);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && mentionOpen) {
              // 取消候选（r55）：只关框清触发位置——正文与已选芯片都不动。
              setMentionOpen(false);
              setMentionTrigger(null);
              e.preventDefault();
              return;
            }
            if (mentionOpen && !composingRef.current && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (mentionCandidates.length === 0) return;
                setMentionActive((current) => {
                  const delta = e.key === 'ArrowDown' ? 1 : -1;
                  return (current + delta + mentionCandidates.length) % mentionCandidates.length;
                });
                return;
              }
              if (e.key === 'Enter' && mentionCandidates.length > 0) {
                e.preventDefault();
                chooseMentionCandidate(mentionCandidates[Math.min(mentionActive, mentionCandidates.length - 1)]!);
                return;
              }
            }
            if (e.key === 'Enter' && e.shiftKey) {
              if (composingRef.current || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const editor = e.currentTarget;
              editorInsertPlainText(editor, '\n');
              onInput(editor);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              // 中文输入法组合态的 Enter 不发送（§17.4）
              if (composingRef.current || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit();
            }
          }}
        ></div>

        {mentionOpen ? (
          <div className="mention-pop" data-zs-mention-pop="1">
            <div className="menu-label">@ {showMentions ? '成员或文件' : '文件'}{normalizedMentionQuery ? ` · 搜索「${mentionQuery}」` : ' · 继续输入可搜索'}</div>
            {showAllCandidate ? (
              <button
                className={`menu-item${mentionActive === 0 ? ' active' : ''}`}
                onClick={() => insertMention('all')}
                onMouseEnter={() => setMentionActive(0)}
                data-zs-mention-option="all"
              >
                <Icon name="users" size={14} />
                <span style={{ flex: 1 }}>{target.kind==='thread'?'本串全体':'全体'}</span>
                <span className="hint">{members.filter(m=>m.enabled).length} 位 AI</span>
              </button>
            ) : null}
            {showMentions ? <div className="menu-sep" /> : null}
            {showMentions ? <div className="menu-label">成员</div> : null}
            {mentionMemberCandidates.map((m, memberIndex) => {
              const candidateIndex = (showAllCandidate ? 1 : 0) + memberIndex;
              return (
                <button
                  key={m.id}
                  className={`menu-item${mentionActive === candidateIndex ? ' active' : ''}`}
                  onClick={() => insertMention(m.id)}
                  onMouseEnter={() => setMentionActive(candidateIndex)}
                  data-zs-mention-option={m.id}
                  title={`提及 ${m.displayName}`}
                >
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={16} subject={`member:${m.id}`} />
                  <span style={{ flex: 1 }}>{memberLabel(m)}</span>
                  <span className="hint">{m.description?`${m.description} · `:''}{runtimeLabelOf(m)}</span>
                </button>
              );
            })}
            {showMentions && mentionMemberCandidates.length === 0 ? <div className="small faint" style={{ padding: '4px 8px' }}>没有匹配的成员</div> : null}
            <div className="menu-sep" />
            <div className="menu-label">文件</div>
            {mentionDocsLoading ? <div className="small faint" style={{ padding: '4px 8px' }}>正在读取工作区与已上传文档…</div> : null}
            {mentionDocsError != null ? <div className="small" role="alert" style={{ padding: '4px 8px', color: 'var(--warning)' }}>{userFacingSystemText(mentionDocsError ?? '')}</div> : null}
            {mentionDocumentCandidates.map((doc, docIndex) => {
              const candidateIndex = (showAllCandidate ? 1 : 0) + mentionMemberCandidates.length + docIndex;
              return (
                <button
                  key={doc.key}
                  className={`menu-item${mentionActive === candidateIndex ? ' active' : ''}`}
                  onMouseEnter={() => setMentionActive(candidateIndex)}
                  onClick={() => void insertDocument(doc)}
                  disabled={documentBusy != null}
                  data-zs-mention-document={doc.key}
                  title={`引用${doc.kind === 'workspace' ? '工作区' : '已上传'}文档 ${doc.name}`}
                >
                  <Icon name="file-text" size={14} />
                  <span style={{ flex: 1 }} className="truncate">{doc.name}</span>
                  <span className="hint">{documentBusy === doc.key ? '引用中…' : doc.kind === 'workspace' ? '工作区快照' : `已上传 v${doc.revision ?? 1}`}</span>
                </button>
              );
            })}
            {!mentionDocsLoading && mentionDocumentCandidates.length === 0 ? <div className="small faint" style={{ padding: '4px 8px' }}>没有匹配的文档</div> : null}
          </div>
        ) : null}

        <div className="composer-toolbar">
          {/* 普通输入固定交给 AI；不存在“任务/讨论”或“仅记录”开关。 */}
          {methodChip&&!formalLimits?.method ? (
            <button
              className={`method-chip${methodChip.on ? ' on' : ''}`}
              title={formalLimits?.method ?? methodChip.hint}
              disabled={Boolean(formalLimits?.method)}
              onClick={() => methodChip.set(!methodChip.on)}
            >
              <Icon name={methodChip.on ? 'check-circle' : 'circle'} size={11} />
              {methodChip.label}
            </button>
          ) : null}

          {/* 附件与提及放在左侧，紧邻输入内容（原来在最右侧，够不着）。
              只读态（私信归档）下附件按钮一并禁用：输入框都写不了，
              还能往草稿里塞附件是自相矛盾的。
              正式通道（第五十一轮 H2）：页面给 attachmentUpload={conversationId} 时经真实
              文件选择+attachment.upload*（格式实际限幅前置，服务端为最终裁决）；未给通道的
              页面维持 formalLimits 禁用说明——不出现「看起来已附上」的 mock 成功。 */}
          <button
            className="icon-btn sm"
            disabled={Boolean(inputDisabledReason) || attachmentUpload == null}
            title={
              attachmentUpload == null && formalLimits?.attachments
                ? formalLimits.attachments
                : inputDisabledReason
                  ? `${inputDisabledReason}（只读中不能添加附件）`
                  : attachmentUpload != null
                    ? '添加附件（文本、图片、PDF、Office、CSV）'
                    : '此处暂不支持添加附件'
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="paperclip" size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-zs-file-input="1"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = ''; // 允许再次选择同一文件
              if (attachmentUpload == null || files.length === 0) return;
              void uploadPickedFiles(files);
            }}
          />

          {showMentions || attachmentUpload != null ? (
            <button
              className={`icon-btn sm${mentionOpen ? ' active' : ''}`}
              title={
                showMentions && participantNames
                  ? `提及成员（也可以直接打 @）· 当前将叫上：${participantNames}`
                  : showMentions
                    ? '提及成员（也可以直接在输入框里打 @）'
                    : '引用文件（也可以直接在输入框里打 @）'
              }
              onClick={openMentionPickerFromToolbar}
            >
              <Icon name="at-sign" size={14} />
            </button>
          ) : null}

          <div className="spacer" />

          {/**
           * 右侧操作簇：预算提示 / 停止 / 本次运行设置 / 权限档位 / 发送。
           *
           * 它们被包成**一个不可拆分的 flex 项**（`.composer-actions`）：
           * 容器不够宽时整簇换行，而不是把「发送」单独挤到下一排
           * （用户反馈：并排预览时发送会掉到第二行，位置飘）。左半边的
           * 任务/讨论、方式、附件、@ 与预算明细先让位。
           */}
          <div className="composer-actions">
            {deliberate ? (
              <button
                type="button"
                className={`composer-mode-chip${modeMenuAnchor != null ? ' open' : ''}`}
                onClick={(event) => setModeMenuAnchor(anchorFromElement(event.currentTarget))}
                aria-haspopup="dialog"
                title="独立研讨：先独立分析，再互评汇总；点击调整成员或回到自然协作"
              >
                <Icon name="users" size={11} />
                独立研讨 · {effectiveMentionIds.includes('all') ? '全体' : `${effectiveMentionIds.filter((id) => id !== 'all').length}人`}
                <Icon name="chevron-down" size={10} />
              </button>
            ) : null}
            {modeInvalid ? (
              <span className="composer-mode-warning" role="alert" title="独立研讨至少需要2位AI成员；草稿不会被改动">
                <Icon name="alert-triangle" size={11} /> 请添加至少2位AI
              </span>
            ) : null}
            {deliberate && !modeInvalid && budgetBelowMinimum ? (
              <span className="composer-mode-warning" role="alert" data-zs-budget-min-warning="1">
                <Icon name="alert-triangle" size={11} /> 本次上限至少 {budgetBounds.minimum} 次
              </span>
            ) : null}
            {deliberate && !modeInvalid && budgetAboveMaximum ? (
              <span className="composer-mode-warning" role="alert" data-zs-budget-max-warning="1">
                <Icon name="alert-triangle" size={11} /> 本次上限最多 {budgetBounds.maximum} 次
              </span>
            ) : null}
            {budgetVisible && effectiveBudget != null && deliberate ? (
              <button
                type="button"
                className="composer-budget"
                title="设置本次独立研讨的调用预算，发送后仅用于本次任务"
                data-zs-call-budget="enabled"
                onClick={(event) => {
                  setBudgetInput(String(effectiveBudget));
                  setBudgetMenuAnchor(anchorFromElement(event.currentTarget));
                }}
              >
                <Icon name="activity" size={11} />
                最多 {effectiveBudget} 次
              </button>
            ) : budgetVisible && effectiveBudget != null ? (
              <span className="composer-budget" title={budgetPreview?.detail} data-zs-call-budget="enabled">
                <Icon name="activity" size={11} />
                最多 {effectiveBudget} 次
              </span>
            ) : null}
            {budgetAlert ? (
              <span className="composer-budget warn" title={budgetAlert}>
                <Icon name="alert-triangle" size={11} />
                {budgetAlert}
              </span>
            ) : null}

            {/* 停止任务：仅在有活动任务时出现，位置在输入区操作区（§2.3） */}
            {stop ? (
              stop.stopping ? (
                <span className="composer-stopping" title="已发出停止，正在等活跃 turn 结束；已产生的文件保留">
                  <Icon name="stop" size={11} /> 停止中…
                </span>
              ) : (
                <button
                  type="button"
                  className="btn danger sm composer-stop"
                  title="停止本次任务：阻止新派发、等待活跃 turn 结束；不等于撤销已产生的改动"
                  onClick={stop.onStop}
                >
                  <Icon name="stop" size={11} /> 停止任务
                </button>
              )
            ) : null}

            {/* 低频运行设置；普通聊天不存在“仅记录”入口。 */}
            <button
              type="button"
              className={`icon-btn sm${runSettingsAnchor ? ' active' : ''}`}
              title="本次运行设置：执行方式、研讨模式与说明"
              aria-label="本次运行设置"
              aria-haspopup="menu"
              onClick={(e) => setRunSettingsAnchor(anchorFromElement(e.currentTarget))}
            >
              <Icon name="more-horizontal" size={14} />
            </button>

            {/* 不能发送时必须说明原因，否则按钮灰着让人不知所措 */}
            {sendDisabledReason ? (
              <span className="composer-budget" title={sendDisabledReason} style={{ color: 'var(--warning)' }}>
                <Icon name="info" size={11} />
                {sendDisabledLabel ?? '只能存草稿'}
              </span>
            ) : null}

            {/* 权限模式下拉；只读态禁用。 */}
            {!formalLimits?.access ? (
              <div className="access-picker">
                <button
                  className={`access-trigger${accessOpen ? ' open' : ''}`}
                  disabled={Boolean(inputDisabledReason) || Boolean(formalLimits?.access)}
                  onClick={() => setAccessOpen((v) => !v)}
                  title={formalLimits?.access ? `${writeHint?.key===writeContext?writeHint.reason:'正在读取项目与成员权限'}${writeHint?.error?`；${userFacingSystemText(writeHint.error ?? '')}`:''}${writeHint?.readAt?`；确认于 ${new Date(writeHint.readAt).toLocaleTimeString()}`:''}` : inputDisabledReason ?? '本次任务使用的文件访问权限'}
                >
                  <Icon name={currentMode.icon} size={13} />
                  {formalLimits?.access ? target.kind==='room_root'&&route.mode!=='DIRECT' ? route.mode==='AUTO'?'自动分工 · 成员权限':'多人研讨 · 成员权限' : writeHint?.key===writeContext&&writeHint.readAt ? writeHint.blocked?'暂不可执行':writeHint.willDispatch===false?'仅保存草稿':writeHint.authorized?writeHint.fullAccess?'CLI 完整权限':'项目内文件编辑':'只读执行' : '权限未确认' : currentMode.label}
                  <Icon name="chevron-down" size={12} />
                </button>

              {accessOpen ? (
                <>
                  <div className="access-scrim" onClick={() => setAccessOpen(false)} />
                  <div className="access-menu" role="menu">
                    {ACCESS_MODES.map((m) => {
                      const unavailable = !m.v01.available;
                      // 先取出原因，避免在闭包里丢失类型收窄
                      const reason = m.v01.available ? undefined : m.v01.reason;
                      return (
                        <button
                          key={m.value}
                          className={`access-item${access === m.value ? ' on' : ''}${unavailable ? ' unavailable' : ''}`}
                          role="menuitemradio"
                          aria-checked={access === m.value}
                          aria-disabled={unavailable}
                          disabled={unavailable}
                          title={reason}
                          onClick={() => {
                            // 未验证的确认档位不允许选中，验证通过后按成员开放（RT-23/B6）
                            if (unavailable) return;
                            setAccess(m.value);
                            setAccessOpen(false);
                          }}
                        >
                          <Icon name={m.icon} size={16} />
                          <span className="access-item-text">
                            <span className="access-item-label">
                              {m.label}
                              {unavailable ? <Tag tone="neutral" icon="slash">待验证</Tag> : null}
                            </span>
                            <span className="access-item-desc">{reason ?? m.desc}</span>
                          </span>
                          {access === m.value ? <Icon name="check" size={14} /> : null}
                        </button>
                      );
                    })}
                    <div className="access-note">{INTENT_HINT}</div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {/**
           * 额外动作（私信归档态的「取消归档」）：放在发送按钮左侧的操作簇里，
           * 与"已归档：只读"的说明同处一地，不再出现"提示说能取消、却找不到入口"。
           */}
          {extraAction}

          <button
            className="btn primary sm composer-send"
            onClick={() => submit()}
            disabled={pendingAttachmentCount > 0 || (!hasSendableBody && readyAttachmentCount === 0) || sending || Boolean(sendDisabledReason) || modeInvalid || budgetBelowMinimum || budgetAboveMaximum}
            title={
              modeInvalid
                ? '请添加至少2位AI；草稿会保留'
                : budgetBelowMinimum
                  ? `本次上限至少 ${budgetBounds.minimum} 次；草稿会保留`
                  : budgetAboveMaximum
                    ? `本次上限最多 ${budgetBounds.maximum} 次；草稿会保留`
                : pendingAttachmentCount > 0
                  ? `有 ${pendingAttachmentCount} 个文件正在准备或上传；完成或移除后再发送`
                : (!hasSendableBody && readyAttachmentCount === 0) || sending || Boolean(sendDisabledReason)
                ? sendDisabledReason ?? (sending ? '正在发送…' : '输入内容、或添加就绪附件后可发送（只有文件也可以发送）')
                : 'Enter 发送，Shift+Enter 换行（没有正文但有就绪附件时也可发送）'
            }
          >
            <Icon name="send" size={12} />
            发送
          </button>

          {/**
           * 草稿：成功不作常驻提示（它几乎永远为真，占位却没有信息量），
           * 只有**持久化失败/不可用**或**快照恢复有丢弃**才显示，并按真实原因说明后果
           *（§6.2；r61 P5；r62 P2 恢复说明分列）。
           */}
          {draftPersist.error != null ? (
            <span
              className="composer-draft failed"
              title={userFacingSystemText(draftPersist.error ?? '')}
            >
              <Icon name="alert-triangle" size={11} /> 草稿未持久化
            </span>
          ) : null}
          {draftPersist.error == null && draftPersist.recoveryNote != null ? (
            <span
              className="composer-draft failed"
              title={draftPersist.recoveryNote}
              data-zs-draft-recovery="1"
            >
              <Icon name="alert-triangle" size={11} /> 草稿快照部分未恢复（原件已隔离）
            </span>
          ) : null}

          {/* 正式侧行内发送错误（第四十七轮）：失败/未知都在输入区就地可见，不吞错。 */}
          {sendError != null ? (
            <span
              className="composer-draft failed"
              title={userFacingSystemText(sendError ?? '')}
              style={{ cursor: 'pointer' }}
              onClick={() => setSendErrorState(null)}
            >
              <Icon name="alert-triangle" size={11} /> {sendError.slice(0, 80)}（点击关闭）
            </span>
          ) : null}
          </div>
        </div>
      </div>

      {/* 本次运行设置：普通聊天固定交给 AI。 */}
      {runSettingsAnchor ? (
        <Menu anchor={runSettingsAnchor} onClose={() => setRunSettingsAnchor(null)}>
          <div className="menu-label">本次运行设置</div>
          <div className="menu-note">
            <div className="row tight"><Icon name="git-commit" size={12} /> 本次方式：{routeModeCopy[route.mode].label}</div>
            <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
              {target.kind === 'dm'
                ? '发给当前私信成员，不涉及房间里的其他人。'
                : routeModeCopy[route.mode].detail}
            </div>
            {methodChip&&!formalLimits?.method ? (
              <div className="small faint" style={{ marginTop: 6, lineHeight: 1.6 }}>
                方式开关「{methodChip.label}」：{methodChip.on ? '已开启' : '未开启'}（在输入区切换）
              </div>
            ) : null}
          </div>
          {budgetDetailsVisible ? (
            <div
              className="menu-note"
              data-zs-call-budget-menu={budgetReadFailed ? 'read-error' : 'enabled'}
              data-zs-call-budget-read-error={budgetReadFailed ? '1' : undefined}
            >
              <div className="row tight"><Icon name="activity" size={12} /> 本次预算</div>
              <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
                {callBudgetEnabled === true
                  ? (effectiveBudget != null
                    ? `最多 ${effectiveBudget} 次。${budgetPreview?.detail ?? ''}`
                    : target.kind === 'dm'
                      ? '实际用量可在任务详情查看。'
                      : '自然协作沿用既有预算；独立研讨可单独设置本次上限。')
                  : budgetPreview?.detail}
              </div>
            </div>
          ) : null}
          <div className="menu-note">
            <div className="row tight"><Icon name="shield" size={12} /> 权限档位</div>
            <div className="small faint" style={{ marginTop: 4, lineHeight: 1.6 }}>
              {formalLimits?.access?(writeHint?.key===writeContext?writeHint.reason:'正在读取 AI 执行权限'):<>当前：{currentMode.label} · {currentMode.v01.available?currentMode.desc:currentMode.v01.reason}</>}
            </div>
          </div>
          {canUseDeliberate&&!inputDisabledReason?<MenuItem icon="users" onClick={()=>{
            if (deliberate) {
              setModeMenuAnchor(runSettingsAnchor);
            } else {
              enableDeliberate();
            }
            setRunSettingsAnchor(null);
          }} hint={deliberate?'已开启':undefined}>{deliberate?'调整独立研讨成员':'独立研讨'}</MenuItem>:null}
        </Menu>
      ) : null}

      {modeMenuAnchor ? (
        <Menu anchor={modeMenuAnchor} onClose={() => setModeMenuAnchor(null)}>
          <div className="menu-label">独立研讨成员</div>
          <div className="composer-mode-menu-note">
            只使用当前{target.kind==='thread'?'回复串':'房间'}内可用成员。成员选择与正文 @ 分开保存。
          </div>
          <div className="composer-mode-members">
            {members.filter((member) => availableDeliberateIds.includes(member.id)).map((member) => {
              const selected = deliberateMemberIds.includes(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  className={`menu-item${selected ? ' active' : ''}`}
                  onClick={() => toggleDeliberateMember(member.id)}
                  aria-pressed={selected}
                >
                  <Icon name={selected ? 'check-circle' : 'circle'} size={14} />
                  <span className="truncate" style={{ flex: 1 }}>{memberLabel(member)}</span>
                  <span className="hint">{runtimeLabelOf(member)}</span>
                </button>
              );
            })}
          </div>
          {availableDeliberateIds.length < 2 ? <div className="composer-mode-warning" role="alert">请添加至少2位AI</div> : null}
          <div className="menu-sep" />
          <MenuItem icon="users" onClick={() => { setDeliberate(false); setModeMenuAnchor(null); }}>回到自然协作</MenuItem>
          <MenuItem icon="check" onClick={() => setModeMenuAnchor(null)}>完成</MenuItem>
        </Menu>
      ) : null}

      {budgetMenuAnchor ? (
        <Menu anchor={budgetMenuAnchor} onClose={() => setBudgetMenuAnchor(null)}>
          <div className="menu-label">本次预算</div>
          <div className="composer-budget-editor">
            <label htmlFor={`composer-budget-${draftKey}`}>最多调用次数</label>
            <input
              id={`composer-budget-${draftKey}`}
              type="number"
              min={budgetBounds.minimum}
              max={budgetBounds.maximum}
              step={1}
              value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveBudget();
                }
              }}
              autoFocus
            />
            <div className="small faint">范围 {budgetBounds.minimum}–{budgetBounds.maximum} 次。发送后用于本次独立研讨；上次待确认的发送保持原设置。</div>
            <div className="composer-budget-editor-actions">
              <button type="button" className="btn ghost sm" onClick={() => setBudgetMenuAnchor(null)}>取消</button>
              <button type="button" className="btn primary sm" onClick={saveBudget} disabled={!isValidDeliberationBudget(Number(budgetInput), effectiveMentionIds, availableDeliberateIds)}>保存</button>
            </div>
          </div>
        </Menu>
      ) : null}
    </div>
  );
}

export type { ProjectMember, Room };
