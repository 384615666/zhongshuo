/**
 * R197 第 2/3/5 项：消息里的图片附件 → 本机**可读绝对路径**。
 *
 * 用户反馈：
 *  - 引用只能引文字，图片不能引用；
 *  - 复制带图片的消息只得到图片名称；
 *  - 消息里的图片右键不能复制。
 *
 * 本模块只做「把消息里的图片解析成磁盘上可打开的文件路径」这一件事，供复制文本、
 * 引用卡、右键菜单共用：
 *  - 图片判定与消息内缩略图同口径（AttachmentThumb.isImageAttachment），不另立一套；
 *  - 有 `sourcePath`（项目内真实文件变更）时直接用「项目根 + 相对路径」，不请求 daemon；
 *  - 其余托管附件走正式只读命令 `attachment.absolutePath`（audience 校验、原件 sha256
 *    核对、可读扩展名路径副本都在 daemon），按 attachmentId 做模块级缓存；
 *  - 取路径失败返回 null，调用方退回到文件名——不伪造路径，也不让复制/引用整体失败。
 */

import type { Message } from '../data/types';
import { command } from '../bridge';
import { isImageAttachment } from '../components/AttachmentThumb';
import { absoluteProjectPath } from './localOpen';

/** 消息里的一张图片（正式附件身份 + 可选的来源相对路径）。 */
export interface MessageImageAttachment {
  attachmentId: string;
  filename: string;
  /** 项目内相对路径（真实文件变更时才有）；存在时不需要向 daemon 取托管路径副本。 */
  sourcePath?: string;
}

/** 一行「图片文件名 + 绝对路径」；路径解析失败时 path=null（调用方退回文件名）。 */
export interface ImagePathLine {
  filename: string;
  path: string | null;
}

/** attachment.absolutePath 的返回形状（本模块只关心路径本体）。 */
export interface AttachmentAbsolutePathResult {
  attachmentId: string;
  filename: string;
  mime: string;
  path: string;
  bytes: number;
}

/** attachmentId → 绝对路径请求（成功结果常驻；失败不缓存，下次仍可重试）。 */
const pathCache = new Map<string, Promise<string | null>>();

function basenameOf(path: string | null | undefined): string {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  const leaf = normalized.split('/').filter((part) => part.length > 0).pop();
  return leaf ?? '';
}

/**
 * 收集消息里的图片附件：
 *  - 正式附件投影（formalAttachments）里 isImageAttachment 的项；
 *  - 另兼容 message.fileChanges 里带 artifactId 的图片（这些图片为了保留变更关联不进
 *    消息缩略图网格，但它们同样是本条消息的图片，复制/引用不能漏）。
 * 同一 artifactId 只保留一次；没有附件身份的项不产出（不猜路径）。
 */
export function imageAttachmentsOfMessage(message: Pick<Message, 'formalAttachments' | 'fileChanges'>): MessageImageAttachment[] {
  const items: MessageImageAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of message.formalAttachments ?? []) {
    const attachmentId = typeof attachment?.artifactId === 'string' ? attachment.artifactId : '';
    if (attachmentId.length === 0) continue;
    if (seen.has(attachmentId)) continue;
    const filename = String(attachment.filename ?? '');
    if (!isImageAttachment(filename, attachment.kind)) continue;
    seen.add(attachmentId);
    items.push({ attachmentId, filename, sourcePath: attachment.sourcePath });
  }
  for (const change of message.fileChanges ?? []) {
    const artifactId = typeof change?.artifactId === 'string' ? change.artifactId : '';
    if (artifactId.length === 0 || seen.has(artifactId)) continue;
    const filename = change.displayName?.trim().length ? change.displayName.trim() : basenameOf(change.path);
    if (!isImageAttachment(filename, undefined)) continue;
    seen.add(artifactId);
    items.push({ attachmentId: artifactId, filename, sourcePath: change.path });
  }
  return items;
}

function requestAttachmentAbsolutePath(attachmentId: string): Promise<string | null> {
  const cached = pathCache.get(attachmentId);
  if (cached != null) return cached;
  const request = command<AttachmentAbsolutePathResult>('attachment.absolutePath', { attachmentId })
    .then((result) => {
      const path = typeof result?.path === 'string' && result.path.length > 0 ? result.path : null;
      if (path == null) pathCache.delete(attachmentId);
      return path;
    })
    .catch(() => {
      pathCache.delete(attachmentId);
      return null;
    });
  pathCache.set(attachmentId, request);
  return request;
}

/**
 * 单张图片的绝对路径：sourcePath 存在时用「项目根 + 相对路径」；否则向 daemon 取
 * 托管附件的可读路径副本。失败返回 null（调用方退回文件名，不抛错打断复制/引用）。
 */
export async function resolveImageAttachmentAbsolutePath(
  attachment: MessageImageAttachment,
  projectRoot: string | null | undefined,
): Promise<string | null> {
  const fromProject = absoluteProjectPath(projectRoot, attachment.sourcePath);
  if (fromProject != null) return fromProject;
  return requestAttachmentAbsolutePath(attachment.attachmentId);
}

/** 消息内全部图片的「文件名 + 绝对路径」；顺序与附件顺序一致，失败项 path=null。 */
export async function imagePathLinesForMessage(
  message: Pick<Message, 'formalAttachments' | 'fileChanges'>,
  projectRoot: string | null | undefined,
): Promise<ImagePathLine[]> {
  return await Promise.all(imageAttachmentsOfMessage(message).map(async (attachment) => ({
    filename: attachment.filename,
    path: await resolveImageAttachmentAbsolutePath(attachment, projectRoot),
  })));
}

/**
 * 把图片路径段追加到任意文本（复制消息 / 引用卡共用）：
 *   每条 = `[图片] 文件名` 换行 `绝对路径`，条目之间空一行；
 *   取不到绝对路径时只写 `[图片] 文件名`（如实退回，不伪造路径）；
 *   原文本为空时只输出图片段；没有图片时原样返回文本。
 */
export function appendImagePathsToText(text: string, lines: readonly ImagePathLine[]): string {
  const base = String(text ?? '').trimEnd();
  const sections = (lines ?? []).map((line) => {
    const path = typeof line.path === 'string' ? line.path.trim() : '';
    const filename = String(line.filename ?? '').trim();
    const heading = `[图片] ${filename}`;
    return path.length > 0 ? `${heading}\n${path}` : heading;
  });
  if (sections.length === 0) return base;
  return base.length > 0 ? `${base}\n\n${sections.join('\n\n')}` : sections.join('\n\n');
}
