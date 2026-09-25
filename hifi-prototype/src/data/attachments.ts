/**
 * 输入区附件的**模拟摄取**（房间 / 线程 / 私信共用）。
 *
 * 为什么单独一层：
 *  - 界面上「添加附件」以前只往输入区塞一枚芯片，发送时 `submitMessage` 拿到
 *    `attachments` 却**从不落地** —— 消息上没有任何附件，预览里也找不到它
 *    （点开附件按钮→发送→什么也没发生）。这是"控件存在但能力是假的"，
 *    与「原型边界不能伪造」相抵触。
 *  - 这里把"要落什么"与"贴在哪个消息上"分开：Composer 只负责拿描述符
 *    （`mockAttachmentDescriptor`，芯片上显示的体积 = 真正写进资源表的体积），
 *    写操作层用 `materializeAttachments` 一次性生成资源 + 消息链接。
 *
 * 诚实边界（不夸大）：
 *  - 本机**没有**真实文件选择器与文件摄取：内容取自原型内嵌 fixture，
 *    预览面板会照常打上「模拟资源」标签，`origin`/`audience` 按目标真实归属写入。
 *  - 因此体积与 hash 都来自**真的这份模拟内容**（不是编一个好看的数字），
 *    这样"文件信息"里显示的大小/哈希与芯片一致，不会自相矛盾。
 */

import { FIXTURE_CSV, FIXTURE_MARKDOWN_V1, FIXTURE_NOTES_TXT } from './fixture-content';
import { FIXTURE_PNG_DATA_URL, FIXTURE_PNG_HEIGHT, FIXTURE_PNG_WIDTH } from './fixture-png';
import type { MessageAttachment, PreviewResource, ResourceAudience, ResourceContent, ResourceOrigin } from './types';

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/** 文本按 UTF-8 计字节（浏览器里没有 Buffer，用 TextEncoder） */
function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** data URL 的负载字节数（base64 → 字节，去掉填充） */
function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

interface MockSpec {
  mimeType: string;
  content: ResourceContent;
  sizeBytes: number;
}

/**
 * 扩展名 → 模拟内容。**只对原型真能渲染的类型生成内容**；
 * 其余一律落到 `unsupported`（`not_connected`），不拿假正文冒充真实解析。
 */
function specFor(name: string): MockSpec {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    // 原型内嵌一张可渲染的 PNG；非 PNG 扩展名不做内容伪装，统一按 PNG 声明
    return {
      mimeType: 'image/png',
      content: {
        kind: 'image',
        mimeType: 'image/png',
        dataUrl: FIXTURE_PNG_DATA_URL,
        width: FIXTURE_PNG_WIDTH,
        height: FIXTURE_PNG_HEIGHT,
      },
      sizeBytes: dataUrlBytes(FIXTURE_PNG_DATA_URL),
    };
  }
  if (ext === 'md') {
    return { mimeType: 'text/markdown', content: { kind: 'markdown', text: FIXTURE_MARKDOWN_V1 }, sizeBytes: textBytes(FIXTURE_MARKDOWN_V1) };
  }
  if (ext === 'csv') {
    return { mimeType: 'text/csv', content: { kind: 'csv', text: FIXTURE_CSV }, sizeBytes: textBytes(FIXTURE_CSV) };
  }
  if (['txt', 'log', 'json', 'yml', 'yaml'].includes(ext)) {
    return { mimeType: 'text/plain', content: { kind: 'text', text: FIXTURE_NOTES_TXT }, sizeBytes: textBytes(FIXTURE_NOTES_TXT) };
  }
  return {
    mimeType: 'application/octet-stream',
    content: {
      kind: 'unsupported',
      reason: 'not_connected',
      note: '读取该格式的服务未接通：原型不解析它的内容，也不假装能预览。',
    },
    sizeBytes: 0,
  };
}

/**
 * 输入区附件芯片的描述符。
 *
 * **体积与内容来自同一个 spec**：芯片上写多少，落地后"文件信息"里就是多少，
 * 不会出现"芯片说 128 KB、点开说 11 KB"这种自相矛盾。
 * 默认给 .png（原型内嵌唯一可渲染的图片样本），与真实文件选择器接通后由真实文件替换。
 */
export function mockAttachmentDescriptor(index: number): { name: string; size: number; mimeType: string } {
  const name = `附件-${index + 1}.png`;
  const spec = specFor(name);
  return { name, size: spec.sizeBytes, mimeType: spec.mimeType };
}

export interface AttachmentTarget {
  projectId: string;
  /** 资源真实归属（§17.9 第 1 条）：房间消息 / 私信 */
  origin: ResourceOrigin;
  audience: ResourceAudience;
}

/**
 * 把输入区里的附件真正落成资源 + 消息链接。
 *
 * 返回要追加进 state 的两组记录（调用方一次 setState 写入，避免半成品状态）。
 */
export function materializeAttachments(
  attachments: { name: string; size: number }[],
  target: AttachmentTarget,
  messageId: string,
): { resources: PreviewResource[]; links: MessageAttachment[] } {
  const resources: PreviewResource[] = [];
  const links: MessageAttachment[] = [];

  attachments.forEach((a, ordinal) => {
    const spec = specFor(a.name);
    // hash 用内容本身推导（稳定、可复算），不是随机数
    const hashSource =
      spec.content.kind === 'image'
        ? spec.content.dataUrl
        : spec.content.kind === 'unsupported'
          ? `${a.name}:${spec.content.note}`
          : 'text' in spec.content
            ? spec.content.text
            : `${a.name}:${spec.content.kind}`;
    // hash 用内容本身推导（稳定、可复算），不是随机数
    let h = 0;
    for (let i = 0; i < hashSource.length; i += 1) h = (h * 31 + hashSource.charCodeAt(i)) >>> 0;
    const resourceId = newId('res_attach');
    resources.push({
      id: resourceId,
      projectId: target.projectId,
      kind: 'attachment',
      title: a.name,
      mimeType: spec.mimeType,
      origin: target.origin,
      audience: target.audience,
      revisions: [
        {
          revision: 1,
          hash: `sha256:${h.toString(16).padStart(8, '0')}${spec.sizeBytes.toString(16)}`,
          sizeBytes: spec.sizeBytes,
          createdAt: Date.now(),
          content: spec.content,
        },
      ],
      createdAt: Date.now(),
    });
    links.push({
      id: newId('att'),
      messageId,
      resourceId,
      revision: 1,
      ordinal,
    });
  });

  return { resources, links };
}
