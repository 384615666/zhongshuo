/**
 * 私信（决策 24，M3 批次）
 *
 * 产品口径（§12.2 conversations / conversation_members / dm_participants、§25.7 私信段）：
 *  - 私信是**独立可见范围与会话**，不是"@某人"的替代品
 *  - 一个成员可以有**多个**私聊：同一成员的不同话题分开，互不串上下文
 *  - 会话可**归档**：归档后只读、不接收新消息、可取消归档
 *  - 可多选成员组成小群私聊（DM-01：人对人、人对 Agent、多参与者小群）
 *  - 只唤醒该会话的参与者，其他成员零调用
 *
 * §15.2 尚未给私信命令面编号（命令面并入 M3，由 C8 分批边界表分配），
 * 因此本页写操作统一以 LOCAL_ONLY 标注。
 */

import { useMemo, useState, useEffect } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, Modal, Tag, memberColor } from '../components/ui';
import { Composer } from '../components/Composer';
import { PreviewPane } from '../components/PreviewPane';
import { useStore, setState, recordLocalOnly, toast } from '../data/store';
import { submitDmMessage } from '../data/actions';
import { byId, memberLabel } from '../data/selectors';
import { clockTime, fullTime, relTime } from '../lib/format';
import type { DmConversation } from '../data/types';
/* UX-PREVIEW-01：私信资源同样走共享预览（§17.9 第 7 条） */
import { attachmentsOfMessage, audienceAllows } from '../lib/resource';
import { openPreview } from '../data/actions-preview';
import { useElementWidth } from '../lib/useElementWidth';
import { SIDEBAR_WIDTH } from '../lib/layout';

const newId = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/**
 * 私信页（第十五批 §17.7 第 6 条）。
 *
 * `projectId` 由路由传入（`/project/:id/dm`）。旧的 `/dm` 与 `/dm/:memberId`
 * 保留兼容：前者按当前项目，后者**先从成员实体解析其所属项目**再打开，
 * 避免两个项目里的同名成员串线。
 */
