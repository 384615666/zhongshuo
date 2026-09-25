import { useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Tag,
  Tooltip,
} from 'sparkdesign'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { MemberAvatar } from '@/components/common/MemberIdentity'
import { InlineMeta, MetaDot, SectionLabel } from '@/components/common/Panel'
import {
  memberById,
  roomById,
  taskById,
  threadSubscriptions,
} from '@/data/mock'
import { offlineReasonView, presenceView } from '@/data/status'
import {
  excludeFromTaskRoster,
  joinTaskRoster,
  retryAbsentMember,
  setThreadFollow,
} from '@/lib/mutations'
import type { ThreadSummary, WorkflowRun } from '@/data/types'

/**
 * §4.3 + 决策 10 + §15 run.allowMissing：任务参与名单是可编辑的，但每次扩大或
 * 缩小范围都会产生新的 rosterRevision，而且要有据可查——
 * 「加入」要先看清对方会收到什么，「移出」要交代对共识结论的影响。
 *
 * 名单冻结（§4.3）不等于不能改：冻结的是「房间新增成员不会自动进正在跑的研讨」，
 * 用户主动加人仍然要走这里的确认。
 */
export function TaskRoster({
  run,
  onNotice,
}: {
  run: WorkflowRun
  onNotice?: (msg: string) => void
}) {
  const [pending, setPending] = useState<
    | { kind: 'join'; memberId: string }
    | { kind: 'remove'; memberId: string }
    | null
  >(null)
  const room = roomById(taskById(run.taskId)?.roomId ?? '')
  const task = taskById(run.taskId)
  const roster = run.rosterMemberIds.map(memberById)
  const absent = run.absentMemberIds.map(memberById)
  const excluded = (run.excludedMemberIds ?? []).map(memberById)
  const candidates = (room?.memberIds ?? [])
    .map(memberById)
    .filter((m) => !run.rosterMemberIds.includes(m.id))

  const confirm = () => {
    if (!pending) return
    if (pending.kind === 'join') {
      const rev = joinTaskRoster(run.id, pending.memberId)
      onNotice?.(
        `${memberById(pending.memberId).displayName} 已加入本任务名单，rosterRevision → ${rev}；TA 会先收到任务摘要再开始干活`,
      )
    } else {
      const rev = excludeFromTaskRoster(run.id, pending.memberId)
      onNotice?.(
        `已按现有成员继续：${memberById(pending.memberId).displayName} 移出本轮名单，rosterRevision → ${rev}；最终报告仍会列出 TA，且不会标注「全体一致」`,
      )
    }
    setPending(null)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <SectionLabel>参与名单 · roster rev {run.rosterRevision}</SectionLabel>
        <Tooltip
          content="§4.3：名单在创建运行时冻结；房间后来新增的成员不会自动进本轮研讨，要加人只能在这里确认。改名单会产生新的 rosterRevision。"
          side="top"
        >
          <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary">
            <ui.lock className="size-3" aria-hidden />
            冻结后可确认调整
          </span>
        </Tooltip>
      </div>

      <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
        {roster.map((m) => {
          const isAbsent = run.absentMemberIds.includes(m.id)
          return (
            <li key={m.id}>
              <span
                className={cn(
                  'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border-secondary bg-bg-container py-0.5 pr-0.5 pl-1.5 text-xs',
                  isAbsent && 'border-warning-border bg-warning-bg/40',
                )}
              >
                <MemberAvatar member={m} size="sm" showPresence={false} className="size-4" />
                <span className="truncate text-text">{m.displayName}</span>
                {isAbsent ? (
                  <Tooltip content="缺席：超时或失败。可以重试 TA，也可以按现有成员继续（后者会改名单版本）" side="top">
                    <Tag appearance="outline" color="warning" className="py-0 text-[10px]">
                      缺席
                    </Tag>
                  </Tooltip>
                ) : null}
                {isAbsent ? (
                  <Tooltip content="重试缺席成员：沿用当前名单，不产生新的 rosterRevision" side="top">
                    <IconButton
                      icon={<ui.rotate className="size-3.5" />}
                      aria-label={`重试缺席成员 ${m.displayName}`}
                      variant="iconOnly"
                      size="sm"
                      onClick={() => {
                        retryAbsentMember(run.id, m.id)
                        onNotice?.(`已对 ${m.displayName} 重发本轮调用：名单版本不变，结果随后并入`)
                      }}
                    />
                  </Tooltip>
                ) : null}
                <Tooltip
                  content="按现有成员继续（run.allowMissing）：把 TA 移出本轮名单，生成新的 rosterRevision，最终报告列出 TA 且不写「全体一致」"
                  side="top"
                >
                  <IconButton
                    icon={<ui.close className="size-3.5" />}
                    aria-label={`把 ${m.displayName} 移出本轮名单`}
                    variant="iconOnly"
                    size="sm"
                    onClick={() => setPending({ kind: 'remove', memberId: m.id })}
                  />
                </Tooltip>
              </span>
            </li>
          )
        })}

        <li>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1 font-normal">
                <ui.userPlus className="size-3.5" aria-hidden />
                加入成员
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[320px] p-2">
              <p className="px-1 pb-1.5 text-xs font-medium text-text">
                #{room?.name ?? '本房间'} 里还没进名单的成员
              </p>
              {candidates.length ? (
                <ul className="flex flex-col gap-0.5">
                  {candidates.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-fill-secondary"
                        onClick={() => setPending({ kind: 'join', memberId: m.id })}
                      >
                        <MemberAvatar member={m} size="sm" showPresence={false} />
                        <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                        <Tag
                          appearance="outline"
                          color={m.enabled && m.presence !== 'offline' ? 'slate' : 'warning'}
                          className="py-0 text-[10px]"
                        >
                          {m.enabled
                            ? m.presence === 'offline'
                              ? offlineReasonView[m.offlineReason ?? 'telemetry_unknown'].label
                              : presenceView[m.presence].label
                            : '未启用'}
                        </Tag>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-1 py-2 text-[11px] text-text-tertiary">
                  房间里的人都在名单里了。先去房间设置或成员页把人加进房间，再回来扩名单。
                </p>
              )}
              <p className="mt-1.5 border-t border-border-secondary px-1 pt-1.5 text-[11px] leading-relaxed text-text-tertiary">
                决策 10：@ 非参与者即表达「加入本任务」的意图，但要先看清 TA 会收到什么，确认后才扩大范围。
              </p>
            </PopoverContent>
          </Popover>
        </li>
      </ul>

      {excluded.length ? (
        <InlineMeta>
          <span className="text-text-tertiary">本轮已被你移出：</span>
          {excluded.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-1">
              {m.displayName}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  const rev = joinTaskRoster(run.id, m.id)
                  onNotice?.(`${m.displayName} 重新进名单，rosterRevision → ${rev}`)
                }}
              >
                再拉回来
              </button>
              <MetaDot />
            </span>
          ))}
          <span className="text-text-tertiary">历史发言与成果归属都保留</span>
        </InlineMeta>
      ) : null}

      {absent.length ? (
        <p className="text-[11px] leading-relaxed text-warning">
          {absent.map((m) => m.displayName).join('、')} 未回。按 §4.3 阶段屏障不会当成 TA 已完成，
          结论只能标「有条件共识」；等迟到成果到达后按阶段规则并入，并在报告里写明「迟到纳入」。
        </p>
      ) : null}

      <Dialog open={!!pending} onOpenChange={(open) => (!open ? setPending(null) : undefined)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'join'
                ? `把 ${pending ? memberById(pending.memberId).displayName : ''} 加进本任务名单？`
                : `按现有成员继续，移出 ${pending ? memberById(pending.memberId).displayName : ''}？`}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'join' ? (
                <span className="flex flex-col gap-1.5">
                  <span>TA 会先收到这份任务摘要，再开始本轮工作：</span>
                  <span className="rounded-md border border-border-secondary bg-bg-elevated p-2 text-xs text-text-secondary">
                    任务 {task?.id ?? run.taskId} · {task?.title ?? '（找不到任务）'}
                    <br />
                    目标：{task?.objective.slice(0, 60) ?? '—'}
                    <br />
                    模式 {run.mode} · 第 {run.roundNo} 轮 · 名单 {run.rosterMemberIds.length + 1} 人 ·{' '}
                    预算 {run.budget.turns} 次调用
                  </span>
                  <span>确认即扩大参与范围，并生成新的 rosterRevision。</span>
                </span>
              ) : (
                <span className="flex flex-col gap-1.5">
                  <span>这就是 §15 的 run.allowMissing：不中断还在跑的成员，用现有成果推进阶段屏障。</span>
                  <span>
                    会产生新 rosterRevision；最终报告必须列出被移出的成员，且不得标注「全体一致」。
                    TA 的历史发言、已交成果和归属都不会被删。
                  </span>
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPending(null)}>
              先不动
            </Button>
            <Button variant="primary" size="sm" onClick={confirm}>
              {pending?.kind === 'join' ? '确认加入并派任务摘要' : '确认按现有成员继续'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 决策 13B（§17.4）：任务串顶部列出跟进成员，支持移出；
 * 移出只停自动唤醒，历史保留，可以再次 @ 回来。
 * 讨论线程（root_task_id 为空）不显示这份名单（决策 21 / E1）。
 */
export function ThreadFollowers({
  thread,
  onNotice,
}: {
  thread: ThreadSummary
  onNotice?: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!thread.rootTaskId) return null
  const rows = threadSubscriptions.filter((s) => s.threadId === thread.id)
  const following = rows.filter((s) => s.followed).map((s) => memberById(s.memberId))
  const others = thread.participantIds
    .map(memberById)
    .filter((m) => !rows.some((s) => s.memberId === m.id))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 font-normal">
          <ui.messages className="size-3.5" aria-hidden />
          跟进 {following.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-2">
        <p className="px-1 pb-1.5 text-xs font-medium text-text">跟进本串的成员</p>
        {following.length ? (
          <ul className="flex flex-col gap-1">
            {following.map((m) => (
              <li key={m.id} className="flex min-w-0 items-center gap-2">
                <MemberAvatar member={m} size="sm" showPresence={false} />
                <span className="min-w-0 flex-1 truncate text-sm">{m.displayName}</span>
                <Button
                  variant="text"
                  size="sm"
                  textButton
                  onClick={() => {
                    setThreadFollow(thread.id, m.id, false)
                    onNotice?.(
                      `${m.displayName} 已移出跟进：不再被自动唤醒，历史保留，可以再 @ 回来`,
                    )
                  }}
                >
                  移出
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 py-1.5 text-[11px] text-text-tertiary">
            现在没人跟进这条串：没人被自动唤醒，但你 @ 谁仍然会叫醒谁。
          </p>
        )}
        {others.length ? (
          <>
            <Separator className="my-1.5" />
            <p className="px-1 pb-1 text-[11px] font-medium text-text-tertiary">重新关注</p>
            <ul className="flex flex-wrap gap-1">
              {others.map((m) => (
                <li key={m.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 font-normal"
                    onClick={() => {
                      setThreadFollow(thread.id, m.id, true)
                      onNotice?.(`${m.displayName} 重新关注本串`)
                    }}
                  >
                    <MemberAvatar member={m} size="sm" showPresence={false} className="size-4" />
                    {m.displayName}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="mt-1.5 border-t border-border-secondary px-1 pt-1.5 text-[11px] leading-relaxed text-text-tertiary">
          mute 只是通知偏好，不改变任务参与名单、消息读取授权或执行权限（§17.4）。
        </p>
      </PopoverContent>
    </Popover>
  )
}
