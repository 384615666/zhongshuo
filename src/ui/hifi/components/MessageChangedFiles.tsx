import { userFacingSystemText } from '../../../contracts/userFacingText';
import {useEffect, useState} from 'react';
import type {MessageFileChange} from '../../../contracts/messageFileChanges.ts';
import type {ChangeSnapshot} from '../../../contracts/changeSnapshot.ts';
import type {FormalAttachmentSummary} from '../data/types';
import {command} from '../bridge';
import {MarkdownView} from '../preview/MarkdownView';
import {DiffText} from '../preview/DiffText';
import {Icon} from './Icon';
import {Menu, MenuItem, Modal} from './ui';
import {formatBytes} from '../lib/format';
import {attachmentKindLabel} from '../lib/attachmentKindLabel';
import {useStore, toast} from '../shell';
import {
  absoluteProjectPath, copyTextToClipboard, localFileOpeners, openLocalFileWith, openLocalFileDefault, revealLocalFile,
  type LocalFileOpener,
} from '../lib/localOpen';

const stateLabel = {added: '新增', modified: '已更新', removed: '已删除', unknown: '相关文件'};

/**
 * Select the exact registered change artifact first. The hash/path fallback is
 * only for legacy rows that predate artifact_id and never substitutes a hosted
 * document merely because it sorts earlier in the array.
 */
export function attachmentForChange(
  file: MessageFileChange,
  attachments: readonly FormalAttachmentSummary[],
): FormalAttachmentSummary | undefined {
  const exact = file.artifactId == null ? undefined : attachments.find((att) => att.artifactId === file.artifactId);
  if (exact != null) return exact;
  if (file.afterHash == null) return undefined;
  const candidates = attachments.filter((att) =>
    att.hash === file.afterHash
    && att.filename === file.displayName
    && att.sourcePath != null
    && file.path.replaceAll('\\', '/') === att.sourcePath.replaceAll('\\', '/'));
  return candidates.find((att) => att.document !== true && att.detailMarkdown !== true) ?? candidates[0];
}

/** Only a captured added/modified/removed state establishes a real comparison. */
export function hasFileDiff(file: MessageFileChange): boolean {
  return file.changeSetId != null && file.state !== 'unknown';
}