export function DmPage({ memberId, projectId: projectIdProp }: { memberId?: string; projectId?: string } = {}) {
  const s = useStore((x) => x);

  /**
   * 项目归属判定顺序：
   *  1. 路由显式给的 projectId（/project/:id/dm）
   *  2. 成员实体自己的 projectId（/dm/:memberId —— 同名成员不能靠当前项目猜）
   *  3. 当前项目
   */
  const memberProjectId = memberId
    ? s.members.find((m) => m.id === memberId)?.projectId
    : undefined;
  const projectId = projectIdProp ?? memberProjectId ?? s.activeProjectId;
  const all = useMemo(() => s.dms.filter((d) => d.projectId === projectId), [s.dms, projectId]);
  const active = all.filter((d) => !d.archivedAt).sort(sortDm);
  const archived = all.filter((d) => d.archivedAt).sort(sortDm);

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState<DmConversation | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // /dm/:memberId 直达：优先选中含该成员的 1 对 1 会话，其次含它的任意会话
  const preferred = memberId
    ? active.find((d) => d.memberIds.length === 1 && d.memberIds[0] === memberId)
      ?? active.find((d) => d.memberIds.includes(memberId))
    : undefined;
  const selected = all.find((d) => d.id === selectedId) ?? preferred ?? active[0];
  const members = s.members.filter((m) => m.projectId === projectId);

  /** 当前 DM 上下文可见的预览标签（audience 隔离，§17.9 第 7 条） */
  const previewTabs = useStore((x) => x.preview.tabs);
  const previewHidden = useStore((x) => x.preview.hidden);
  const dmHasPreview = Boolean(
    !previewHidden && selected && previewTabs.some((t) => {
      const res = s.resources.find((r) => r.id === t.resourceId);
      return res
        ? audienceAllows(res.audience, {
            kind: 'dm', projectId, conversationId: selected.id, threadId: selected.threadId,
          })
        : false;
    }),
  );

  /**
   * 私信页的布局解析（§17.9 第 2 条 + §5.3）。
   *
   * 私信页横向有：应用导航 / 会话列表 / 对话 / （可选）预览。
   * 其中**会话列表是导航性质**（选哪个私聊），不是内容区域，
   * 所以"内容区域"只有对话与预览两块 —— 符合"最多两个内容区域"。
   *
   * 但仍必须按实际可用宽度决定能否并排：实测 1087px CSS 宽时
   * 导航 246 + 列表 320 + 对话 440 + 预览 480 放不下，
   * 不处理就会把预览压到 353px（低于候选下限，正文不可读）。
   *
   * 降级顺序与房间页一致：先收窄列表，再切单区域（对话/文件二选一）。
   */
  const dmBody = useElementWidth<HTMLDivElement>('.app-body');
  const dmAvailable = Math.max(320, dmBody.width - SIDEBAR_WIDTH);
  const DM_LIST_W = 320;
  const DM_MIN_CONTEXT = 440;
  const DM_MIN_PREVIEW = 480;

  /** 列表能否保留（保留列表 + 对话 + 预览是否放得下） */
  const dmKeepList =
    dmAvailable >= DM_LIST_W + DM_MIN_CONTEXT + DM_MIN_PREVIEW + 8;
  /** 不保留列表、但对话 + 预览能并排 */
  const dmTwoRegion =
    dmHasPreview && (dmAvailable >= DM_MIN_CONTEXT + DM_MIN_PREVIEW + 8);
  /** 连两块都放不下 → 单区域（对话 / 文件二选一） */
  const dmSingle = dmHasPreview && !dmTwoRegion;

  const [dmRegion, setDmRegion] = useState<'context' | 'preview'>('context');
  useEffect(() => {
    if (dmHasPreview) setDmRegion('preview');
    else setDmRegion('context');
  }, [dmHasPreview]);

  const dmShowContext = !dmSingle || dmRegion === 'context';
  const dmShowPreview = dmHasPreview && (!dmSingle || dmRegion === 'preview');
  /** 单区域或空间不足时收起会话列表，把宽度让给两块内容 */
  const dmShowList = !dmHasPreview || dmKeepList;

  return (
    <>
      {/* 单区域时的「对话 / 文件」切换器（与房间页同一交互，§5.3 第 4 条） */}
      {dmSingle ? (
        <div className="single-region-switch">
          <div className="seg" role="group" aria-label="显示区域">
            <button className={dmRegion === 'context' ? 'on' : ''} onClick={() => setDmRegion('context')}>
              <Icon name="message-square" size={12} /> 对话
            </button>
            <button className={dmRegion === 'preview' ? 'on' : ''} onClick={() => setDmRegion('preview')}>
              <Icon name="file-text" size={12} /> 文件
            </button>
          </div>
          <span className="small faint">
            空间不足，已切为单区域；隐藏区域仍保留阅读位置与草稿
          </span>
        </div>
      ) : null}

      {/* 左：会话列表（空间不足时让位给两块内容，仍可从空态/切换器回到对话） */}
      {dmShowList ? (
      <div className="col-main" style={{ maxWidth: 320, flex: '0 0 320px', borderRight: '1px solid var(--border)' }}>
        <div className="pool-head" style={{ padding: '12px 14px 8px' }}>
          <Icon name="message-square" size={15} className="faint" />
          <span className="pool-title">私信</span>
          <Tag plain data-batch="M3">M3 批次</Tag>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => setCreateOpen(true)} title="新建私聊">
            <Icon name="plus" size={12} />
          </button>
        </div>

        <div className="dm-list">
          {active.length === 0 ? (
            <div className="small faint" style={{ padding: 14 }}>
              还没有私聊。点右上角 + 新建一个。
            </div>
          ) : (
            active.map((d) => (
              <DmRow
                key={d.id}
                dm={d}
                selected={d.id === selected?.id}
                onSelect={() => {
                  setSelectedId(d.id);
                }}
                onArchive={() => setArchiveOpen(d)}
                members={members}
              />
            ))
          )}

          {archived.length > 0 ? (
            <>
              <button
                className="dm-archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
                title="归档的私聊只读，可取消归档"
              >
                <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={12} />
                <Icon name="archive" size={12} />
                已归档 {archived.length}
              </button>
              {showArchived
                ? archived.map((d) => (
                    <DmRow
                      key={d.id}
                      dm={d}
                      archived
                      selected={d.id === selected?.id}
                      onSelect={() => setSelectedId(d.id)}
                      onArchive={() => setArchiveOpen(d)}
                      members={members}
                    />
                  ))
                : null}
            </>
          ) : null}
        </div>
      </div>
      ) : null}

      {/* 对话区：两区并排时固定到可读下限（440），余量给预览；
          单区域时占满。这样宽度是确定的，不会与预览互相挤压。 */}
      {dmShowContext ? (
      <div
        className="col-thread"
        style={{
          flex: dmSingle ? '1 1 100%' : dmTwoRegion ? `0 0 ${DM_MIN_CONTEXT}px` : '1 1 auto',
          width: 'auto',
          minWidth: 0,
          borderLeft: dmShowList ? 'none' : undefined,
        }}
      >
        {!selected ? (
          <EmptyState
            icon="message-square"
            title="选择或新建一个私聊"
            detail="私信使用独立的可见范围与会话。同一个成员可以有多个私聊——不同话题分开，互不串上下文。"
          />
        ) : (
          <DmConversationView
            dm={selected}
            onOpenSettings={() => setSettingsOpen(true)}
            onArchive={() => setArchiveOpen(selected)}
            onOpenResource={(id, rev) => {
              openPreview(id, rev, {
                target: {
                  kind: 'dm', projectId, conversationId: selected.id, threadId: selected.threadId,
                },
              });
            }}
          />
        )}
      </div>
      ) : null}

      {/* 私信预览：context 是 DM audience，因此群聊资源在这里不可见，
          私信资源切到群聊时也会被暂藏（双向隔离）。
          宽度：两区并排时吃掉余量；单区域时占满。 */}
      {selected && dmShowPreview ? (
        <PreviewPane
          context={{ kind: 'dm', projectId, conversationId: selected.id, threadId: selected.threadId }}
          quoteTarget={{ draftKey: `dm:${selected.id}`, label: `与 ${selected.title} 的私信` }}
          className="dm-preview"
          singleRegion={dmSingle}
          onBackToContext={() => setDmRegion('context')}
          flexStyle={{
            flex: dmSingle ? '1 1 100%' : '1 1 auto',
            minWidth: dmSingle ? 0 : DM_MIN_PREVIEW,
          }}
        />
      ) : null}

      {settingsOpen && selected ? (
        <DmSettingsModal
          dm={selected}
          members={members}
          onClose={() => setSettingsOpen(false)}
          onArchive={() => {
            setSettingsOpen(false);
            setArchiveOpen(selected);
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateDmModal
          projectId={projectId}
          members={members}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setSelectedId(id);
            setCreateOpen(false);
          }}
        />
      ) : null}

      {archiveOpen ? (
        <ArchiveDmModal
          dm={archiveOpen}
          members={members}
          onClose={() => setArchiveOpen(null)}
          onDone={() => setArchiveOpen(null)}
        />
      ) : null}
    </>
  );
}

