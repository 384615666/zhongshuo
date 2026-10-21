import {useEffect, useState} from 'react';
import type {MessageFileChange} from '../../../contracts/messageFileChanges.ts';
import type {ChangeSnapshot} from '../../../contracts/changeSnapshot.ts';
import type {FormalAttachmentSummary} from '../data/types';
import {command} from '../bridge';
import {MarkdownView} from '../preview/MarkdownView';
import {Icon} from './Icon';
import {Modal} from './ui';

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

export function MessageChangedFiles({changes, attachments, onOpen}: {
  changes: readonly MessageFileChange[];
  attachments: readonly FormalAttachmentSummary[];
  onOpen?: (attachment: FormalAttachmentSummary) => void;
}) {
  const [selected, setSelected] = useState<{file: MessageFileChange; mode: 'content' | 'diff'} | null>(null);
  const [snapshot, setSnapshot] = useState<ChangeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSnapshot(null); setError(null);
    if (!selected?.file.changeSetId) return;
    let alive = true;
    const file = selected.file;
    void command<ChangeSnapshot>('changeset.readSnapshot', {projectId: file.projectId, taskId: file.taskId, changeSetId: file.changeSetId, path: file.path})
      .then(value => {if (alive) setSnapshot(value);}, reason => {if (alive) setError(reason instanceof Error ? reason.message : String(reason));});
    return () => {alive = false;};
  }, [selected]);
  if (!changes.length) return null;
  const findAttachment = (file: MessageFileChange): FormalAttachmentSummary | undefined => attachmentForChange(file, attachments);
  const open = (file: MessageFileChange): void => {
    const att = findAttachment(file);
    if (att && onOpen) onOpen(att); else if (file.changeSetId) setSelected({file, mode: 'content'});
  };
  const counts = (file: MessageFileChange) => file.addedLines != null && file.removedLines != null
    ? <span className="file-change-counts"><span>+{file.addedLines}</span> <span>−{file.removedLines}</span></span> : null;
  return <>
    <div className="message-document-cards">
      {changes.filter(file => file.humanFacing && file.state !== 'removed').map(file => <div className="message-document-card" key={file.id} data-zs-document-change={file.id}>
        <Icon name="file-text" size={20}/>
        <div className="message-document-description"><strong title={file.path}>{file.displayName}</strong>
          <span className="small faint">{stateLabel[file.state]}{file.revision != null ? ` · v${file.revision}` : ''}{file.executionStatus !== 'SUCCEEDED' ? ' · 尚未完成交付' : ''}</span>
        </div>
        <button type="button" className="btn sm" data-zs-change-open={file.id} data-zs-change-artifact-id={file.artifactId ?? ''} disabled={findAttachment(file) == null && !file.changeSetId} onClick={() => open(file)}>打开</button>
        {file.changeSetId ? <button type="button" className="btn ghost sm" onClick={() => setSelected({file, mode: 'diff'})}>查看变更</button> : null}
      </div>)}
    </div>
    <details className="message-file-changes" data-zs-file-changes="1">
      <summary>{changes.length} 个文件涉及本轮工作</summary>
      <div className="message-file-change-list">{changes.map(file => <div className="message-file-change-row" key={file.id} data-zs-change-path={file.path}>
        <div className="message-document-description"><span title={file.path}>{file.path}</span><span className="small faint">{stateLabel[file.state]}</span></div>
        {counts(file)}
        {findAttachment(file) && file.state !== 'removed' ? <button type="button" className="btn ghost sm" onClick={() => open(file)}>打开</button> : null}
        {file.changeSetId ? <button type="button" className="btn ghost sm" onClick={() => setSelected({file, mode: 'diff'})}>查看变更</button> : null}
      </div>)}</div>
    </details>
    {selected ? <Modal title={`${selected.file.displayName} · ${selected.mode === 'diff' ? '查看变更' : '文件内容'}`} size="xl" onClose={() => setSelected(null)}>
      {error ? <div role="alert">读取失败：{error}</div> : !snapshot ? <div>正在读取这次保存的文件版本…</div> : selected.mode === 'content' ? <>
        {snapshot.content?.after.text != null ? <MarkdownView text={snapshot.content.after.text}/> : <div>{snapshot.content?.after.reason ?? '这份文件没有可预览的文本快照，可查看变更记录。'}</div>}
      </> : <div className="message-file-diff">
        {(['before', 'after'] as const).map(side => <section key={side}><strong>{side === 'before' ? '修改前' : '修改后'}</strong>
          {snapshot.content?.[side].text != null ? <pre>{snapshot.content[side].text}</pre> : <p>{snapshot.content?.[side].reason ?? '此侧没有可预览的文本快照'}</p>}
        </section>)}
      </div>}
    </Modal> : null}
  </>;
}
