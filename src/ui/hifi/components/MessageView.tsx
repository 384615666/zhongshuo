/**
 * 消息渲染（§17.3 消息类型）
 *
 * 口径要点：
 *  - 流式消息用稳定 messageId 原地更新，终结时保存完整版本
 *  - 成员进度、分工、争议、结果都在线程内，不向主池追加独立消息
 *  - 表情不是授权或共识记录；授权按钮与表情分开呈现
 *  - E3：点子任务卡 = 定向跟进该子任务
 */

import { useId, useMemo, useRef, useState } from 'react';
import {chatAnswer} from '../../../contracts/chatAnswer';
import {navigate} from '../lib/router';
import { Icon } from './Icon';
import { Avatar, ConsensusTag, CostText, Tag, memberColor } from './ui';
import { clockTime, formatDuration, formatTokens, resultConsensusLabel, stageCopy, stageLabel } from '../lib/format';
import type { CollaborationStage, Message, ProjectMember, RouteMode } from '../data/types';
import { recordLocalOnly, stripInlineAttachmentTokens, useStore } from '../data/store';
import { attachmentsOfMessage, resourceOf, revisionOf } from '../lib/resource';
import type { FormalAttachmentSummary } from '../data/types';
import { MarkdownView, outlineOf } from '../preview/MarkdownView';
import { ATTACHMENT_KIND_LABEL, GeneratedFiles, normalizeFormalAttachments } from './GeneratedFiles';

/* 兼容既有导入路径（Room.tsx / ThreadPage.tsx 从 MessageView 取中文 kind 映射）。 */
export { ATTACHMENT_KIND_LABEL };

/* ---------------- 研讨阶段标签（R91 模块3） ---------------- */

/**
 * 后端 `body_json.collaborationStage` 只允许变成**简短中文标签 + 轮次**：
 * 内部阶段枚举（INDEPENDENT/CROSS_REVIEW/...）不得裸露，turnId/runId 不展示，
 * 原 JSON 更不渲染。未知阶段名走「研讨发言」，不把内部字符串直接丢给用户。
 */
export function collaborationStageText(mark: CollaborationStage): string {
  const shifted = mark.stage.toUpperCase();
  const mapped = stageLabel(shifted);
  const readable = Object.values(stageCopy).includes(mapped) || /[\u4e00-\u9fff]/.test(mapped) ? mapped : '研讨发言';
  const round = typeof mark.roundNo === 'number' && Number.isFinite(mark.roundNo) && mark.roundNo > 0 ? ` · 第${Math.floor(mark.roundNo)}轮` : '';
  return `${readable}${round}`;
}

/* ---------------- 消息携带的资源（UX-PREVIEW-01） ---------------- */

/**
 * 把消息附件渲染成**可点击的文件 chip**（原型 resources 通道，UX-PREVIEW-01）。
 *
 * 修复的确切缺口：此前 Composer 的附件只是 `{name, size}`，
 * 从不落进消息，`MessageView` 里也没有任何可点击的文件名 ——
 * 于是"点对话里的文件名打开预览"这条交互**没有落点**。
 *
 * 现在附件经 `Message.attachmentIds` 关联到资源，chip 显示真实标题与版本。
 * 无 taskId 的主池消息同样渲染（§17.9 第 1 条）。
 */