function sortDm(a: DmConversation, b: DmConversation) {
  if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
  return b.lastMessageAt - a.lastMessageAt;
}

function DmRow({
  dm,
  members,
  selected,
  archived,
  onSelect,
  onArchive,
}: {
  dm: DmConversation;
  members: { id: string; displayName: string; ordinal?: number }[];
  selected: boolean;
  archived?: boolean;
  onSelect: () => void;
  onArchive: () => void;
}) {
  const people = dm.memberIds.map((id) => byId(members as never, id)).filter(Boolean) as {
    id: string;
    displayName: string;
    ordinal?: number;
  }[];
  return (
    <div className={`dm-row${selected ? ' on' : ''}${archived ? ' archived' : ''}`} onClick={onSelect}>
      <div className="dm-row-avatars">
        {people.slice(0, 3).map((m) => (
          <Avatar key={m.id} name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={18} round />
        ))}
      </div>
      <div className="dm-row-body">
        <div className="row tight">
          <span className="dm-row-title truncate">{dm.title}</span>
          {dm.pinned ? <Icon name="pin" size={11} className="faint" /> : null}
          {dm.unread > 0 && !archived ? <Tag tone="info" icon="message-square">{dm.unread}</Tag> : null}
        </div>
        <div className="dm-row-meta">
          {people.map((m) => (m.ordinal && m.ordinal > 1 ? `${m.displayName}#${m.ordinal}` : m.displayName)).join('、')}
          <span className="faint"> · {archived ? '已归档' : relTime(dm.lastMessageAt)}</span>
        </div>
      </div>
      {!archived ? (
        <button
          className="icon-btn sm"
          title="归档这个私聊"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
        >
          <Icon name="archive" size={13} />
        </button>
      ) : null}
    </div>
  );
}

