/**
 * 线程视图（第五十一轮 H2 首版）：主池线程卡 → 回复串页面——回复 + 详情（任务概况/交付
 * 验收）两个可达视图；成果/成员/活动/运行/研讨未换装，经「原界面」定向并如实标注。
 *
 * 正式链（review-r50 §4 修正后的 DTO 适配）：thread.get（实体+根消息+水位）→
 * thread.history（items+rootAttachments）→ task.get（pendingDelivery 只有 id/revision/
 * manifest_hash 三重身份——不猜其余字段）。回复=message.submit thread 目标（**不另建根
 * 任务**；记录串默认仅记录、永不唤醒——服务端强制，UI 同判）；停止绑定装载的 run+停止
 * 代次（过时绑定由服务端拒绝）；验收/返工在打开意见框时**冻结交付三重身份快照**（目标
 * 变化不悄悄换稿，review-r44/45 同判）。readGate=线程独立水位+当前导航/前台/贴底/接管
 * （不与 DM conversationSeq 门混用）。**关闭视图不停止执行**——卸载只清定时器/门。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, loadThread, refreshThreadTask, retryUnknownSend, setThreadReadGate, toast, setState } from './shell';
import { buildThreadEnvelope, sendEnvelope, stopThreadTask, submitTaskReview, attachmentRefsFromDraft, previewTextAttachment, type ReviewSnapshot } from './loader';
import { parkUnknownEnvelope } from './data/store';
import type { HifiDraftAttachment } from './data/store';
import { navigate } from './lib/router';

const EMPTY: never[] = [];
const FORMAL_LIMITS = {
  method: '执行方式开关（计划/跳过初稿/分工）尚未接入本包执行链（H3）——线程内按任务既有方式跟进',
  access: '权限档位声明尚未接入本包（H3 按已认证能力开放）——按成员默认权限执行',
} as const;

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '执行中', WAITING_USER: '待你处理', BLOCKED: '受阻', REVIEW: '待验收', DONE: '已完成',
  CANCELLED: '已取消', FAILED: '失败', RUNNING: '运行中', WAITING: '排队中', STOPPING: '停止中',
};

/** 详情里未换装的分组——定向原界面（同房间），如实标注而非隐藏。 */
const LEGACY_SECTIONS: Array<{ key: string; label: string; note: string }> = [
  { key: 'artifacts', label: '成果与附件', note: '成果列表/线程附件管理在原界面（共享预览 R52 接入后开放本页）' },
  { key: 'activity', label: '活动与进展', note: '过程说明/程序校验记录在原界面' },
  { key: 'members', label: '参与成员', note: '参与者名单与关注状态在原界面' },
  { key: 'run', label: '运行详情', note: '运行/轮次明细在原界面' },
  { key: 'deliberation', label: '研讨详情', note: '研讨进度在原界面' },
];