function MessageAttachments({
  message, onOpen, excludeIds,
}: {
  message: Message;
  onOpen?: (resourceId: string, revision?: number) => void;
  excludeIds?: ReadonlySet<string>;
}) {
  const s = useStore((x) => x);
  const links = attachmentsOfMessage(s, message.id).filter((link) => !excludeIds?.has(link.resourceId));
  if (links.length === 0) return null;

  return (
    <div className="msg-attach-row">
      {links.map((link) => {
        const res = resourceOf(s, link.resourceId);
        if (!res) return null;
        const rev = revisionOf(res, link.revision);
        const kindLabel =
          rev?.content.kind === 'image' ? '图片'
            : rev?.content.kind === 'markdown' ? 'Markdown'
              : rev?.content.kind === 'csv' ? 'CSV'
                : rev?.content.kind === 'code' ? '代码'
                  : rev?.content.kind === 'diff' ? 'diff'
                    : rev?.content.kind === 'unsupported' ? '不支持预览'
                      : '文本';
        return (
          <button
            key={link.id}
            className="msg-attach"
            title={`打开 ${res.title}（v${link.revision}）· 只读预览，不发送给 AI`}
            onClick={() => onOpen?.(link.resourceId, link.revision)}
          >
            <Icon name="file-text" size={12} />
            <span className="truncate">{res.title}</span>
            {!res.mutable ? <span className="msg-attach-kind mono-sm">v{link.revision}</span> : null}
            <span className="msg-attach-kind">{kindLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- 单条消息 ---------------- */

function DeliveryFacts({ delivery }: { delivery?: Message['delivery'] }) {
  if (delivery == null) return null;
  const labels = {
    delivered: '已交付',
    delivered_with_questions: '已交付 · 有待确认',
    needs_user: '等待你补充',
    blocked: '交付未完成',
    legacy: '本轮已结束 · 旧格式',
  } as const;
  const tone = delivery.status === 'blocked' ? 'danger' : delivery.status === 'needs_user' || delivery.status === 'delivered_with_questions' ? 'warning' : delivery.status === 'legacy' ? 'neutral' : 'success';
  const consensus = delivery.overallConsensus === 'disputed' ? '仍有分歧'
    : delivery.overallConsensus === 'unconfirmed' ? '仍有成员未确认'
      : delivery.overallConsensus === 'qualified' ? '附条件确认' : null;
  const feedback = delivery.feedback?.find((item) => item.status === 'needs_revision')
    ?? delivery.feedback?.find((item) => item.status === 'needs_user');
  const issue = delivery.issueResolutions?.find((item) => item.status === 'needs_user')
    ?? delivery.issueResolutions?.find((item) => item.status === 'insufficient_evidence');
  const action = (feedback?.question ? `${feedback.question}${feedback.owner ? `（责任方：${feedback.owner}）` : ''}` : '')
    || feedback?.revisionRequest
    || (issue?.question ? `${issue.question}${issue.owner ? `（责任方：${issue.owner}）` : ''}` : '')
    || feedback?.reason || issue?.reason;
  return (
    <div className="row tight wrap" data-zs-delivery-state={delivery.status}>
      <Tag tone={tone} icon={delivery.status === 'blocked' ? 'alert-triangle' : 'check-circle'}>{labels[delivery.status]}</Tag>
      {consensus != null ? <span className="small faint">{consensus}</span> : null}
      {delivery.unresolvedIssues?.length ? <span className="small faint">{delivery.unresolvedIssues.length} 项未解决</span> : null}
      {action ? <span className="small" style={{ overflowWrap: 'anywhere' }}>{action}</span> : null}
    </div>
  );
}

export function MessageView({
  message,
  domId,
  author,
  isMentioned,
  readingAids,
  mode,
  onOpenSubtask,
  onOpenArtifact,
  onOpenAttachment,
  onOpenResource,
  onSave,
  onApproval,
  onRetry,
  onAllowMissing,
  onSteer,
  onQuote,
}: {
  message: Message;
  domId?:string;
  linkThreadId?:string;
  author?: ProjectMember;
  isMentioned?: boolean;
  readingAids?: boolean;
  mode?: RouteMode;
  onOpenSubtask?: (subtask: { taskId: string; number: number; title: string }) => void;
  onOpenThread?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenResource?: (resourceId: string, revision?: number) => void;
  onOpenAttachment?: (att: FormalAttachmentSummary) => void;
  onReact?: (emoji: string) => void;
  onSave?: () => void;
  onConvertToTask?: () => void;
  onApproval?: (choice: 'allow_once' | 'deny') => void;
  onRetry?: () => void;
  onAllowMissing?: () => void;
  onSteer?: () => void;
  onQuote?: (message: Message) => void;
  onCorrection?: (message: Message) => void;
}) {
  const [copyState,setCopyState]=useState<'idle'|'copied'|'failed'>('idle');
  const visibleBody=chatAnswer(stripInlineAttachmentTokens(message.body),message.authorType);
  const isSystem = message.authorType === 'system';
  const isHuman = message.authorType === 'human';
  const formalAttachments = normalizeFormalAttachments(message.formalAttachments);
  const hasDetail = formalAttachments.some((attachment) => attachment.detailMarkdown === true) || typeof message.detailMarkdown === 'string';
  const roleClass=isSystem?' msg-system':isHuman?' msg-human':' msg-agent';
  const copyMessage=async():Promise<void>=>{
    try{
      if(navigator.clipboard==null)throw Error('clipboard unavailable');
      const attachmentCopy = (message.formalAttachments ?? []).map((attachment) => attachment.filename).join('\n');
      await navigator.clipboard.writeText([visibleBody, attachmentCopy].filter((part) => part.trim().length > 0).join('\n'));
      setCopyState('copied');
      window.setTimeout(()=>setCopyState('idle'),1400);
    }catch{
      setCopyState('failed');
      window.setTimeout(()=>setCopyState('idle'),1800);
    }
  };
  const messageContent = (
    <>
      <MessageBody message={message} mode={mode} readingAids={readingAids === true} hasDetail={hasDetail} memberName={author?.displayName} onOpenSubtask={onOpenSubtask} onOpenArtifact={onOpenArtifact} onApproval={onApproval} />
      {typeof message.detailMarkdown === 'string' && message.detailMarkdown.trim().length > 0 ? (
        <details className="msg-detail-fallback">
          <summary>完整详情（附件不可用，原文已保留）</summary>
          <div className="msg-detail-fallback-body"><MarkdownView text={message.detailMarkdown} specTables={readingAids === true} headingAnchors={readingAids === true} /></div>
        </details>
      ) : null}
      <DeliveryFacts delivery={message.delivery} />
      <MessageFooter message={message} formalAttachments={formalAttachments} onOpenAttachment={onOpenAttachment} onOpenResource={onOpenResource} />
    </>
  );
  return (
    <div className={`msg${roleClass}${isSystem ? ' system' : ''}${isMentioned ? ' mention-me' : ''}`} id={domId??`msg-${message.id}`}>
      <div className="msg-avatar">
        {isSystem ? (
          <span className="avatar avatar-22" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-3)', border: '1px solid var(--border)' }} title="系统消息">
            <Icon name="settings" size={12} />
          </span>
        ) : (
          <Avatar name={isHuman ? '我' : author?.displayName ?? '?'} ordinal={author?.ordinal} color={memberColor(isHuman ? 'you' : author?.id ?? '', author?.ordinal)} size={22} state={author?.workState} stateTitle={author?.workStateReason} subject={isHuman?'user':author!=null?`member:${author.id}`:undefined} />
        )}
      </div>
      <div className={`msg-body${isHuman ? ' is-human' : ''}`}>
        {isSystem ? <SystemCard message={message} onRetry={onRetry} onAllowMissing={onAllowMissing} onSteer={onSteer} /> : (
          <>
            <div className="msg-head">
              {!isHuman && author != null ? <span className="msg-dot" aria-hidden="true" style={{ background: memberColor(author.id, author.ordinal) }} /> : null}
              <span className="msg-author">{isHuman ? '你' : author?.displayName ?? '未知成员'}</span>
              {!isHuman && author?.ordinal && author.ordinal > 1 ? <span className="small faint">#{author.ordinal}</span> : null}
              {message.collaborationStage != null ? <span className="msg-stage-tag"><Tag tone="info" icon="layers" title="研讨阶段产物（已完成并保存为正式消息）">{collaborationStageText(message.collaborationStage)}</Tag></span> : null}
              {!isHuman && message.kind === 'report' ? <Tag tone="accent" icon="file-text">报告</Tag> : null}
              {message.streaming ? <Tag tone="info" icon="loader">流式中</Tag> : null}
              <span className="msg-time">{clockTime(message.createdAt)}</span>
              {message.threadMessageSeq !== undefined ? <span className="msg-seq" title="串内顺序号 thread_message_seq">#{message.threadMessageSeq}</span> : null}
              {message.saved ? <Icon name="bookmark" size={11} className="faint" /> : null}
            </div>
            {isHuman && readingAids === true ? <div className="msg-human-bubble">{messageContent}</div> : messageContent}
            {message.formalReplyExecution&&message.formalReplyExecution.status!=='succeeded'?<div className="faint" data-zs-reply-execution={message.formalReplyExecution.status} role={['failed','blocked','unknown'].includes(message.formalReplyExecution.status)?'alert':undefined}>
              {message.formalReplyExecution.status==='queued'?'已发送，等待 AI 回复':message.formalReplyExecution.status==='running'?'AI 正在回复':message.formalReplyExecution.error??'本次回复未完成'}
              {['failed','blocked','unknown'].includes(message.formalReplyExecution.status)&&message.threadId?<button className="btn sm ghost" onClick={()=>navigate(message.formalReplyExecution?.status==='unknown'?'/recovery':`/thread/${encodeURIComponent(message.threadId!)}?tab=run`)}>查看{message.formalReplyExecution.status==='unknown'?'恢复状态':'运行历史'}</button>:null}
            </div>:null}
          </>
        )}
        {!isSystem?<div className="msg-actions">
          <button type="button" className="btn ghost sm msg-action-btn" aria-label="复制消息" title="复制可读正文" onClick={()=>void copyMessage()}><Icon name="copy" size={12}/> 复制</button>
          {onQuote?<button type="button" className="btn ghost sm msg-action-btn" aria-label="引用消息" title="引用到输入区" onClick={()=>onQuote(message)}><Icon name="corner-down-right" size={12}/> 引用</button>:null}
          {onSave?<button type="button" className="btn ghost sm msg-action-btn" data-zs-saved={message.saved?'1':undefined} aria-label={message.saved?'取消收藏':'收藏消息'} title={message.saved?'取消收藏':'收藏，不改动原消息'} onClick={()=>onSave()}><Icon name="bookmark" size={12}/> {message.saved?'已收藏':'收藏'}</button>:null}
          <span className="small msg-action-feedback" aria-live="polite">{copyState==='copied'?'已复制':copyState==='failed'?'复制失败':''}</span>
          {message.reactions?.length?<span className="row tight faint" aria-label="历史表情">{message.reactions.map(r=><span key={r.emoji}>{r.emoji} {r.by.length}</span>)}</span>:null}
        </div>:null}
      </div>
    </div>
  );
}

/* ---------------- 正文分派 ---------------- */

function MessageBody({
  message,
  memberName,
  hasDetail,
  readingAids,
  mode,
  onOpenSubtask,
  onOpenArtifact,
  onApproval,
}: {
  message: Message;
  memberName?: string;
  hasDetail?: boolean;
  readingAids?: boolean;
  mode?: RouteMode;
  onOpenSubtask?: (s: { taskId: string; number: number; title: string }) => void;
  onOpenArtifact?: (id: string) => void;
  onApproval?: (c: 'allow_once' | 'deny') => void;
}) {
  const visibleBody=chatAnswer(stripInlineAttachmentTokens(message.body),message.authorType);
  const a = message.payload?.assignment;
  const p = message.payload?.progress;
  const r = message.payload?.report;
  const d = message.payload?.dispute;
  const ap = message.payload?.approval;
  const res = message.payload?.result;

  return (
    <>
      {/* 正文（任何 kind 都只渲染一次；进度消息的正文同样在这里） */}
      {message.body ? (
        <MessageText message={message} text={visibleBody} readingAids={readingAids === true} hasDetail={hasDetail === true} />
      ) : null}

      {message.kind === 'progress' && p?.status ? (
        <div className="row tight wrap" style={{ marginTop: 6 }}>
          <Tag tone={p.status === 'blocked' ? 'danger' : 'warning'} icon={p.status === 'blocked' ? 'octagon' : 'clock'}>
            {p.status === 'blocked' ? '已阻塞' : '迟到纳入'}
          </Tag>
        </div>
      ) : null}

      {/* 分工卡 */}
      {a ? (
        <div className="msg-card" style={{ marginTop: 8 }}>
          <div className="msg-card-head">
            <Icon name="layers" size={13} />
            分工计划 · {a.subtasks.length} 个子任务
            <span className="spacer" />
            <span className="small faint">程序校验通过后才生成任务</span>
          </div>
          <div className="msg-card-body">
            {a.subtasks.map((st) => (
              <div
                key={st.key}
                className="subtask-row subtask-clickable"
                onClick={() => onOpenSubtask?.({ taskId: st.taskId, number: st.number, title: st.title })}
                title="点击 = 对该子任务定向跟进（task.steer），不经协调者转述"
              >
                <Icon name="corner-down-right" size={14} className="faint" style={{ marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row tight baseline">
                    <span className="root-task-no">#{st.number}</span>
                    <span className="subtask-title">{st.title}</span>
                    <Tag tone={st.access === 'modify' ? 'warning' : 'neutral'} icon={st.access === 'modify' ? 'edit' : 'eye'}>
                      {st.access === 'modify' ? '修改' : '只分析'}
                    </Tag>
                    {st.status === 'DONE' ? <Tag tone="success" icon="check-circle">已完成</Tag> : null}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>{st.objective}</div>
                  <div className="subtask-meta">
                    <span><Icon name="user" size={10} /> {memberName ?? '成员'}</span>
                    <span>交付：{st.deliverable}</span>
                    <span>依赖：{st.dependsOn.length === 0 ? '无' : st.dependsOn.join('、')}</span>
                  </div>
                  <div className="small faint" style={{ marginTop: 3 }}>
                    验收标准：{st.acceptance.join('；')}
                  </div>
                </div>
              </div>
            ))}
            <div className="divider soft" />
            <div className="row tight baseline">
              <Icon name="git-commit" size={12} className="faint" />
              <span className="small muted">整合计划：{a.integrationPlan}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* 报告卡 */}
      {r ? (
        <div className="msg-card" style={{ marginTop: 8 }}>
          <div className="msg-card-head">
            <Icon name="file-text" size={13} />
            报告 R{r.revision}
            {r.lateIncluded ? <Tag tone="warning" icon="clock">迟到纳入</Tag> : null}
            <span className="spacer" />
            <span className="small faint mono">baseline_a1f9</span>
          </div>
          <div className="msg-card-body">
            <div className="report-card">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="strong" style={{ fontSize: 12 }}>{r.summary}</div>
                <div className="row tight wrap" style={{ marginTop: 6 }}>
                  <Tag plain icon="list">{r.claimCount} 条论断</Tag>
                  <Tag plain icon="help-circle">{r.openQuestions} 个开放问题</Tag>
                  <Tag plain icon="user">{memberName}</Tag>
                </div>
              </div>
              <button className="btn sm" onClick={() => onOpenArtifact?.(r.artifactId)}>
                <Icon name="eye" size={12} /> 打开成果
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 争议卡 */}
      {d ? (
        <div className="msg-card" style={{ marginTop: 8 }}>
          <div className="msg-card-head">
            <Icon name="scale" size={13} />
            争议 · 修订 r{d.revision}
            <Tag
              tone={d.status === 'open' ? 'danger' : d.status === 'needs_user' ? 'warning' : d.status === 'resolved' ? 'success' : 'neutral'}
              icon={d.status === 'open' ? 'alert-circle' : d.status === 'needs_user' ? 'hand' : d.status === 'resolved' ? 'check-circle' : 'help-circle'}
            >
              {d.status === 'open' ? '仍开放' : d.status === 'needs_user' ? '需要你决定' : d.status === 'resolved' ? '已解决' : '证据不足'}
            </Tag>
          </div>
          <div className="msg-card-body">
            <div className="strong" style={{ fontSize: 12, marginBottom: 6 }}>{d.statement}</div>
            {d.positions.map((p, i) => (
              <div key={i} className="position-row">
                <div className="position-stance">
                  <span className="row tight">
                    <Avatar name={p.memberId.includes('claude') ? 'C' : 'X'} color={memberColor(p.memberId)} size={16} subject={`member:${p.memberId}`} />
                    <span className="small strong truncate">{p.memberId.replace('member_', '')}</span>
                  </span>
                </div>
                <div style={{ flex: 'none' }}>
                  <Tag
                    tone={p.stance === 'agree' ? 'success' : p.stance === 'disagree' ? 'danger' : p.stance === 'needs_evidence' ? 'warning' : 'neutral'}
                    icon={p.stance === 'agree' ? 'check' : p.stance === 'disagree' ? 'x' : 'help-circle'}
                  >
                    {p.stance === 'agree' ? '同意' : p.stance === 'disagree' ? '反对' : p.stance === 'needs_evidence' ? '需要证据' : '未确认'}
                  </Tag>
                </div>
                <div className="position-reason">{p.reason}</div>
              </div>
            ))}
            <div className="panel" style={{ marginTop: 8, padding: '7px 10px' }}>
              主持者不能单方面把其他成员的反对标成同意；共识状态由程序按确认记录计算。
            </div>
          </div>
        </div>
      ) : null}

      {/* 授权卡 */}
      {ap ? (
        <div className="msg-card approval-card" style={{ marginTop: 8 }}>
          <div className="msg-card-head">
            <Icon name="hand" size={13} />
            授权请求
            <span className="spacer" />
            <span className="small faint">
              {ap.decision
                ? ap.decision === 'allow_once' ? '已授权本次' : '已拒绝'
                : `${Math.max(0, Math.round((ap.expiresAt - Date.now()) / 60000))} 分钟后自动拒绝`}
            </span>
          </div>
          <div className="msg-card-body">
            <dl className="kv">
              <dt>实际操作</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>{ap.action}</dd>
              <dt>作用范围</dt>
              <dd>{ap.scope}</dd>
              <dt>来源</dt>
              <dd>{memberName} · 任务 {ap.taskId.replace('task_', '#')}</dd>
              <dt>报文摘要</dt>
              <dd className="mono-sm">{ap.payloadHash}</dd>
            </dl>
            {ap.decision ? (
              <div className={`panel ${ap.decision === 'allow_once' ? 'success' : 'danger'}`} style={{ marginTop: 9 }}>
                <div className="panel-title">
                  <Icon name={ap.decision === 'allow_once' ? 'check-circle' : 'x-circle'} size={13} />
                  {ap.decision === 'allow_once' ? '已授权本次操作' : '已拒绝'}
                </div>
                {ap.decision === 'allow_once'
                  ? '仅本次允许；不会因此扩大该成员的目录权限，也不会成为长期规则。'
                  : '操作不会执行。等待超时与主动拒绝都会记录为已处理，不会自动允许。'}
              </div>
            ) : (
              <div className="panel-actions">
                <button className="btn primary sm" onClick={() => onApproval?.('allow_once')}>
                  <Icon name="check" size={12} /> 仅本次允许
                </button>
                <button className="btn danger sm" onClick={() => onApproval?.('deny')}>
                  <Icon name="x" size={12} /> 拒绝
                </button>
                <span className="small faint" style={{ alignSelf: 'center' }}>
                  表情与这里的按钮是两回事：表情不构成授权
                </span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* 结果卡 */}
      {res ? (
        <div className="msg-card result-card" style={{ marginTop: 8 }}>
          <div className="msg-card-head">
            <Icon name={res.outcome === 'succeeded' ? 'check-circle' : res.outcome === 'partial' ? 'alert-circle' : 'x-circle'} size={13} />
            交付结果 · {res.outcome === 'succeeded' ? '完成' : res.outcome === 'partial' ? '部分完成' : '失败'}
            <span className="spacer" />
            {resultConsensusLabel(mode, res.consensus, res.absentMemberIds, res.lateMemberIds) ? (
              <ConsensusTag
                consensus={res.consensus!}
                // 有缺席成员时，任何情况下都不能渲染成"全体一致"（AT-05）
                label={resultConsensusLabel(mode, res.consensus, res.absentMemberIds, res.lateMemberIds)!}
              />
            ) : (
              // DIRECT / AUTO 没有共识语义：显式说明，而不是留空或套一个假状态
              <Tag plain icon="info" title="只有共同研讨模式才计算共识状态">
                无共识语义（非研讨模式）
              </Tag>
            )}
          </div>
          <div className="msg-card-body">
            <div className="small muted" style={{ lineHeight: 1.7 }}>{res.note}</div>
            <div className="row tight wrap" style={{ marginTop: 8 }}>
              {res.absentMemberIds.length > 0 ? (
                <Tag tone="danger" icon="user-minus">{`缺席 ${res.absentMemberIds.length} 人`}</Tag>
              ) : null}
              {res.lateMemberIds.length > 0 ? (
                <Tag tone="warning" icon="clock">{`迟到纳入 ${res.lateMemberIds.length} 人`}</Tag>
              ) : null}
              <Tag plain icon="file-text">{`${res.artifactIds.length} 份成果`}</Tag>
              <Tag plain icon="diff">{`${res.changeSetIds.length} 个改动集`}</Tag>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One bottom attachment area shared by human/agent rows; details stay outside any fold. */
function MessageFooter({
  message,
  formalAttachments,
  onOpenAttachment,
  onOpenResource,
}: {
  message: Message;
  formalAttachments: readonly FormalAttachmentSummary[];
  onOpenAttachment?: (att: FormalAttachmentSummary) => void;
  onOpenResource?: (resourceId: string, revision?: number) => void;
}) {
  const formalIds = new Set(formalAttachments.map((attachment) => attachment.artifactId));
  return (
    <div className="msg-attachment-footer">
      <GeneratedFiles attachments={message.formalAttachments} onOpen={onOpenAttachment} />
      <MessageAttachments message={message} excludeIds={formalIds} onOpen={onOpenResource} />
    </div>
  );
}

/* ---------------- 正文（含回复串阅读辅助） ---------------- */

/** Legacy/over-budget prose folds to roughly 8–12 lines; full detail cards stay outside. */
const FOLD_LINES = 10;
const FOLD_CHARS = 600;

function MessageText({ message, text, readingAids, hasDetail }: { message: Message; text: string; readingAids: boolean; hasDetail: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const foldId = useId();
  const isHuman = message.authorType === 'human';
  /* 流式中一律不折叠、不出目录、不转字段表：内容还在变，版面不能跟着跳。 */
  const aids = readingAids && message.streaming !== true;
  const lineCount = useMemo(() => text.split('\n').filter((l) => l.trim() !== '').length, [text]);
  const foldable = aids && (lineCount > FOLD_LINES || text.length > FOLD_CHARS);
  const outline = useMemo(() => (aids && !isHuman ? outlineOf(text) : []), [aids, isHuman, text]);
  const jumpTo = (index: number): void => {
    const reveal = (): void => {
      const el = boxRef.current?.querySelector<HTMLElement>(`[data-md-heading="${index}"]`);
      if (el == null) return;
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    };
    // A folded body is overflow-hidden; scrolling to a heading still hidden by
    // the fold would report a DOM position but not make it readable.
    if (foldable && !expanded) {
      setExpanded(true);
      requestAnimationFrame(() => requestAnimationFrame(reveal));
      return;
    }
    reveal();
  };
  const toggle = (): void => {
    setExpanded(!expanded);
    /* 收起后正文变短，把这条消息拉回视野，避免读者停在一片空白里。 */
    if (expanded) window.requestAnimationFrame(() => boxRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div className="msg-text" ref={boxRef}>
      {outline.length > 0 ? (
        <nav className="msg-outline" aria-label="本条回复的章节">
          {outline.map((o) => (
            <button key={o.index} type="button" className="msg-outline-chip" title={o.title} onClick={() => jumpTo(o.index)}>{o.title}</button>
          ))}
        </nav>
      ) : null}
      {foldable ? (
        <div id={foldId} className={`msg-fold${expanded ? '' : ' is-folded'}`}>
          <MarkdownView text={text} specTables={aids && !isHuman} headingAnchors={outline.length > 0} />
        </div>
      ) : (
        <MarkdownView text={text} specTables={aids && !isHuman} headingAnchors={outline.length > 0} />
      )}
      {message.streaming ? <i className="streaming-caret" /> : null}
      {foldable ? (
        <button type="button" className="msg-fold-toggle" aria-expanded={expanded} aria-controls={foldId} onClick={toggle}>
          {expanded ? '收起' : `${hasDetail ? '展开答复原文' : '展开原文'} · 共 ${lineCount} 行`}
        </button>
      ) : null}
    </div>
  );
}

/* ---------------- 系统卡 ---------------- */

function SystemCard({
  message,
  onRetry,
  onAllowMissing,
  onSteer,
}: {
  message: Message;
  onRetry?: () => void;
  onAllowMissing?: () => void;
  onSteer?: () => void;
}) {
  const sys = message.payload?.system;
  if (!sys) {
    return <div className="sys-card info"><div className="sys-card-detail">{message.body}</div></div>;
  }
  const icon = sys.tone === 'error' ? 'x-circle' : sys.tone === 'warn' ? 'alert-triangle' : 'info';
  return (
    <div className={`sys-card ${sys.tone}`}>
      <div className="sys-card-title">
        <Icon name={icon} size={13} />
        {sys.title}
      </div>
      <div className="sys-card-detail">{sys.detail}</div>
      {sys.actions?.length ? (
        <div className="panel-actions">
          {sys.actions.map((a, i) => (
            <button
              key={i}
              className="btn sm"
              onClick={() => {
                if (a.api === 'task.retry') onRetry?.();
                else if (a.api === 'run.allowMissing') onAllowMissing?.();
                else if (a.api === 'task.steer') onSteer?.();
                else recordLocalOnly(a.api, `${a.label}（原型未实现具体动作）`);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 运行用量条（供运行详情复用） ---------------- */

export function TurnUsageLine({
  usage,
  memberName,
  stage,
  status,
  durationMs,
}: {
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; costQuality: 'reported' | 'estimated' | 'unknown'; costAmount: number | null };
  memberName: string;
  stage: string;
  status: string;
  durationMs?: number;
}) {
  return (
    <div className="row wrap" style={{ gap: 10, fontSize: 11 }}>
      <span className="strong">{memberName}</span>
      {/* 阶段与状态都走中文标签，不裸露内部枚举（评审意见 5） */}
      <Tag plain icon="layers">{stageLabel(stage)}</Tag>
      <Tag plain>{status}</Tag>
      {durationMs ? <span className="faint">{formatDuration(durationMs)}</span> : null}
      {usage ? (
        <>
          <span className="faint mono-sm">
            入 {formatTokens(usage.inputTokens)}（缓存 {formatTokens(usage.cachedInputTokens)}）· 出 {formatTokens(usage.outputTokens)}
          </span>
          {/* RT-17：未知费用不显示为 0 */}
          <CostText quality={usage.costQuality} amount={usage.costAmount} />
        </>
      ) : null}
    </div>
  );
}
