import { useState } from 'react'
import {
  Button,
  IconButton,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Tooltip,
} from 'sparkdesign'

import { cn } from '@/lib/cn'
import { statusIcons, ui } from '@/lib/icons'
import { InlineMeta, KVDL, MetaDot, SectionLabel } from '@/components/common/Panel'
import { StatusTag } from '@/components/common/StatusTag'
import { EmptyState } from '@/components/common/States'
import { MessageList } from '@/components/workspace/MessageList'
import type { MessageActions } from '@/components/workspace/MessageCards'
import { MemberAvatar } from '@/components/common/MemberIdentity'
import { clock } from '@/lib/format'
import { artifactById, memberById, messagesForThread, roomById, tasks, turns } from '@/data/mock'
import { FollowMembersPopover } from '@/components/overlays/RoomOverlays'
import { TaskRoster, ThreadFollowers } from '@/components/workspace/TaskRoster'
import { markArtifactDelivered, wakeNewParticipant } from '@/lib/mutations'
import { parseMentions } from '@/lib/routing'
import {
  consensusLabel,
  formatCost,
  runStatusView,
  turnStatusView,
  deliveryStatusView,
  workspaceStatusView,
  missingCount,
} from '@/data/status'
import type { AgentProfile, Artifact, Message, ThreadSummary, WorkflowRun } from '@/data/types'

/**
 * §17.1 右栏：「任务 #N 的回复串」= 回复 / 成果 / 活动 三个页签。
 * 关闭它绝不等于停止任务，这条必须在按钮上就说清楚。
 */
