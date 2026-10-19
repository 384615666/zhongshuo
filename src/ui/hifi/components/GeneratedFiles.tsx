/**
 * 生成文件 / 正式附件卡（R91 模块3，独占 helper）。
 *
 * 口径：
 *  - **只渲染正式 attachment refs**（`Message.formalAttachments`，来自
 *    artifact + message_attachments 的已落库摘要）。正文里用户随口写的绝对路径
 *    永远不在这里变成文件卡——那会造出可点开的伪引用。
 *  - 点击统一交给调用方传入的 `onOpen`（线程/私信页都接到共享 `openPreview`）。
 *    本组件不读取本地路径、不执行文件、不新增任何文件系统入口。
 *  - 去重：同一 artifactId 只出现一次（后端重复登记不产生重复卡）。
 *  - 卡片位置由调用方决定：MessageView 把它放在正文之后、复制/引用/收藏之前。
 */
import { Icon } from './Icon';
import { formatBytes } from '../lib/format';
import type { FormalAttachmentSummary } from '../data/types';

/**
 * 附件 kind → 中文标签（导出共享，r55）：回复芯片与根消息（线程锚消息）独立渲染路径
 * 用同一映射——此前锚消息路径只认 code/text，PPT（幻灯）/CSV（表格→sheet_file）都
 * 显示成「文本」（用户短测 T5 确认的呈现缺陷）。
 */
export const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  text_file: '文本', code_file: '代码', image_file: '图片', pdf_file: 'PDF',
  docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯',
};

/** 未知 kind 不裸露内部枚举（例如 unsupported_file）——统一显示「文件」。 */
export function attachmentKindLabel(kind: string): string {
  return ATTACHMENT_KIND_LABEL[kind] ?? '文件';
}

/** 去掉重复/无效登记：同 artifactId 只保留第一次出现；无文件名/身份的不渲染。 */
export function normalizeFormalAttachments(attachments: readonly FormalAttachmentSummary[] | undefined): FormalAttachmentSummary[] {
  const seen = new Set<string>();
  const out: FormalAttachmentSummary[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment == null) continue;
    const artifactId = typeof attachment.artifactId === 'string' ? attachment.artifactId : '';
    const filename = typeof attachment.filename === 'string' ? attachment.filename : '';
    if (artifactId.length === 0 || filename.length === 0) continue;
    if (seen.has(artifactId)) continue;
    seen.add(artifactId);
    out.push(attachment);
  }
  return out;
}

/** 正式附件卡行：正文之后、复制/引用/收藏之前的唯一渲染入口。 */
export function GeneratedFiles({
  attachments,
  onOpen,
}: {
  attachments: readonly FormalAttachmentSummary[] | undefined;
  onOpen?: (att: FormalAttachmentSummary) => void;
}) {
  const files = normalizeFormalAttachments(attachments);
  if (files.length === 0) return null;
  return (
    <div className="msg-inline-attachments" data-zs-inline-attachments="1">
      {files.map((attachment) => {
        const kindLabel = attachmentKindLabel(attachment.kind);
        const size = typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0
          ? formatBytes(attachment.sizeBytes)
          : null;
        return (
          <button
            key={attachment.artifactId}
            type="button"
            className={`inline-file-chip${attachment.kind === 'image_file' ? ' is-image' : ''}`}
            data-zs-artifact-id={attachment.artifactId}
            title={`打开 ${attachment.filename}（${kindLabel}${size != null ? ` · ${size}` : ''}）· 只读预览，不发送给 AI`}
            onClick={() => onOpen?.(attachment)}
          >
            <Icon name={attachment.kind === 'image_file' ? 'image' : 'file-text'} size={12} />
            <span className="truncate">{attachment.filename}</span>
            {size != null ? <span className="inline-file-kind">{size}</span> : null}
            <span className="inline-file-kind">{kindLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