export function MessageChangedFiles({changes, attachments, documents = [], documentChanges, suppressedCardIds, distinctContentNames, onOpen, nonFinal = false, projectId}: {
  changes: readonly MessageFileChange[];
  attachments: readonly FormalAttachmentSummary[];
  onOpen?: (attachment: FormalAttachmentSummary) => void;
  documents?: readonly FormalAttachmentSummary[];
  documentChanges?: ReadonlyMap<string, MessageFileChange>;
  suppressedCardIds?: ReadonlySet<string>;
  distinctContentNames?: ReadonlySet<string>;
  nonFinal?: boolean;
  /** R170：消息所属项目——文件卡展开菜单用它把项目内相对路径还原成绝对路径。 */
  projectId?: string;
}) {
  const projects = useStore((state) => state.projects);
  const [selected, setSelected] = useState<{file: MessageFileChange; mode: 'content' | 'diff'} | null>(null);
  const [snapshot, setSnapshot] = useState<ChangeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** R170 第 11 项：文件卡「打开」右侧的展开菜单（打开方式 + 复制路径）。 */
  const [openMenu, setOpenMenu] = useState<{ x: number; y: number; label: string; relativePath: string; absolutePath: string } | null>(null);
  const [openers, setOpeners] = useState<LocalFileOpener[] | null>(null);
  useEffect(() => {
    setSnapshot(null); setError(null);
    if (!selected?.file.changeSetId) return;
    let alive = true;
    const file = selected.file;
    void command<ChangeSnapshot>('changeset.readSnapshot', {projectId: file.projectId, taskId: file.taskId, changeSetId: file.changeSetId, path: file.path})
      .then(value => {if (alive) setSnapshot(value);}, reason => {if (alive) setError(reason instanceof Error ? reason.message : String(reason));});
    return () => {alive = false;};
  }, [selected]);
  useEffect(() => {
    if (openMenu == null) return;
    let alive = true;
    setOpeners(null);
    void localFileOpeners(openMenu.absolutePath).then((items) => { if (alive) setOpeners(items); });
    return () => { alive = false; };
  }, [openMenu]);
  if (!changes.length && !documents.length) return null;
  const findAttachment = (file: MessageFileChange): FormalAttachmentSummary | undefined => attachmentForChange(file, attachments);
  const open = (file: MessageFileChange): void => {
    const att = findAttachment(file);
    if (att && onOpen) onOpen(att); else if (file.changeSetId) setSelected({file, mode: 'content'});
  };
  const projectRootOf = (projectId: string): string | undefined => projects.find((project) => project.id === projectId)?.canonicalPath;
  /**
   * 打开方式菜单只对**项目里的真实文件**出现：工作区文件与改名记录带项目内相对路径，
   * 托管文档（document/detailMarkdown）没有磁盘路径，只保留预览（不伪造“打开文件夹”）。
   */
  const openMenuFor = (target: HTMLElement, projectId: string, relativePath: string | null | undefined, label: string): void => {
    if (relativePath == null || relativePath === '') return;
    const absolutePath = absoluteProjectPath(projectRootOf(projectId), relativePath);
    if (absolutePath == null) return;
    const rect = target.getBoundingClientRect();
    setOpeners(null);
    setOpenMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4), label, relativePath, absolutePath });
  };
  const copyPath = (text: string, label: string): void => {
    void copyTextToClipboard(text).then((ok) => toast(ok ? `已复制${label}：${text}` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
  };
  const runOpener = (opener: LocalFileOpener, absolutePath: string): void => {
    if(opener.kind==='default'){
      void openLocalFileDefault(absolutePath).then(result=>{if(!result.ok)toast(`打开失败：${userFacingSystemText(result.error??'')}`,'error');});
      return;
    }
    if (opener.kind === 'explorer') {
      void revealLocalFile(absolutePath).then((result) => { if (!result.ok) toast(`打开文件夹失败：${userFacingSystemText(result.error ?? '')}`, 'error'); });
      return;
    }
    void openLocalFileWith(opener.id, absolutePath).then((result) => { if (!result.ok) toast(`打开失败：${userFacingSystemText(result.error ?? '')}`, 'error'); });
  };
  const counts = (file: MessageFileChange) => file.addedLines != null && file.removedLines != null
    ? <span className="file-change-counts"><span>+{file.addedLines}</span> <span>−{file.removedLines}</span></span> : null;
  const sourceNote = (attachment?: FormalAttachmentSummary, file?: MessageFileChange) => {
    const name = attachment?.filename ?? file?.displayName;
    if (name == null || !distinctContentNames?.has(name.toLowerCase())) return null;
    const hosted = attachment?.document === true || attachment?.detailMarkdown === true;
    const path = hosted ? undefined : attachment?.sourcePath ?? file?.path;
    return <span className="small faint" data-zs-file-source={hosted ? 'reply' : path ? 'project' : 'attachment'}>
      {hosted ? '回复附稿' : path ? `项目文件 · ${path}` : '文件附件'}
    </span>;
  };
  const openSplit = (attachment: FormalAttachmentSummary | undefined, file: MessageFileChange | undefined, onPrimary: () => void, primaryAttrs?: Record<string, string | undefined>, primaryDisabled?: boolean) => {
    const relativePath = attachment?.sourcePath ?? file?.path ?? null;
    const hosted = attachment?.document === true || attachment?.detailMarkdown === true;
    const cardProjectId = file?.projectId ?? projectId ?? '';
    const canOpenWith = !hosted && relativePath != null && relativePath !== '' && projectRootOf(cardProjectId) != null;
    const disabled = primaryDisabled ?? (attachment == null && file?.changeSetId == null);
    return (
      <span className={`open-split${canOpenWith ? ' is-split' : ''}`}>
        <button type="button" className="btn sm" {...primaryAttrs} disabled={disabled} onClick={onPrimary}>打开</button>
        {canOpenWith ? (
          <button
            type="button"
            className="btn sm open-split-caret"
            aria-label="其他打开方式"
            aria-haspopup="menu"
            title="其他打开方式 / 复制路径"
            data-zs-open-more={file?.id ?? attachment?.artifactId ?? ''}
            onClick={(event) => openMenuFor(event.currentTarget, cardProjectId, relativePath, attachment?.filename ?? file?.displayName ?? '文件')}
          >
            <Icon name="chevron-down" size={11} />
          </button>
        ) : null}
      </span>
    );
  };
  return <>
    <div className="message-document-cards">
      {documents.map(attachment => {
        const change = documentChanges?.get(attachment.artifactId);
        return <div className="message-document-card" key={attachment.artifactId} data-zs-artifact-id={attachment.artifactId} data-zs-document={attachment.document ? '1' : undefined}>
          <Icon name={attachment.kind === 'image_file' ? 'image' : 'file-text'} size={20}/>
          <div className="message-document-description"><strong title={attachment.sourcePath ?? attachment.filename}>{attachment.filename}</strong>
            <span className="small faint">{attachment.document ? '文档 · ' : attachment.detailMarkdown ? '完整详情 · ' : ''}{attachmentKindLabel(attachment.kind)}{attachment.revision != null ? ` · v${attachment.revision}` : ''}{attachment.sizeBytes != null && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0 ? ` · ${formatBytes(attachment.sizeBytes)}` : ''}{change ? ` · ${stateLabel[change.state]}` : ''}</span>
            {sourceNote(attachment, change)}
            {attachment.purpose ? <span className="small faint">{attachment.purpose}</span> : null}
            {nonFinal ? <span className="small faint" data-zs-non-final-file="1">非最终</span> : null}
          </div>
          {/* R171 第 5 项：「打开」固定在最右侧；「查看变更」在它左边。 */}
          {change && hasFileDiff(change) ? <button type="button" className="btn ghost sm" onClick={() => setSelected({file: change, mode: 'diff'})}>查看变更</button> : null}
          {openSplit(attachment, change, () => onOpen?.(attachment), { 'data-zs-attachment-open': attachment.artifactId, 'aria-label': `打开 ${attachment.filename}` }, onOpen == null)}
        </div>;
      })}
      {changes.filter(file => file.humanFacing && file.state !== 'removed' && !suppressedCardIds?.has(file.id)).map(file => {
        const attachment = findAttachment(file);
        const hosted = attachment?.document === true || attachment?.detailMarkdown === true;
        return <div className="message-document-card" key={file.id} data-zs-document-change={file.id} data-zs-artifact-id={attachment?.artifactId}>
          <Icon name="file-text" size={20}/>
          <div className="message-document-description"><strong title={file.path}>{file.displayName}</strong>
            <span className="small faint">{stateLabel[file.state]} · {attachmentKindLabel(attachment?.kind ?? '')}{file.revision != null ? ` · v${file.revision}` : ''}{file.executionStatus !== 'SUCCEEDED' ? ' · 尚未完成交付' : ''}</span>
            {sourceNote(attachment, file)}
            {nonFinal ? <span className="small faint" data-zs-non-final-file="1">非最终</span> : null}
          </div>
          {hasFileDiff(file) ? <button type="button" className="btn ghost sm" onClick={() => setSelected({file, mode: 'diff'})}>查看变更</button> : null}
          {openSplit(attachment, file, () => (hosted && attachment ? onOpen?.(attachment) : open(file)), { 'data-zs-change-open': file.id, 'data-zs-change-artifact-id': file.artifactId ?? '' })}
        </div>;
      })}
    </div>
    {changes.length ? <details className="message-file-changes" data-zs-file-changes="1">
      <summary>{changes.length} 个文件涉及本轮工作</summary>
      <div className="message-file-change-list">{changes.map(file => <div className="message-file-change-row" key={file.id} data-zs-change-path={file.path}>
        <div className="message-document-description"><span title={file.path}>{file.path}</span><span className="small faint">{stateLabel[file.state]}</span></div>
        {counts(file)}
        {hasFileDiff(file) ? <button type="button" className="btn ghost sm" onClick={() => setSelected({file, mode: 'diff'})}>查看变更</button> : null}
        {findAttachment(file) && file.state !== 'removed' ? <button type="button" className="btn ghost sm" onClick={() => open(file)}>打开</button> : null}
      </div>)}</div>
    </details> : null}

    {openMenu ? (
      <Menu anchor={{ x: openMenu.x, y: openMenu.y }} onClose={() => setOpenMenu(null)}>
        <div className="menu-label">{openMenu.label}</div>
        {openers != null && openers.length > 0 ? <div className="local-open-menu-label">打开方式</div> : null}
        {(openers ?? []).map((opener) => (
          <MenuItem
            key={opener.id}
            icon={opener.kind === 'explorer' ? 'folder' : 'external-link'}
            title={opener.kind === 'explorer' ? '在资源管理器中选中这个文件' : `用 ${opener.label} 打开这个文件`}
            onClick={() => { setOpenMenu(null); runOpener(opener, openMenu.absolutePath); }}
          >
            {opener.label}
          </MenuItem>
        ))}
        {openers == null ? <div className="local-open-menu-label">正在查找本机程序…</div> : null}
        <div className="local-open-menu-sep" />
        <MenuItem icon="copy" title="复制这个文件在项目里的相对路径" onClick={() => { setOpenMenu(null); copyPath(openMenu.relativePath, '相对路径'); }}>复制相对路径</MenuItem>
        <MenuItem icon="copy" title="复制这个文件在本机的完整路径" onClick={() => { setOpenMenu(null); copyPath(openMenu.absolutePath, '绝对路径'); }}>复制绝对路径</MenuItem>
      </Menu>
    ) : null}

    {selected ? <Modal title={`${selected.file.displayName} · ${selected.mode === 'diff' ? '查看变更' : '文件内容'}`} size="xl" onClose={() => setSelected(null)}>
      {error ? <div role="alert">读取失败：{userFacingSystemText(error ?? '')}</div> : !snapshot ? <div>正在读取文件…</div> : selected.mode === 'content' ? <>
        {snapshot.content?.after.text != null ? <MarkdownView text={snapshot.content.after.text}/> : <div>{userFacingSystemText(snapshot.content?.after.reason ?? '这份文件没有可预览的文本，可查看变更记录。')}</div>}
      </> : (
        /* R170 第 10 项：查看变更用行级彩色对比（绿色新增 / 红色删除），不再是两段纯文本。 */
        <div className="message-file-diff">
          <DiffText left={snapshot.content?.before.text} right={snapshot.content?.after.text} leftLabel="修改前" rightLabel="修改后" />
          {(['before','after'] as const).map(side=>snapshot.content?.[side].text==null&&snapshot.content?.[side].reason?<p className="small faint" key={side}>{side==='before'?'修改前':'修改后'}：{userFacingSystemText(snapshot.content[side].reason)}</p>:null)}
        </div>
      )}
    </Modal> : null}
  </>;
}
