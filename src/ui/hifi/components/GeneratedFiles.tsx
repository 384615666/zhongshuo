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
import type { MessageFileChange } from '../../../contracts/messageFileChanges.ts';
import { MessageChangedFiles } from './MessageChangedFiles';
import { humanFacingFile } from '../../../contracts/messageFileChanges.ts';
import { attachmentKindLabel } from '../lib/attachmentKindLabel';

/**
 * 附件 kind → 中文标签（导出共享，r55）：回复芯片与根消息（线程锚消息）独立渲染路径
 * 用同一映射——此前锚消息路径只认 code/text，PPT（幻灯）/CSV（表格→sheet_file）都
 * 显示成「文本」（用户短测 T5 确认的呈现缺陷）。
 */
export { ATTACHMENT_KIND_LABEL, attachmentKindLabel } from '../lib/attachmentKindLabel';

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
  out.sort((a, b) => Number(Boolean(a.detailMarkdown)) - Number(Boolean(b.detailMarkdown)));
  return out;
}

/** 正式附件卡行：正文之后、复制/引用/收藏之前的唯一渲染入口。 */
export function GeneratedFiles({
  attachments,
  changes,
  onOpen,
  nonFinal = false,
}: {
  attachments: readonly FormalAttachmentSummary[] | undefined;
  changes?: readonly MessageFileChange[];
  onOpen?: (att: FormalAttachmentSummary) => void;
  /** Observed after an incomplete/UNKNOWN turn; readable evidence, never final delivery. */
  nonFinal?: boolean;
}) {
  const files = normalizeFormalAttachments(attachments);
  const normalizedPath = (value: string | undefined): string | null =>
    value == null ? null : value.replaceAll('\\', '/').replaceAll(/\/+/g, '/').toLowerCase();
  const preferredDocuments = files.filter((file) =>
    file.document === true && (file.revision ?? 0) > 1,
  );
  const samePath = (left: string | undefined, right: string | undefined): boolean => {
    const normalizedLeft = normalizedPath(left);
    const normalizedRight = normalizedPath(right);
    return normalizedLeft != null && normalizedRight != null && normalizedLeft === normalizedRight;
  };
  const documentMatchesChangePath = (doc: FormalAttachmentSummary, change: MessageFileChange): boolean => {
    if (doc.sourcePath != null) return samePath(doc.sourcePath, change.path);
    // A pathless hosted document cannot claim several same-content files. Both
    // registered source paths and change rows participate in the ambiguity check.
    const candidatePaths = new Set([
      ...files.filter(file => file.document !== true && file.hash === doc.hash && file.filename === doc.filename)
        .map(file => normalizedPath(file.sourcePath)),
      ...(changes ?? []).filter(file => file.afterHash === doc.hash && file.displayName === doc.filename)
        .map(file => normalizedPath(file.path)),
    ].filter((path): path is string => path != null));
    return candidatePaths.size === 1 && change.artifactId != null
      && samePath(files.find(file => file.artifactId === change.artifactId)?.sourcePath, change.path);
  };
  const changeMatchesPreferredDocument = (change: MessageFileChange, doc: FormalAttachmentSummary): boolean =>
    doc.artifactId !== change.artifactId
    && doc.hash === change.afterHash
    && doc.filename === change.displayName
    && documentMatchesChangePath(doc, change);
  const matchedPreferredDocument = (change: MessageFileChange): boolean =>
    preferredDocuments.some((doc) => changeMatchesPreferredDocument(change, doc));
  const fileIsSupersededByPreferredDocument = (file: FormalAttachmentSummary): boolean => {
    if (file.document === true) return false;
    return preferredDocuments.some((doc) =>
      doc.artifactId !== file.artifactId
      && doc.hash === file.hash
      && doc.filename === file.filename
      && (
        samePath(doc.sourcePath, file.sourcePath)
        || (changes ?? []).some((change) =>
          change.artifactId === file.artifactId
          && changeMatchesPreferredDocument(change, doc)
          && samePath(change.path, file.sourcePath))
      ),
    );
  };
  // Keep real change evidence even when a versioned document owns the visible card.
  const visibleChanges = changes ?? [];
  const visibleFiles = files.filter((file) => !fileIsSupersededByPreferredDocument(file));
  if (files.length === 0 && !changes?.length) return null;
  if (visibleFiles.length === 0 && visibleChanges.length === 0) return null;
  const linkedIds = new Set(visibleChanges.flatMap(file => file.artifactId ? [file.artifactId] : []));
  const hostedDuplicate = (file: FormalAttachmentSummary): boolean => {
    if (file.document === true && (file.revision ?? 0) > 1) return false;
    if (file.document !== true && file.detailMarkdown !== true) return false;
    return visibleChanges.some((change) => {
      if (change.artifactId === file.artifactId || change.afterHash == null || change.afterHash !== file.hash || change.displayName !== file.filename) return false;
      const real = files.find((candidate) => candidate.artifactId === change.artifactId);
      if (real == null || real.document === true || real.detailMarkdown === true) return false;
      return documentMatchesChangePath(file, change);
    });
  };
  const standaloneFiles = visibleFiles.filter(file => !linkedIds.has(file.artifactId) && !hostedDuplicate(file));
  const documentFiles = standaloneFiles.filter(file => file.document === true || humanFacingFile(file.filename));
  const preferredChanges = new Map(documentFiles.flatMap(doc => {
    const change = visibleChanges.find(change => changeMatchesPreferredDocument(change, doc));
    return change == null ? [] : [[doc.artifactId, change] as const];
  }));
  const suppressedCardIds = new Set(visibleChanges.filter(matchedPreferredDocument).map(change => change.id));
  const cardContents = [
    ...documentFiles.map(file => ({name: file.filename, hash: file.hash})),
    ...visibleChanges.filter(file => file.humanFacing && file.state !== 'removed' && !suppressedCardIds.has(file.id))
      .map(file => ({name: file.displayName, hash: file.afterHash})),
  ];
  // Distinguish proven different contents only; names never determine identity.
  const distinctContentNames = new Set(cardContents.filter(file => file.hash != null && cardContents.some(other =>
    other.name.toLowerCase() === file.name.toLowerCase() && other.hash != null && other.hash !== file.hash,
  )).map(file => file.name.toLowerCase()));
  return (
    <div className="msg-inline-attachments" data-zs-inline-attachments="1">
      <MessageChangedFiles changes={visibleChanges} attachments={files} documents={documentFiles} documentChanges={preferredChanges} suppressedCardIds={suppressedCardIds} distinctContentNames={distinctContentNames} onOpen={onOpen} nonFinal={nonFinal}/>
      {standaloneFiles.filter(file => !documentFiles.includes(file)).map((attachment) => {
        const isDocument = attachment.document === true;
        const kindLabel = isDocument ? '文档' : attachment.detailMarkdown ? '完整详情' : attachmentKindLabel(attachment.kind);
        const size = typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0
          ? formatBytes(attachment.sizeBytes)
          : null;
        return (
          <button
            key={attachment.artifactId}
            type="button"
            className={`inline-file-chip${attachment.kind === 'image_file' ? ' is-image' : ''}${attachment.detailMarkdown ? ' is-detail' : ''}${isDocument ? ' is-document' : ''}`}
            data-zs-artifact-id={attachment.artifactId}
            data-zs-document={isDocument ? '1' : undefined}
            title={`打开 ${attachment.filename}（${isDocument ? attachment.purpose ?? '模型生成的业务文档' : attachment.detailMarkdown ? '完整 Markdown 详情' : kindLabel}${size != null ? ` · ${size}` : ''}）· 只读预览，不发送给 AI`}
            onClick={() => onOpen?.(attachment)}
          >
            <Icon name={attachment.kind === 'image_file' ? 'image' : 'file-text'} size={12} />
            <span className="truncate">{attachment.filename}</span>
            {attachment.revision != null ? <span className="inline-file-kind">v{attachment.revision}</span> : null}
            {size != null ? <span className="inline-file-kind">{size}</span> : null}
            {nonFinal ? <span className="inline-file-kind" data-zs-non-final-file="1">非最终</span> : null}
            <span className="inline-file-kind">{kindLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