export function ThreadPage({ threadId, initialTab, highlightMessageId }: { threadId: string; initialTab?: string; highlightMessageId?: string }) {
  const entity = useStore((s) => s.threadEntities[threadId]);
  const anchor = useStore((s) => s.threadAnchors[threadId]);
  const replies = useStore((s) => s.threadMessages[threadId]);
  const task = useStore((s) => s.threadTasks[threadId]);
  const readSeq = useStore((s) => s.threadReadSeq[threadId]);
  const readError = useStore((s) => s.readErrors[`thread:${threadId}`]);
  const membersAll = useStore((s) => s.members);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<'replies' | 'task'>(initialTab === 'task' ? 'task' : 'replies');
  /** 验收/返工框打开时冻结的交付快照（deliveryId/revision/manifestHash——提交只带这份）。 */
  const [reviewBox, setReviewBox] = useState<{ mode: 'accept' | 'rework'; snapshot: ReviewSnapshot; note: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [preview, setPreview] = useState<{ filename: string; text: string; truncated: boolean } | { error: string } | { loading: true } | null>(null);
  const isRecordThread = entity != null && entity.rootTaskId == null;
  const msgs = replies ?? EMPTY;

  // 装载（含任务详情）+ 阅读水位（门在发起此刻重查——ThreadPage 注册的独立线程门）。
  useEffect(() => {
    void loadThread(threadId, { markRead: true });
  }, [threadId]);
  // 线程标读门注册：当前线程+前台+非接管+贴底（滚动容器**此刻**判定——门在 markRead 发起
  // 时重查本闭包，不信任装载前的快照；review-r50 §4 线程独立水位门）。
  useEffect(() => {
    setThreadReadGate((tid: string) =>
      tid === threadId
      && document.visibilityState === 'visible'
      && !document.body.classList.contains('legacy-on')
      && (() => { const box = listRef.current; return box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true; })());
    return () => { setThreadReadGate(null); };
  }, [threadId]);
  // 可见时轻量刷新（回复/任务状态可见；隐藏/接管暂停——关闭视图不停止执行，只停轮询）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadThread(threadId);
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [threadId]);
  // 活动目标追踪（接管定位用）。
  useEffect(() => { setState((st) => ({ ...st, ui: { ...st.ui, activeRoomId: entity?.roomId ?? st.ui.activeRoomId } })); }, [entity?.roomId]);
  // 直达消息定位：滚到该处并短暂高亮（只定位已有记录，不执行命令）。
  useEffect(() => {
    if (highlightMessageId == null) return;
    setTab('replies');
    const t = window.setTimeout(() => {
      const el = document.getElementById(`msg-${highlightMessageId}`);
      if (el != null) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('msg-highlight');
        window.setTimeout(() => el.classList.remove('msg-highlight'), 2600);
      }
    }, 350);
    return () => { window.clearTimeout(t); };
  }, [highlightMessageId, threadId]);

  const memberById = useMemo(() => new Map(membersAll.map((m) => [m.id, m])), [membersAll]);
  const firstUnreadSeq = useMemo(() => {
    if (readSeq == null || readSeq <= 0) return undefined;
    const first = msgs.find((m) => (m.threadMessageSeq ?? 0) > readSeq && m.authorType !== 'human');
    return first?.threadMessageSeq;
  }, [msgs, readSeq]);

  if (entity == null) {
    return (
      <div className="page-stack" style={{ padding: 16 }}>
        {readError != null ? (
          <div className="panel info" style={{ borderColor: 'var(--warning)' }}>读取失败：{readError}（保留上次快照——可返回主池重进）</div>
        ) : (
          <div className="panel info">正在打开回复串…</div>
        )}
        <button className="btn ghost sm" onClick={() => window.history.back()}>返回</button>
      </div>
    );
  }

  const backToPool = () => navigate(`/room/${entity.roomId}`);
  const conversationId = entity.conversationId ?? '';
  const taskNo = task != null ? `#${task.roomTaskNumber}` : null;
  const statusLabel = task != null ? STATUS_LABEL[task.status] ?? task.status : null;
  const stoppable = task != null && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(task.status);
  const runStopping = task?.activeRun?.status === 'STOPPING';

  const openPreview = (att: { artifactId: string; filename: string; kind: string }) => {
    // 共享预览骨架（R51）：文本/代码=真实 previewText 内联面板；其余类型如实分列——
    // 不复制未接真实服务的原型 resources/actions 冒充实现（review-r50 §4）。
    if (att.kind !== 'text_file' && att.kind !== 'code_file') {
      toast(`「${att.filename}」（${att.kind}）的共享预览 R52 接入——当前可经「原界面」打开`, 'info');
      return;
    }
    setPreview({ loading: true });
    void previewTextAttachment(att.artifactId, conversationId)
      .then((r) => setPreview({ filename: r.filename, text: r.text, truncated: r.truncated }))
      .catch((e: unknown) => setPreview({ error: (e as Error).message }));
  };

  const doStop = async () => {
    setStopping(true);
    const r = await stopThreadTask(threadId);
    setStopping(false);
    if (r.ok) toast('停止请求已提交（等活跃 turn 结束——详情状态会刷新）', 'success');
    else toast(`停止失败：${r.error}`, 'error');
  };

  const openReview = (mode: 'accept' | 'rework') => {
    if (task?.pendingDelivery == null) return;
    // 打开即冻结三重身份（id+revision+manifestHash）——此后刷新出新交付也不悄悄换稿。
    const d = task.pendingDelivery;
    setReviewBox({ mode, snapshot: { taskId: task.id, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: d.manifestHash }, note: '' });
  };
  const submitReview = async () => {
    if (reviewBox == null) return;
    if (reviewBox.mode === 'rework' && reviewBox.note.trim().length === 0) {
      toast('要求修改必须填写意见（意见进入正式任务记录并注入返工输入）', 'warn');
      return;
    }
    const r = await submitTaskReview(reviewBox.snapshot, reviewBox.mode === 'accept' ? 'accept' : 'changes_requested', reviewBox.note.trim().length > 0 ? reviewBox.note.trim() : undefined, threadId);
    if (r.ok) { toast(reviewBox.mode === 'accept' ? '已验收通过（任务完成）' : '已提交返工意见（任务回到执行）', 'success'); setReviewBox(null); void loadThread(threadId); }
    else { toast(`提交失败：${r.error}——交付可能已更新，详情已刷新`, 'error'); setReviewBox(null); }
  };

  const detail = task;
  const pendingDeliveryStale = reviewBox != null && detail?.pendingDelivery != null
    && (detail.pendingDelivery.id !== reviewBox.snapshot.deliveryId || detail.pendingDelivery.revision !== reviewBox.snapshot.deliveryRevision);

  return (
    <div className="page-stack" style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}>
      {/* 单行紧凑导航（减负 §2 既有形态）：收起/返回 + 回复/成果/详情视图键。 */}
      <div className="thread-nav" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
        <button className="btn ghost sm" title="收起回复串，返回房间主池（不会停止任务，草稿保留）" onClick={backToPool}>
          <Icon name="arrow-left" size={13} /> 返回主池
        </button>
        <button role="tab" aria-selected={tab === 'replies'} className={`btn ghost sm${tab === 'replies' ? '' : ''}`} style={tab === 'replies' ? { fontWeight: 600 } : undefined} onClick={() => setTab('replies')}>
          <Icon name="message-square" size={13} /> 回复 <span className="faint">{msgs.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'task'} className="btn ghost sm" style={tab === 'task' ? { fontWeight: 600 } : undefined} onClick={() => setTab('task')}>
          <Icon name="list" size={13} /> 详情
        </button>
        <button className="btn ghost sm" disabled title="成果与附件视图随共享预览（R52）接入——当前经「详情 → 原界面」可达">
          <Icon name="file-text" size={13} /> 成果（R52）
        </button>
        <div className="spacer" style={{ flex: 1 }} />
        {isRecordThread
          ? <Tag tone="neutral" icon="message-square">记录串 · 无任务号 · 发送仅保存</Tag>
          : statusLabel != null ? <Tag tone={detail?.status === 'DONE' ? 'success' : detail?.status === 'REVIEW' ? 'info' : 'neutral'} icon="activity">{taskNo} {statusLabel}</Tag> : null}
      </div>

      {readError != null ? <div className="panel info" style={{ margin: '8px 14px 0', borderColor: 'var(--warning)' }}>读取失败：{readError}（保留上次快照——重试=切换视图或等待自动刷新）</div> : null}

      {tab === 'replies' ? (
        <>
          <div className="msg-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
            {/* 根消息（房间级锚消息——不在 thread 历史内；thread.get anchor 提供） */}
            <div className="panel info" style={{ marginBottom: 8 }} id={`msg-${anchor?.id ?? 'anchor'}`}>
              <div className="row tight">
                <span className="small faint">原消息 · {anchor != null ? new Date(anchor.createdAt).toLocaleString() : '正文缺失（如实标注）'}</span>
              </div>
              <div style={{ marginTop: 4 }}>{anchor?.body || '（根消息正文不可得——不虚构）'}</div>
              {(anchor?.formalAttachments ?? []).length > 0 ? (
                <div className="msg-attach-row">
                  {(anchor?.formalAttachments ?? []).map((a) => (
                    <button key={a.artifactId} className="msg-attach" title={`预览 ${a.filename}（只读，不发送给 AI）`} onClick={() => openPreview(a)}>
                      <Icon name="file-text" size={12} />
                      <span className="truncate">{a.filename}</span>
                      <span className="msg-attach-kind">{a.kind === 'code_file' ? '代码' : '文本'}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {msgs.length === 0 ? <div className="panel info">暂无回复——发送第一条跟进（不另建根任务）。</div> : null}
            {msgs.map((m) => (
              <div key={m.id}>
                {m.threadMessageSeq === firstUnreadSeq ? <div className="unread-divider" style={{ borderTop: '1px solid var(--accent, #2563eb)', margin: '8px 0', fontSize: 11, color: 'var(--accent, #2563eb)', textAlign: 'center' }}>以上未读之后的新回复</div> : null}
                <div id={`msg-${m.id}`}>
                  <MessageView
                    message={m}
                    author={m.authorType === 'human' ? undefined : memberById.get(m.authorId)}
                    onOpenAttachment={(att) => openPreview(att)}
                  />
                </div>
              </div>
            ))}
            {preview != null ? (
              <div className="panel info" style={{ marginTop: 10 }}>
                {'loading' in preview ? <span>正在加载预览…</span> : 'error' in preview
                  ? <span style={{ color: 'var(--warning)' }}>预览失败：{preview.error}</span>
                  : (
                    <>
                      <div className="row tight"><strong>{preview.filename}</strong>{preview.truncated ? <span className="faint small">（内容过长已截断）</span> : null}<button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setPreview(null)}>关闭</button></div>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{preview.text}</pre>
                    </>
                  )}
              </div>
            ) : null}
          </div>
          <Composer
            target={{ kind: 'thread', roomId: entity.roomId, threadId }}
            draftKey={`thread:${threadId}`}
            recordThread={isRecordThread}
            formalLimits={FORMAL_LIMITS}
            attachmentUpload={conversationId !== '' ? { conversationId } : undefined}
            onRetrySend={(env) => retryUnknownSend(env).then((r) => {
              if (r.status === 'ok') { void loadThread(threadId, { markRead: true }); toast('重发成功（原信封）', 'success'); }
              return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
            })}
            onSend={(p): Promise<FormalSendOutcome> => (async () => {
              const intent = p.sendAs === 'record' ? 'record_only' : 'default';
              const draftKey = `thread:${threadId}`;
              const refs = attachmentRefsFromDraft(p.attachments as HifiDraftAttachment[], intent);
              if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
              if (conversationId === '') return { status: 'failed', error: '线程归属未装载（conversationId 缺失）——稍后重试' };
              const env = buildThreadEnvelope(p.commandId, threadId, p.body, intent, refs.refs);
              env.revAtSend = p.draftRev;
              const r = await sendEnvelope(env);
              if (r.status === 'ok') {
                void loadThread(threadId, { markRead: true }).catch(() => { /* 读失败另有呈现 */ });
                toast(intent === 'record_only' ? '已保存记录（不唤醒）' : '已跟进（延续当前任务）', 'success');
                return { status: 'ok' };
              }
              if (r.status === 'unknown') parkUnknownEnvelope(draftKey, env);
              return r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
            })()}
          />
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px' }} className="page-stack">
          {isRecordThread || detail == null ? (
            <div className="panel info">这是记录串（无根任务）：没有任务概况与交付——回复仅保存，不派发、不唤醒 agent。</div>
          ) : (
            <>
              <div className="panel info">
                <div className="row tight wrap">
                  <strong>#{detail.roomTaskNumber} {detail.title}</strong>
                  <Tag tone={detail.status === 'DONE' ? 'success' : detail.status === 'REVIEW' ? 'info' : 'neutral'} icon="activity">{STATUS_LABEL[detail.status] ?? detail.status}</Tag>
                  {detail.activeRun != null ? <span className="faint small">run {STATUS_LABEL[detail.activeRun.status] ?? detail.activeRun.status}</span> : <span className="faint small">无活跃 run</span>}
                </div>
                <div className="faint small" style={{ marginTop: 4 }}>任务 revision {detail.revision} · 停止代次 {detail.stopGeneration} · 状态以 task.get 服务端事实为准</div>
                {detail.lastStartupFailureMessage != null ? <div className="panel warning" style={{ marginTop: 8 }}>最近一次启动失败：{detail.lastStartupFailureMessage}</div> : null}
                <div className="row tight" style={{ marginTop: 8 }}>
                  {stoppable ? (
                    <button className="btn ghost sm" disabled={stopping || runStopping} title="停止当前 run（绑定装载的 run+停止代次——过时会被服务端拒绝）" onClick={() => void doStop()}>
                      {stopping || runStopping ? '停止中…' : '停止任务'}
                    </button>
                  ) : null}
                  <button className="btn ghost sm" title="刷新任务详情（绑定服务端当前事实）" onClick={() => void refreshThreadTask(threadId).catch((e: unknown) => toast(`刷新失败：${(e as Error).message}`, 'error'))}>刷新详情</button>
                  <span className="faint small">关闭本视图不会停止执行——执行属于任务，不属于页面。</span>
                </div>
              </div>

              <div className="panel info">
                <div className="row tight"><strong>交付与验收</strong></div>
                {detail.pendingDelivery == null ? (
                  <div className="faint small" style={{ marginTop: 4 }}>当前没有待验收交付（任务策略为 user_review 且有新交付时在此出现）。</div>
                ) : (
                  <>
                    <div className="faint small" style={{ marginTop: 4 }}>
                      待验收交付：v{detail.pendingDelivery.revision} · id {detail.pendingDelivery.id} · manifest {detail.pendingDelivery.manifestHash.slice(0, 12)}…
                      （提交按打开时冻结的这三重身份——版本变化不自动套用）
                    </div>
                    <div className="row tight" style={{ marginTop: 8 }}>
                      <button className="btn ghost sm" disabled={reviewBox != null} onClick={() => openReview('accept')} title="验收当前版本（任务→已完成）">验收通过</button>
                      <button className="btn ghost sm" disabled={reviewBox != null} onClick={() => openReview('rework')} title="要求返工（须填意见——任务回到执行）">要求返工</button>
                      <button className="btn ghost sm" title="在原界面查看交付内容（预览 R52 接入）" onClick={() => import('./App').then((m) => m.takeLegacy('current-room'))}>原界面查看交付</button>
                    </div>
                    {reviewBox != null ? (
                      <div style={{ marginTop: 8 }}>
                        {pendingDeliveryStale ? (
                          <div className="panel warning">
                            交付已更新（打开时冻结的是 v{reviewBox.snapshot.deliveryRevision}，当前为 v{detail.pendingDelivery?.revision ?? '?'}）——本框已作废，请对新版本重新操作。
                            <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setReviewBox(null)}>关闭</button>
                          </div>
                        ) : (
                          <>
                            {reviewBox.mode === 'rework' ? (
                              <textarea
                                className="composer-input"
                                style={{ width: '100%', minHeight: 64 }}
                                placeholder="返工意见（必填——进入正式任务记录并注入返工输入）"
                                value={reviewBox.note}
                                onChange={(e) => setReviewBox((b) => b == null ? b : { ...b, note: e.target.value })}
                              />
                            ) : <div className="faint small">将验收通过 v{reviewBox.snapshot.deliveryRevision}（manifest {reviewBox.snapshot.manifestHash.slice(0, 12)}…）。</div>}
                            <div className="row tight" style={{ marginTop: 6 }}>
                              <button className="btn sm" onClick={() => void submitReview()}>{reviewBox.mode === 'accept' ? '确认验收' : '提交返工意见'}</button>
                              <button className="btn ghost sm" onClick={() => setReviewBox(null)}>取消</button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </>
          )}

          <div className="panel info">
            <div className="row tight"><strong>未换装分组（经原界面定向）</strong></div>
            <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
              {LEGACY_SECTIONS.map((sec) => (
                <button key={sec.key} className="btn ghost sm" style={{ justifyContent: 'space-between' }} title={sec.note} onClick={() => import('./App').then((m) => m.takeLegacy('current-room'))}>
                  <span>{sec.label} → 原界面</span>
                  <span className="faint small">{sec.note}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
