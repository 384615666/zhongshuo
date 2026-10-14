/**
 * 消息渲染（§17.3 消息类型）
 *
 * 口径要点：
 *  - 流式消息用稳定 messageId 原地更新，终结时保存完整版本
 *  - 成员进度、分工、争议、结果都在线程内，不向主池追加独立消息
 *  - 表情不是授权或共识记录；授权按钮与表情分开呈现
 *  - E3：点子任务卡 = 定向跟进该子任务
 */

import { useState } from 'react';
import {chatAnswer} from '../../../contracts/chatAnswer';
import {MessageProtocol} from './MessageProtocol';
import { Icon } from './Icon';
import { Avatar, ConsensusTag, CostText, Menu, MenuItem, Tag, memberColor } from './ui';
import { clockTime, formatDuration, formatTokens, resultConsensusLabel, stageLabel } from '../lib/format';
import type { Message, ProjectMember, RouteMode } from '../data/types';
import { recordLocalOnly, useStore } from '../data/store';
import { attachmentsOfMessage, resourceOf, revisionOf } from '../lib/resource';
import type { FormalAttachmentSummary } from '../data/types';

/* ---------------- 极简富文本：仅支持 `code` 与 **粗体** ---------------- */

function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/* ---------------- 消息携带的资源（UX-PREVIEW-01） ---------------- */

/**
 * 把消息附件渲染成**可点击的文件 chip**。
 *
 * 修复的确切缺口：此前 Composer 的附件只是 `{name, size}`，
 * 从不落进消息，`MessageView` 里也没有任何可点击的文件名 ——
 * 于是"点对话里的文件名打开预览"这条交互**没有落点**。
 *
 * 现在附件经 `Message.attachmentIds` 关联到资源，chip 显示真实标题与版本。
 * 无 taskId 的主池消息同样渲染（§17.9 第 1 条）。
 */
/**
 * 附件 kind → 中文标签（导出共享，r55）：回复芯片与根消息（线程锚消息）独立渲染路径
 * 用同一映射——此前锚消息路径只认 code/text，PPT（幻灯）/CSV（表格→sheet_file）都
 * 显示成「文本」（用户短测 T5 确认的呈现缺陷）。
 */
export const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  text_file: '文本', code_file: '代码', image_file: '图片', pdf_file: 'PDF',
  docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯',
};