export function ThreadRail({
  thread,
  run,
  messages,
  actions,
  onClose,
  onBackToPool,
  onReply,
  onNotice,
  className,
}: {
  thread?: ThreadSummary
  run?: WorkflowRun
  messages?: Message[]
  actions: MessageActions
  onClose?: () => void
  onBackToPool?: () => void
  onReply?: (text: string, targetTaskId?: string) => void
  onNotice?: (msg: string) => void
  className?: string
}) {
  const [tab, setTab] = useState('replies')
  const pool = messages ?? (thread ? messagesForThread(thread.id) : [])

  if (!thread) {
    return (
      <aside className={cn('flex min-h-0 flex-col border-l border-border-secondary bg-bg-base', className)}>
        <EmptyState
          title="没有打开的回复串"
          description="在主池点任意一条已开串的消息，这里会显示它的完整回复线。关掉这里不会影响正在跑的后台任务。"
          icon={<ui.quote className="size-5" aria-hidden />}
          action={
            onClose ? (
              <Button variant="outline" size="sm" onClick={onClose}>
                收起右栏
              </Button>
            ) : undefined
          }
          className="h-full"
        />
      </aside>
    )
  }

  // E3 定案：串输入框可按子任务定向跟进，标签取房间任务号
  const subTasks = tasks
    .filter((t) => t.parentTaskId === thread.rootTaskId)
    .map((t) => ({ id: t.id, label: `#${t.roomTaskNumber} ${t.title}`.slice(0, 24) }))

  /** 决策 10：串内 @ 了不在本任务名单里的房间成员 → 确认后扩大参与范围，而不是静默忽略 */
  const roomMembers = (roomById(thread.roomId)?.memberIds ?? []).map(memberById)
  const rosterIds = run?.rosterMemberIds ?? thread.participantIds

  return (
    <aside
      className={cn('flex min-h-0 flex-col border-l border-border-secondary bg-bg-base', className)}
      aria-label={`任务回复串 ${thread.id}`}
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-secondary px-4 py-3">
        {onBackToPool ? (
          <Button variant="text" size="sm" textButton className="-ml-1.5" onClick={onBackToPool}>
            <ui.chevronLeft className="size-3.5" aria-hidden />
            返回主池
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text">
            任务 {thread.rootTaskId} 的回复串
          </p>
          <InlineMeta className="mt-0.5">
            <span>{thread.replyCount} 条回复</span>
            <MetaDot />
            <span>{thread.participantIds.length} 位参与者</span>
            <MetaDot />
            <span>最后一条 {clock(thread.lastReplyAt)}</span>
            <MetaDot />
            <span>seq {thread.lastMessageSeq}</span>
          </InlineMeta>
        </div>
        <FollowMembersPopover
          threadId={thread.id}
          memberIds={[
            ...new Set([
              ...thread.participantIds,
              ...(roomById(thread.roomId)?.memberIds ?? []),
            ]),
          ]}
          onNotice={onNotice}
        />
        {onClose ? (
          <Tooltip content="只是收起右栏；后台任务继续跑，不会被停止" side="bottom">
            <IconButton
              icon={<ui.close className="size-4" />}
              aria-label="收起回复串（不停止任务）"
              variant="iconOnly"
              size="sm"
              onClick={onClose}
            />
          </Tooltip>
        ) : null}
      </header>

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList variant="line" className="shrink-0 px-3">
          <TabsTrigger variant="line" value="replies">
            回复
          </TabsTrigger>
          <TabsTrigger variant="line" value="artifacts">
            成果
          </TabsTrigger>
          <TabsTrigger variant="line" value="activity">
            活动
          </TabsTrigger>
        </TabsList>

        <TabsContent value="replies" className="flex min-h-0 flex-1 flex-col">
          {run ? (
            <div className="shrink-0 border-b border-border-secondary bg-bg-base px-3 py-2">
              <TaskRoster run={run} onNotice={onNotice} />
              <ThreadFollowers thread={thread} onNotice={onNotice} />
            </div>
          ) : null}
          <MessageList messages={pool} actions={actions} emptyTitle="这条串还没有回复" />
          {onReply ? (
            <ReplyBox
              onReply={onReply}
              subTasks={subTasks}
              roomMembers={roomMembers}
              rosterIds={rosterIds}
              onExpandRoster={
                run
                  ? (memberId) => {
                      const revision = wakeNewParticipant(thread.id, run.id, memberId)
                      onNotice?.(
                        `已按你的 @ 把 ${memberById(memberId).displayName} 加入本任务：` +
                          `rosterRevision → ${revision}，TA 会先读任务摘要再接手（决策 10）。名单变更只影响这个任务。`,
                      )
                    }
                  : undefined
              }
            />
          ) : null}
        </TabsContent>

        <TabsContent value="artifacts" className="min-h-0 flex-1 overflow-y-auto p-3">
          <ArtifactList
            ids={[thread.finalArtifactRef].filter((x): x is string => !!x)}
            actions={actions}
            absentCount={missingCount(run)}
            onNotice={onNotice}
          />
          {run ? (
            <p className="mt-2 px-1 text-[11px] text-text-tertiary">
              本轮共 {run.budget.used}/{run.budget.turns} 次调用；未合入的成果仍会留在「成果」页签。
            </p>
          ) : null}
        </TabsContent>

        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto p-3">
          <ActivityPanel run={run} thread={thread} actions={actions} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

function ReplyBox({
  onReply,
  subTasks,
  roomMembers,
  rosterIds,
  onExpandRoster,
}: {
  onReply: (text: string, targetTaskId?: string) => void
  subTasks: { id: string; label: string }[]
  roomMembers?: AgentProfile[]
  rosterIds?: string[]
  onExpandRoster?: (memberId: string) => void
}) {
  const [text, setText] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  /** 决策 10 的确认态：@ 到非参与者时不静默忽略，也不自动扩大范围，先问一句 */
  const [pendingExpand, setPendingExpand] = useState<string[] | null>(null)
  const targetTask = subTasks.find((t) => t.id === target)

  const outsiders = (roomMembers ?? []).filter(
    (m) => !(rosterIds ?? []).includes(m.id),
  )

  const finish = () => {
    setText('')
    setPendingExpand(null)
  }

  const submit = () => {
    const content = text.trim()
    if (!content) return
    const hits = onExpandRoster && roomMembers?.length
      ? parseMentions(content, roomMembers)
          .map((h) => (h.kind === 'member' ? h.memberId : null))
          .filter((id): id is string => !!id && !(rosterIds ?? []).includes(id))
      : []
    if (hits.length) {
      setPendingExpand(hits)
      return
    }
    onReply(content, target ?? undefined)
    finish()
  }

  return (
    <form
      className="shrink-0 border-t border-border-secondary p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {subTasks.length ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-tertiary">定向跟进：</span>
          {subTasks.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={target === t.id}
              onClick={() => setTarget(target === t.id ? null : t.id)}
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                target === t.id
                  ? 'border-primary bg-primary-bg text-primary'
                  : 'border-border-secondary text-text-tertiary hover:bg-fill-secondary',
              )}
            >
              → 子任务 {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={
            targetTask
              ? `只发给「${targetTask.label}」的负责人（task.steer）；不经协调者转述`
              : '在串里回复；@ 只叫醒名单内的参与者，@ 到名单外的人会让你先确认'
          }
          className="min-w-0 flex-1 resize-none rounded-md border border-border-secondary bg-bg-elevated px-2.5 py-2 text-sm text-text outline-none placeholder:text-text-tertiary focus-visible:border-primary"
        />
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>
          回复
        </Button>
      </div>
      {pendingExpand?.length ? (
        <div className="mt-1.5 rounded-md border border-border-secondary bg-fill-secondary px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-text-secondary">
            这条回复 @ 了不在本任务名单里的{' '}
            <span className="font-medium text-text">
              {pendingExpand.map((id) => memberById(id).displayName).join('、')}
            </span>
            （房间里有 {outsiders.length} 位非参与者可选）。要叫醒 TA 需要先确认扩大参与范围：
            名单变更只影响这个任务，会推进 rosterRevision 并给新成员一份任务摘要。
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                pendingExpand?.forEach((id) => onExpandRoster?.(id))
                onReply(text.trim(), target ?? undefined)
                finish()
              }}
            >
              确认加入并发送
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPendingExpand(null)}>
              先不改名单
            </Button>
          </div>
        </div>
      ) : null}
      <p className="mt-1 text-[11px] text-text-tertiary">
        {targetTask
          ? 'E3 定案：选中的子任务走 task.steer 直达该负责人，本串仍留一份可见记录。'
          : '串内回复不会往主池刷屏；要单独跟进某个子任务，点上面的「→ 子任务」。@ 到非参与者时会先要你确认（决策 10）。'}
      </p>
    </form>
  )
}

/** 成果页签：区分「接受」（直接落项目）与「应用到项目」（走 worktree） */
export function ArtifactList({
  ids,
  actions,
  dense = false,
  absentCount = 0,
  onNotice,
}: {
  ids: string[]
  actions?: MessageActions
  dense?: boolean
  /** 本轮缺席 + 被允许缺席的人数：>0 时「全体一致」必须降级为有条件共识 */
  absentCount?: number
  onNotice?: (msg: string) => void
}) {
  const items = ids.map((id) => artifactById(id)).filter((a): a is Artifact => !!a)
  if (!items.length) {
    return (
      <EmptyState
        title="还没有成果"
        description="成员产出报告或补丁后会出现在这里；在此之前你可以先看活动页签的调用记录。"
        icon={<ui.fileCode className="size-5" aria-hidden />}
      />
    )
  }
  return (
    <ul className={cn('flex flex-col', dense ? 'gap-1.5' : 'gap-2.5')}>
      {items.map((a) => {
        const creator = memberById(a.createdByMemberId)
        const worktree = a.deliveryMode === 'worktree_apply'
        const state = a.deliveryState ?? 'pending'
        return (
          <li key={a.id}>
            <div className="rounded-lg border border-border-secondary bg-bg-container p-3">
              <div className="flex items-start gap-2">
                <Tag appearance="outline" color="slate" className="shrink-0">
                  {kindLabel[a.kind]}
                </Tag>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">
                    {a.title}
                    <span className="ml-1 text-xs text-text-tertiary">v{a.version}</span>
                  </p>
                  <InlineMeta className="mt-0.5">
                    {creator ? <MemberAvatar member={creator} size="sm" showPresence={false} className="size-4" /> : null}
                    <span>{creator?.displayName ?? '未知作者'}</span>
                    <MetaDot />
                    <span>{clock(a.createdAt)}</span>
                  </InlineMeta>
                </div>
                {state !== 'pending' ? (
                  <Tag appearance="outline" color="success" className="shrink-0 py-0 text-[10px]">
                    {state === 'applied' ? '已应用到隔离副本' : '已接受到当前目录'}
                  </Tag>
                ) : null}
              </div>

              <p className="mt-2 text-xs text-text-secondary">
                {consensusLabel(a.consensus, absentCount)}
                {a.consensus === 'disputed' ? '：结论仍有争议，先不要当成定稿。' : ''}
              </p>

              {a.files.length ? (
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {a.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 font-mono text-[11px]">
                      <ui.fileDiff className="size-3 shrink-0 text-text-tertiary" aria-hidden />
                      <span className="truncate text-text-secondary">{f.path}</span>
                      <span className="ml-auto shrink-0 text-success">+{f.additions}</span>
                      <span className="shrink-0 text-error">−{f.deletions}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-2.5 flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => actions?.onOpenArtifact?.(a.id)}>
                  预览
                </Button>
                {state !== 'pending' ? (
                  <span className="text-[11px] text-text-tertiary">
                    {worktree ? '已提交到隔离副本，等待合并' : '已写回当前目录'} · 要反悔请去「文件与改动」逐个撤销
                  </span>
                ) : (
                  <Tooltip
                    content={
                      worktree
                        ? '应用到项目：改动先落在托管 worktree / 快照，确认后才合并进你的目录'
                        : '接受：直接写回当前工作目录，会立即改变你正在用的文件'
                    }
                    side="top"
                  >
                    <Button
                      variant={worktree ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        markArtifactDelivered(a.id, a.deliveryMode)
                        onNotice?.(
                          worktree
                            ? `已把「${a.title}」应用到托管 worktree：合并前你的目录不会被改动`
                            : `已接受「${a.title}」到当前目录：改动可在「文件与改动」里逐个撤销`,
                        )
                      }}
                    >
                      {worktree ? '应用到项目' : '接受'}
                    </Button>
                  </Tooltip>
                )}
                <span className="ml-auto text-[11px] text-text-tertiary">
                  {worktree ? '走隔离副本' : '直写当前目录'}
                </span>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const kindLabel: Record<Artifact['kind'], string> = {
  report: '报告',
  patch: '补丁',
  plan: '计划',
  dataset: '数据集',
  prototype: '原型',
}

/** 活动页签：run / turn / delivery 三个层次，工具输出折叠进运行详情 */
function ActivityPanel({
  run,
  thread,
  actions,
}: {
  run?: WorkflowRun
  thread: ThreadSummary
  actions: MessageActions
}) {
  if (!run) {
    return (
      <EmptyState
        title="这条串没有关联的运行"
        description="可能只是讨论存而不派工；没有调用就没有额度消耗。"
        icon={<ui.workflow className="size-5" aria-hidden />}
      />
    )
  }
  const absent = run.absentMemberIds.map((id) => memberById(id)).filter(Boolean)
  const excluded = (run.excludedMemberIds ?? []).map((id) => memberById(id)).filter(Boolean)
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>运行 {run.id}</SectionLabel>
      <KVDL
        items={[
          { key: '状态', value: <StatusTag view={runStatusView[run.status]} dense /> },
          { key: '模式 / 阶段', value: `${run.mode} · ${run.stage}（第 ${run.roundNo} 轮）`, mono: true },
          {
            key: '预算',
            value: `${run.budget.used}/${run.budget.turns} 次调用 · ${formatCost(run.budget.spent)}`,
          },
          { key: '任务修订', value: `rev ${run.taskRevision}`, mono: true },
          { key: '名单修订', value: `roster rev ${run.rosterRevision}`, mono: true },
          {
            key: '工作目录',
            value: <StatusTag view={workspaceStatusView[run.workspace]} dense appearance="outline" />,
          },
        ]}
      />

      {absent.length || excluded.length ? (
        <div className="rounded-md border border-warning-border bg-warning-bg/50 p-2.5">
          {absent.length ? (
            <p className="text-xs text-text">
              本轮缺席 {absent.length} 名成员：{absent.map((m) => m?.displayName).join('、')}。
              已完成的结论仍然有效，但不构成全体一致。
            </p>
          ) : null}
          {excluded.length ? (
            <p className="mt-1 text-xs text-text">
              你已允许 {excluded.length} 名成员缺席本轮：
              {excluded.map((m) => m?.displayName).join('、')}
              （run.allowMissing）。TA 们仍可在「参与名单」里被拉回来，迟到成果按 §4.3 的阶段规则并入。
            </p>
          ) : null}
          <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
            缺席与被允许缺席都会写进最终报告，共识一律降级为「有条件共识」。
          </p>
        </div>
      ) : null}

      <Separator />

      <div className="flex flex-col gap-2">
        <SectionLabel>调用记录</SectionLabel>
        <TurnRows runId={run.id} thread={thread} actions={actions} />
      </div>
    </div>
  )
}

function TurnRows({
  runId,
  thread,
  actions,
}: {
  runId: string
  thread: ThreadSummary
  actions: MessageActions
}) {
  const turns = turnIndex(runId)
  if (!turns.length) {
    return (
      <p className="px-1 text-xs text-text-tertiary">
        这条串关联的运行还没有调用记录（未派工或已取消）。参与者：
        {thread.participantIds.map((id) => memberById(id)?.displayName).join('、')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {turns.map((t) => {
        const m = memberById(t.memberId)
        const Icon = statusIcons[t.status === 'RUNNING' ? 'loader' : t.status === 'SUCCEEDED' ? 'check' : 'circle-dot']
        return (
          <li key={t.id} className="rounded-md border border-border-secondary bg-bg-container px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {m ? <MemberAvatar member={m} size="sm" showPresence={false} /> : null}
              <span className="truncate text-sm text-text">{m?.displayName ?? t.memberId}</span>
              <StatusTag view={turnStatusView[t.status]} dense appearance="outline" />
              <Tag appearance="outline" color={t.delivery === 'SETTLED' ? 'success' : 'warning'} className="ml-auto shrink-0 py-0 text-[10px]">
                {deliveryStatusView[t.delivery].label}
              </Tag>
            </div>
            <InlineMeta className="mt-1 font-mono text-[10px]">
              <span>{t.stageKey}</span>
              <MetaDot />
              <span>attempt {t.attempt}</span>
              <MetaDot />
              <span>epoch {t.epoch}</span>
            </InlineMeta>
            <p className="mt-1 flex items-center gap-1 text-[11px] text-text-tertiary">
              <Icon className={cn('size-3', t.status === 'RUNNING' && 'animate-spin')} aria-hidden />
              {t.toolCalls.length} 次工具调用 · 输出已折叠
              <button
                type="button"
                className="ml-1 text-primary hover:underline"
                onClick={() => actions.onOpenRun?.(runId)}
              >
                去运行详情
              </button>
            </p>
          </li>
        )
      })}
    </ul>
  )
}

/** 就地追加的 mock 数组不做模块级缓存，否则新派发的 run 会读不到刚写入的 turn */
function turnIndex(runId: string) {
  return turns.filter((t) => t.runId === runId)
}