function DmConversationView({
  dm,
  onOpenSettings,
  onArchive,
  onOpenResource,
}: {
  dm: DmConversation;
  onOpenSettings: () => void;
  /** 归档态下输入条直接提供「取消归档」，避免提示指路却找不到入口 */
  onArchive: () => void;
  /** UX-PREVIEW-01：在共享预览打开私信资源（独立 audience） */
  onOpenResource?: (resourceId: string, revision?: number) => void;
}) {
  const s = useStore((x) => x);
  const people = dm.memberIds.map((id) => s.members.find((m) => m.id === id)).filter(Boolean);
  const archived = Boolean(dm.archivedAt);
  const msgs = s.messages.filter((m) => m.threadId === dm.threadId).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <>
      <div className="thread-head">
        <div className="thread-head-row">
          <div className="dm-row-avatars">
            {people.slice(0, 3).map((m) => m && (
              <Avatar key={m.id} name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} round />
            ))}
          </div>
          <span className="strong">{dm.title}</span>
          {archived ? <Tag tone="neutral" icon="archive">已归档 · 只读</Tag> : <Tag plain data-batch="M3">M3 批次</Tag>}
          <div className="spacer" />
          {/* 会话级设置统一从头部菜单进，头部不再摆一排平级按钮 */}
          <button className="icon-btn sm" title="会话设置（改名 / 置顶 / 归档）" onClick={onOpenSettings}>
            <Icon name="more-horizontal" size={14} />
          </button>
        </div>
      </div>

      <div className="msg-list">
        {msgs.length === 0 ? (
          <EmptyState
            icon="message-square"
            title="这个私聊还没有消息"
            detail={`直接发消息给 ${people.map((m) => (m ? memberLabel(m) : '')).join('、')} 即可；同一个成员可以有多条私聊，互不串上下文。`}
          />
        ) : (
          msgs.map((m) => {
            /**
             * 私信附件：**独立 audience**（§17.9 第 7 条）。
             * 只有本会话能打开；切到群聊时这些标签会被暂藏，
             * 且"已打开"列表里也不露出文件名。
             */
            const links = attachmentsOfMessage(s, m.id);
            return (
            <div key={m.id} className="msg">
              <div className="msg-avatar">
                <Avatar name="我" color="var(--m-human)" size={22} round />
              </div>
              <div className="msg-body">
                <div className="msg-head">
                  <span className="msg-author">你</span>
                  <span className="msg-time">{clockTime(m.createdAt)}</span>
                  {m.threadMessageSeq ? <span className="msg-seq">#{m.threadMessageSeq}</span> : null}
                </div>
                <div className="msg-text">{m.body}</div>

                {links.length > 0 ? (
                  <div className="msg-attach-row">
                    {links.map((link) => {
                      const res = s.resources.find((r) => r.id === link.resourceId);
                      if (!res) return null;
                      return (
                        <button
                          key={link.id}
                          className="msg-attach"
                          title={`打开 ${res.title} · 只在本私信可见（不进入房间或公共成果）`}
                          onClick={() => onOpenResource?.(link.resourceId, link.revision)}
                        >
                          <Icon name="paperclip" size={12} />
                          <span className="truncate">{res.title}</span>
                          <span className="msg-attach-kind">私信</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
            );
          })
        )}
      </div>

      {/**
       * 私信输入区：与房间共用同一个组件，但**刻意做减法**（2026-09-25 用户决定）。
       *
       * 私聊是 1 对 1 的一问一答，不需要房间那套协作语义：
       *  · 不要「任务/讨论」——私信只有一种含义：把消息发给这个人；
       *  · 不要 @ 提及——会话里只有一位成员，@ 是多余的（成员边界仍由该会话决定）；
       *  · 不要「独立可见范围」「只唤醒 X；其他成员零调用」这类声明——
       *    1 对 1 会话本身就是私密的，摆一行说明只是噪声。
       * 因此这里关掉意图切换与提及，也不传 scopeChip / statusNote；
       * 附件、权限档位与「本次运行设置」保留（它们直接影响这次发给成员的内容与能力）。
       */}
      <Composer
        target={{ kind: 'dm', roomId: `dm:${dm.id}`, dmId: dm.id }}
        draftKey={`dm:${dm.id}`}
        showMentions={false}
        onSend={(p) => {
          submitDmMessage({
            dmId: dm.id,
            body: p.body,
            sendAs: p.sendAs,
            access: p.access,
            attachments: p.attachments,
            commandId: p.commandId,
          });
        }}
        sendDisabledReason={archived ? '该私信已归档：只读，取消归档后才能发送新内容' : undefined}
        sendDisabledLabel={archived ? '只读：已归档' : undefined}
        inputDisabledReason={archived ? '已归档：取消归档后才能发送' : undefined}
        extraAction={
          archived ? (
            <button className="btn sm" onClick={onArchive} title="归档只影响收发与提醒，历史与附件都保留">
              <Icon name="refresh" size={12} /> 取消归档
            </button>
          ) : undefined
        }
      />
    </>
  );
}

/* ---------------- 新建私聊：1 对 1，选一位项目成员 ---------------- */

function CreateDmModal({
  projectId,
  members,
  onClose,
  onCreated,
}: {
  projectId: string;
  members: { id: string; displayName: string; ordinal?: number; workState: string; model: string }[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const picked = pickedId ? [pickedId] : [];
  const pickedMember = members.find((m) => m.id === pickedId);
  const pickedName = pickedMember
    ? pickedMember.ordinal && pickedMember.ordinal > 1
      ? `${pickedMember.displayName}#${pickedMember.ordinal}`
      : pickedMember.displayName
    : '';
  const defaultTitle = () => pickedName;

  return (
    <Modal
      size="md"
      title="新建私聊"
      subtitle="1 对 1：选一位项目成员；同一个成员可以建多个私聊，互不串上下文"
      onClose={onClose}
      footer={
        <>
          <span className="small faint">
            {picked.length === 0 ? '请选择一位成员' : `将创建与 ${pickedName} 的私聊`}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={picked.length === 0}
            onClick={() => {
              const id = newId('dm');
              const t = title.trim() || defaultTitle();
              setState((st) => ({
                ...st,
                dms: [
                  ...st.dms,
                  {
                    id,
                    projectId,
                    title: t,
                    memberIds: picked,
                    threadId: newId('dm_thread'),
                    createdAt: Date.now(),
                    lastMessageAt: Date.now(),
                    unread: 0,
                  },
                ],
              }));
              recordLocalOnly(
                'dm.conversation.create',
                `conversation=${id} member=${pickedId} → 1 对 1；同一成员可有多条私聊`,
              );
              toast(`已创建与 ${t} 的私聊`, 'success');
              onCreated(id);
            }}
          >
            <Icon name="plus" size={12} /> 创建
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">选择成员（单选；私聊是 1 对 1）</label>
        <div className="col" style={{ gap: 6 }}>
          {members.map((m) => (
            <label key={m.id} className={`wpolicy${pickedId === m.id ? ' on' : ''}`} style={{ padding: '8px 10px' }}>
              <input
                type="radio"
                name="dm-member"
                checked={pickedId === m.id}
                onChange={() => setPickedId(m.id)}
              />
              <div className="row tight" style={{ flex: 1 }}>
                <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} />
                <span className="strong">{m.ordinal && m.ordinal > 1 ? `${m.displayName}#${m.ordinal}` : m.displayName}</span>
                <div className="spacer" />
                <span className="small faint">{m.model}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label">会话标题（可留空自动生成）</label>
        <input
          className="input"
          value={title}
          placeholder={defaultTitle() || '例如：Claude · 测试策略'}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {/* 2026-09-25 收敛：原来这里还有一块「私信的边界」说明（独立 audience、
          DIRECT 不能变相委派）与一行重复的"可以有多个私聊"。用户要求去掉
          「独立可见范围」这类描述，且副标题已经写明"1 对 1 / 一个成员可有多条"，
          因此整块删除而不是改写成另一段说明。 */}
    </Modal>
  );
}

/* ---------------- 会话设置（改名 / 置顶 / 归档入口） ---------------- */

function DmSettingsModal({
  dm,
  members,
  onClose,
  onArchive,
}: {
  dm: DmConversation;
  members: { id: string; displayName: string; ordinal?: number }[];
  onClose: () => void;
  onArchive: () => void;
}) {
  const [title, setTitle] = useState(dm.title);

  return (
    <Modal
      size="sm"
      title="会话设置"
      subtitle={dm.title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onArchive}>
            <Icon name={dm.archivedAt ? 'refresh' : 'archive'} size={12} />
            {dm.archivedAt ? '取消归档…' : '归档会话…'}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!title.trim()}
            onClick={() => {
              setState((st) => ({
                ...st,
                dms: st.dms.map((d) => (d.id === dm.id ? { ...d, title: title.trim() } : d)),
              }));
              recordLocalOnly('dm.conversation.rename', `conversation=${dm.id} → 标题改为「${title.trim()}」`);
              toast('会话标题已更新', 'success');
              onClose();
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">会话标题</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="field-hint">留空时由参与者名字自动生成；历史消息不受影响。</div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small">
          <span className="strong">置顶会话</span>
          <div className="small faint" style={{ marginTop: 2 }}>只影响你自己看到的排序（CH-06）</div>
        </span>
        <button
          className="btn sm"
          onClick={() => {
            setState((st) => ({
              ...st,
              dms: st.dms.map((d) => (d.id === dm.id ? { ...d, pinned: !d.pinned } : d)),
            }));
            recordLocalOnly('dm.conversation.pin', `conversation=${dm.id} → ${dm.pinned ? '取消置顶' : '置顶'}`);
            toast(dm.pinned ? '已取消置顶' : '已置顶', 'success');
          }}
        >
          <Icon name="pin" size={12} /> {dm.pinned ? '取消置顶' : '置顶'}
        </button>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        参与者：{dm.memberIds.map((id) => memberLabel(byId(members as never, id))).join('、')}。
        归档后只读、不接收新消息、不唤醒参与者；历史与附件保留，可取消归档。
      </div>
    </Modal>
  );
}

/* ---------------- 归档确认 ---------------- */

function ArchiveDmModal({
  dm,
  members,
  onClose,
  onDone,
}: {
  dm: DmConversation;
  members: { id: string; displayName: string; ordinal?: number }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const archived = Boolean(dm.archivedAt);
  return (
    <Modal
      size="sm"
      title={archived ? '取消归档' : '归档这个私聊'}
      subtitle={dm.title}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            onClick={() => {
              if (archived) {
                setState((st) => ({
                  ...st,
                  dms: st.dms.map((d) => (d.id === dm.id ? { ...d, archivedAt: undefined } : d)),
                }));
                recordLocalOnly('dm.conversation.unarchive', `conversation=${dm.id} → 取消归档`);
                toast('已取消归档：可以继续收发消息', 'success');
              } else {
                setState((st) => ({
                  ...st,
                  dms: st.dms.map((d) => (d.id === dm.id ? { ...d, archivedAt: Date.now() } : d)),
                }));
                recordLocalOnly(
                  'dm.conversation.archive',
                  `conversation=${dm.id} → 只读、不接收新消息；历史与附件保留，可取消归档`,
                );
                toast('已归档：会话变为只读，历史保留，随时可以取消归档', 'success');
              }
              onDone();
            }}
          >
            {archived ? '取消归档' : '归档'}
          </button>
        </>
      }
    >
      <div className={`panel ${archived ? 'info' : 'warning'}`}>
        <div className="panel-title">
          <Icon name={archived ? 'refresh' : 'archive'} size={13} />
          {archived ? '取消归档后可以继续收发' : '归档后会发生什么'}
        </div>
        {archived ? (
          '会话恢复为可读写，历史消息与附件都还在。'
        ) : (
          <>
            会话变为<strong>只读</strong>：不再接收新消息，也不会唤醒参与者（零模型调用）。
            历史消息、附件与任务关联全部保留，随时可以取消归档。
            归档不同于删除：不会移除任何记录。
          </>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <dl className="kv">
          <dt>参与者</dt>
          <dd>{dm.memberIds.map((id) => memberLabel(byId(members as never, id))).join('、')}</dd>
          <dt>创建时间</dt>
          <dd>{fullTime(dm.createdAt)}</dd>
          <dt>最近消息</dt>
          <dd>{relTime(dm.lastMessageAt)}</dd>
        </dl>
      </div>
    </Modal>
  );
}