function MessageAttachments({
  message, onOpen, onOpenAttachment,
}: {
  message: Message;
  onOpen?: (resourceId: string, revision?: number) => void;
  /** 正式侧（第五十一轮）：真实附件摘要芯片（message_attachments 投影）——优先渲染。 */
  onOpenAttachment?: (att: FormalAttachmentSummary) => void;
}) {
  const s = useStore((x) => x);
  // 正式摘要优先（真实 attachmentId/kind）；无正式数据才走原型 resources 路径。
  if ((message.formalAttachments ?? []).length > 0) {
    return (
      <div className="msg-attach-row">
        {(message.formalAttachments ?? []).map((a) => (
          <button
            key={a.artifactId}
            data-zs-artifact-id={a.artifactId}
            className="msg-attach"
            title={`打开 ${a.filename}（只读预览，不发送给 AI）`}
            onClick={() => onOpenAttachment?.(a)}
          >
            <Icon name="file-text" size={12} />
            <span className="truncate">{a.filename}</span>
            <span className="msg-attach-kind">{ATTACHMENT_KIND_LABEL[a.kind] ?? a.kind}</span>
          </button>
        ))}
      </div>
    );
  }
  const links = attachmentsOfMessage(s, message.id);
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

export function MessageView({
  message,
  domId,
  linkThreadId,
  author,
  isMentioned,
  mode,
  onOpenSubtask,
  onOpenThread,
  onOpenArtifact,
  onReact,
  onSave,
  onConvertToTask,
  onApproval,
  onRetry,
  onAllowMissing,
  onSteer,
  onQuote,
  onCorrection,
  onOpenResource,
  // onCorrection（r61）：正式命令未接入——保留 prop 供后续接线，当前无调用方传入。
  onOpenAttachment,
}: {
  message: Message;
  domId?:string;
  linkThreadId?:string;
  author?: ProjectMember;
  isMentioned?: boolean;
  /** 结果卡是否需要显示共识状态，由任务模式决定（DIRECT/AUTO 不计算共识） */
  mode?: RouteMode;
  onOpenSubtask?: (subtask: { taskId: string; number: number; title: string }) => void;
  onOpenThread?: () => void;
  onOpenArtifact?: (artifactId: string) => void;
  /** UX-PREVIEW-01：打开消息携带的资源（主池与线程共用同一回调） */
  onOpenResource?: (resourceId: string, revision?: number) => void;
  /** 正式侧（第五十一轮）：打开真实附件摘要芯片（attachment.preview* 通道）。 */
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
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [protocolOpen,setProtocolOpen]=useState(false);
  const visibleBody=chatAnswer(message.body,message.authorType);
  const isSystem = message.authorType === 'system';
  const isHuman = message.authorType === 'human';

  return (
    <div className={`msg${isSystem ? ' system' : ''}${isMentioned ? ' mention-me' : ''}`} id={domId??`msg-${message.id}`}>
      <div className="msg-avatar">
        {isSystem ? (
          <span
            className="avatar avatar-22"
            style={{ background: 'var(--bg-surface-3)', color: 'var(--text-3)', border: '1px solid var(--border)' }}
            title="系统消息"
          >
            <Icon name="settings" size={12} />
          </span>
        ) : (
          <Avatar
            name={isHuman ? '我' : author?.displayName ?? '?'}
            ordinal={author?.ordinal}
            color={memberColor(isHuman ? 'you' : author?.id ?? '', author?.ordinal)}
            size={22}
            state={author?.workState}
            stateTitle={author?.workStateReason}
          />
        )}
      </div>

      {/* msg-body 带 is-human：人类消息用浅蓝气泡，agent 用中性气泡（规范 §5.3）。
          层级由**气泡自身底色**表达，不再依赖整列灰底 —— 那样看不出任何层级。 */}
      <div className={`msg-body${isHuman ? ' is-human' : ''}`}>
        {isSystem ? (
          <SystemCard message={message} onRetry={onRetry} onAllowMissing={onAllowMissing} onSteer={onSteer} />
        ) : (
          <>
            <div className="msg-head">
              <span className="msg-author">{isHuman ? '你' : author?.displayName ?? '未知成员'}</span>
              {!isHuman && author?.ordinal && author.ordinal > 1 ? (
                <span className="small faint">#{author.ordinal}</span>
              ) : null}
              {!isHuman && message.kind === 'report' ? <Tag tone="accent" icon="file-text">报告</Tag> : null}
              {message.streaming ? <Tag tone="info" icon="loader">流式中</Tag> : null}
              <span className="msg-time">{clockTime(message.createdAt)}</span>
              {message.threadMessageSeq !== undefined ? (
                <span className="msg-seq" title="串内顺序号 thread_message_seq">#{message.threadMessageSeq}</span>
              ) : null}
              {message.saved ? <Icon name="bookmark" size={11} className="faint" /> : null}
            </div>

            <MessageBody
              message={message}
              mode={mode}
              memberName={author?.displayName}
              onOpenSubtask={onOpenSubtask}
              onOpenArtifact={onOpenArtifact}
              onApproval={onApproval}
            />

            {/* 消息携带的资源（UX-PREVIEW-01 / §17.9）
                这是"主池普通附件也能预览"的入口：附件挂在消息上，
                **不要求 taskId**。点击打开共享预览，不发送、不执行。 */}
            <MessageAttachments message={message} onOpen={onOpenResource} onOpenAttachment={onOpenAttachment} />
          </>
        )}

        {/* 表情与操作（r61 G6：无正式处理器的动作不渲染入口——表情/引用仅在页面提供处理器时
            出现；书签按钮按正式收藏事实显示已收藏状态，再次点击=取消）。 */}
        {!isSystem ? (
          <div className="msg-actions">
            {onReact != null ? (
              <>
                <button className="icon-btn sm" title="表情：轻量反馈，不是授权或共识票" onClick={() => onReact('👍')}>
                  <span style={{ fontSize: 12 }}>👍</span>
                </button>
                <button className="icon-btn sm" title="表情" onClick={() => onReact('👀')}>
                  <span style={{ fontSize: 12 }}>👀</span>
                </button>
              </>
            ) : null}
            {onSave != null ? (
              <button
                className="icon-btn sm"
                title={message.saved ? '已收藏——再次点击取消收藏（只删收藏行，不改动原内容）' : '收藏（不把内容共享给其他成员）'}
                aria-pressed={message.saved === true}
                data-zs-saved={message.saved === true ? '1' : '0'}
                onClick={onSave}
              >
                <Icon name="bookmark" size={13} />
              </button>
            ) : null}
            {onOpenThread ? (
              <button className="icon-btn sm" title="在回复串中打开 / 定位" onClick={onOpenThread}>
                <Icon name="message-square" size={13} />
              </button>
            ) : null}
            <button
              className="icon-btn sm"
              title="更多操作"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenuAt({ x: r.left - 150, y: r.bottom + 4 });
              }}
            >
              <Icon name="more-horizontal" size={13} />
            </button>
            {message.reactions?.length ? (
              <span className="row tight" style={{ marginLeft: 4 }}>
                {message.reactions.map((r) => (
                  <button
                    key={r.emoji}
                    className="chip"
                    style={{ padding: '1px 6px', cursor: 'pointer' }}
                    onClick={() => onReact?.(r.emoji)}
                    title={`${r.by.length} 人：表情不作为正式共识记录`}
                  >
                    {r.emoji} <span className="faint">{r.by.length}</span>
                  </button>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {menuAt ? (
        <Menu anchor={menuAt} onClose={() => setMenuAt(null)}>
          <MenuItem icon="copy" onClick={() => { navigator.clipboard?.writeText(visibleBody); setMenuAt(null); }}>
            复制文字
          </MenuItem>
          {message.authorType==='agent'?<MenuItem icon="file" onClick={()=>{setMenuAt(null);setProtocolOpen(true);}}>查看运行协议…</MenuItem>:null}
          {onOpenThread ? (
            <MenuItem icon="message-square" onClick={() => { onOpenThread(); setMenuAt(null); }}>
              在回复串中打开
            </MenuItem>
          ) : null}
          <MenuItem
            icon="link"
            onClick={() => {
              // §15.5：应用内直达链接用 /thread/:id?message=:mid，路由表能解析并定位。
              // 原来写成 zhongshuo://#/thread/...，但路由没有 /thread 分支，点开落到欢迎页。
              const link = linkThreadId??message.threadId
                ? `#/thread/${linkThreadId??message.threadId}?message=${message.id}`
                : `#/project/${message.projectId}/room/${message.roomId}`;
              navigator.clipboard?.writeText(link);
              recordLocalOnly(
                'thread.copyLink',
                `message=${message.id} → ${link}（应用内直达链接，不是公网分享链接）`,
              );
              setMenuAt(null);
            }}
          >
            复制应用内链接
          </MenuItem>
          {onQuote != null ? (
            <MenuItem
              icon="corner-down-right"
              onClick={() => { onQuote(message); setMenuAt(null); }}
            >
              引用
            </MenuItem>
          ) : null}
          {onSave != null ? (
            <MenuItem icon="bookmark" onClick={() => { onSave(); setMenuAt(null); }}>
              {message.saved ? '取消收藏' : '收藏'}
            </MenuItem>
          ) : null}
          <div className="menu-sep" />
          {/* 「转为任务」只对顶层消息有意义：串内回复不可直接转（§27.12 TASK-01） */}
          <MenuItem
            icon="file-plus"
            disabled={!onConvertToTask || Boolean(message.threadId)}
            hint={message.threadId ? '串内回复不可转' : undefined}
            onClick={() => { onConvertToTask?.(); setMenuAt(null); }}
          >
            转为任务
          </MenuItem>
          {/* 追加更正：正式命令未接入前不出现入口（r61——不以本地日志冒充功能）。 */}
        </Menu>
      ) : null}
      {protocolOpen?<MessageProtocol key={message.id} projectId={message.projectId} messageId={message.id} onClose={()=>setProtocolOpen(false)}/>:null}
    </div>
  );
}

/* ---------------- 正文分派 ---------------- */

function MessageBody({
  message,
  memberName,
  mode,
  onOpenSubtask,
  onOpenArtifact,
  onApproval,
}: {
  message: Message;
  memberName?: string;
  mode?: RouteMode;
  onOpenSubtask?: (s: { taskId: string; number: number; title: string }) => void;
  onOpenArtifact?: (id: string) => void;
  onApproval?: (c: 'allow_once' | 'deny') => void;
}) {
  const visibleBody=chatAnswer(message.body,message.authorType);
  const a = message.payload?.assignment;
  const p = message.payload?.progress;
  const r = message.payload?.report;
  const d = message.payload?.dispute;
  const ap = message.payload?.approval;
  const res = message.payload?.result;

  return (
    <>
      {message.body && message.kind !== 'progress' ? (
        <div className="msg-text">
          <RichText text={visibleBody} />
          {message.streaming ? <i className="streaming-caret" /> : null}
        </div>
      ) : (message.formalAttachments ?? []).length > 0 ? (
        /* R66 P3：文件-only 消息（用户已批准的发送语义）——正文为空不是缺陷：
           用一行**界面说明**标注（不是合成正文），文件芯片在下方正常呈现。 */
        <div className="small faint" style={{ marginTop: 2, marginBottom: 2 }}>
          仅文件，无正文（{(message.formalAttachments ?? []).length} 个附件见下方）
        </div>
      ) : null}

      {message.kind === 'progress' ? (
        /* 进度消息 = 正文 + 需要被看见的异常标记。
           原来这里有一张"成员进度"卡片，包含「阶段 / 成员」两列网格 + 状态标签，
           全是占位：payload.progress 从未被写入，因此「成员」恒等于左侧头像旁已有的作者名，
           「阶段」恒显示兜底字符串"当前阶段"，状态标签恒显示"进行中"。
           三行字里两行是重复/恒定值，所以整张卡片删除，正文直接作为消息渲染。
           缺席/迟到这类真正需要看见的状态用标签附着在消息头，不另开卡片。 */
        <div className="msg-text">
          <RichText text={visibleBody} />
          {message.streaming ? <i className="streaming-caret" /> : null}
        </div>
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
                    <Avatar name={p.memberId.includes('claude') ? 'C' : 'X'} color={memberColor(p.memberId)} size={16} />
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
