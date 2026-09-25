import type { ReactNode } from 'react'
import {
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Progress,
  Separator,
  Tag,
  Tooltip,
  toast,
} from 'sparkdesign'

import { cn } from '@/lib/cn'
import { statusIcons, ui } from '@/lib/icons'
import { MemberAvatar, MemberPresenceTooltip } from '@/components/common/MemberIdentity'
import { StatusTag } from '@/components/common/StatusTag'
import { InlineMeta, MetaDot } from '@/components/common/Panel'
import { fromNow, untilIn } from '@/lib/format'
import { memberById, savedItems, taskById } from '@/data/mock'
import { toggleSaved } from '@/lib/mutations'
import {
  approvalCopy,
  disputeStateView,
  formatCost,
  messageCardView,
  reviewStanceView,
  taskStatusView,
} from '@/data/status'
import type { Message } from '@/data/types'

export interface MessageActions {
  onOpenTask?: (taskId: string) => void
  onOpenRun?: (runId: string) => void
  onOpenArtifact?: (artifactId: string) => void
  onOpenDeliberation?: (disputeId: string) => void
  onOpenThread?: (threadId: string) => void
  /** 干预：task.steer / 暂停后续阶段 / task.stop */
  onIntervene?: (kind: 'steer' | 'pauseStages' | 'stop', taskId: string) => void
  onRespondApproval?: (approvalId: string, respond: 'allow_once' | 'deny') => void
  onRetry?: (messageId: string) => void
  /** MSG-04：Quote 引用插入输入条。引用本身不触发新任务（P0 口径） */
  onQuote?: (message: Message) => void
}

const claimLabel: Record<'observed' | 'inferred' | 'proposal', { text: string; tone: 'info' | 'purple' | 'warning' }> = {
  observed: { text: '实测', tone: 'info' },
  inferred: { text: '推断', tone: 'purple' },
  proposal: { text: '建议', tone: 'warning' },
}

/** §17.3 八类消息卡的统一外壳：作者行 + 卡种标记 + 正文 + 载荷区 */
export function MessageRow({
  message,
  showAvatar = true,
  compact = false,
  actions,
  className,
}: {
  message: Message
  showAvatar?: boolean
  compact?: boolean
  actions?: MessageActions
  className?: string
}) {
  const card = messageCardView[message.cardKind]
  const CardIcon = statusIcons[card.icon]
  const author = memberById(message.authorId)
  const system = message.authorType === 'system'

  return (
    <article
      id={`msg-${message.id}`}
      data-card={message.cardKind}
      data-status={message.status}
      className={cn(
        'group/msg scroll-mt-2',
        compact ? 'px-3 py-2' : 'px-4 py-3',
        className,
      )}
    >
      <header className="mb-1 flex min-w-0 items-center gap-2">
        {showAvatar && author ? (
          <MemberPresenceTooltip member={author}>
            <MemberAvatar member={author} size="sm" />
          </MemberPresenceTooltip>
        ) : null}
        <div className="min-w-0 flex-1">
          <InlineMeta>
            <span className="truncate text-sm font-medium text-text">
              {author?.displayName ?? card.label}
            </span>
            {message.cardKind !== 'user' && !system ? (
              <Tag appearance="outline" color={card.tone} className="gap-1 py-0 text-[10px]">
                <CardIcon className="size-3" aria-hidden />
                {card.label}
              </Tag>
            ) : null}
            {author?.presence === 'busy' ? <span className="text-warning">正在跑别的任务</span> : null}
            <span className="text-text-tertiary">{fromNow(message.createdAt)}</span>
            {message.seq ? (
              <span className="font-mono text-text-tertiary">#{message.seq}</span>
            ) : null}
          </InlineMeta>
        </div>
        {message.threadId && actions?.onOpenThread ? (
          <Button
            variant="text"
            size="sm"
            textButton
            className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100"
            onClick={() => actions.onOpenThread?.(message.threadId as string)}
          >
            <ui.quote className="size-3.5" aria-hidden />
            在串里看
          </Button>
        ) : null}
        {system ? null : <MessageTools message={message} actions={actions} />}
      </header>

      <div className="min-w-0">
        <Body message={message} actions={actions} />
      </div>

      {message.reactions.length ? <Reactions message={message} /> : null}
      {message.status === 'streaming' ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-tertiary">
          <statusIcons.loader className="size-3 animate-spin" aria-hidden />
          正在生成，内容会原地更新，不会把你正在看的位置顶走
        </p>
      ) : null}
      {message.status === 'retracted' ? (
        <p className="mt-1 text-xs text-warning">这条消息已被撤回，历史串中仍保留占位以便追溯。</p>
      ) : null}
      {message.status === 'failed' ? (
        <div className="mt-1.5 flex items-center gap-2">
          <p className="text-xs text-error">本条投递失败，正文可能不完整。</p>
          {actions?.onRetry ? (
            <Button variant="outline" size="sm" onClick={() => actions.onRetry?.(message.id)}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

/**
 * MSG-04 消息操作（§1525 P0）：Reply in thread / Quote / Copy link / Copy text / Save。
 * 之前这一整排动作在原型里根本不存在，收藏只能在 Saved 页单向取消。
 */
function MessageTools({ message, actions }: { message: Message; actions?: MessageActions }) {
  const saved = savedItems.some((s) => s.messageId === message.id)
  const copy = (text: string, label: string) => {
    if (!navigator.clipboard) {
      toast(`${label}无法写入剪贴板（本机未开放）：内容已展开在消息里`)
      return
    }
    navigator.clipboard.writeText(text).then(
      () => toast(`已复制${label}：只进剪贴板，不扩大 agent 可读范围`),
      () => toast(`${label}复制失败：本机剪贴板被拒绝，原文仍在消息里`),
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          icon={<ui.more className="size-3.5" />}
          variant="iconOnly"
          size="sm"
          aria-label={`消息 ${message.seq || message.id} 的操作`}
          className="shrink-0 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <DropdownMenuLabel>消息操作</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            const nowSaved = toggleSaved(message)
            toast(
              nowSaved
                ? '已收藏（message.save）：进 Saved 页，不改变谁能读到这条'
                : '已取消收藏：只影响你的列表，原文与历史不动',
            )
          }}
        >
          <ui.star className="size-4" aria-hidden />
          {saved ? '取消收藏' : '收藏到 Saved'}
        </DropdownMenuItem>
        {actions?.onQuote ? (
          <DropdownMenuItem onSelect={() => actions.onQuote?.(message)}>
            <ui.quote className="size-4" aria-hidden />
            引用到输入条
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => copy(message.body, '整条文字')}>
          <ui.copy className="size-4" aria-hidden />
          复制文字
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            copy(`${window.location.href.split('#')[0]}#msg-${message.id}`, '消息链接')
          }
        >
          <ui.link className="size-4" aria-hidden />
          复制消息链接
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] leading-relaxed text-text-tertiary">
          引用不会自动派工（P0 口径）：要转成任务就引用后 @ 成员，由 @ 结构推导模式。
          表情只是表态，既不是授权也不是共识票（MSG-03）。
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Body({
  message,
  actions,
}: {
  message: Message
  actions?: MessageActions
}) {
  switch (message.cardKind) {
    case 'progress':
      return <ProgressCard message={message} actions={actions} />
    case 'assignment':
      return <AssignmentCard message={message} actions={actions} />
    case 'report':
      return <ReportCard message={message} actions={actions} />
    case 'dispute':
      return <DisputeCard message={message} actions={actions} />
    case 'approval':
      return <ApprovalCard message={message} actions={actions} />
    case 'result':
      return <ResultCard message={message} actions={actions} />
    case 'system':
      return (
        <p className="rounded-md bg-fill-secondary px-2.5 py-1.5 text-xs text-text-secondary">
          {message.body}
        </p>
      )
    default:
      return (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">
          {renderBody(message)}
        </p>
      )
  }
}

/** mention 用文字高亮，不用 emoji 当投票 */
function renderBody(message: Message): ReactNode {
  if (!message.mentionIds.length) return message.body
  const parts: ReactNode[] = []
  let rest = message.body
  message.mentionIds.forEach((id, i) => {
    const name = memberById(id)?.displayName
    if (!name) return
    const at = rest.indexOf(`@${name}`)
    if (at < 0) return
    if (at > 0) parts.push(rest.slice(0, at))
    parts.push(
      <span key={`${id}-${i}`} className="rounded bg-primary-bg px-0.5 font-medium text-primary">
        @{name}
      </span>,
    )
    rest = rest.slice(at + name.length + 1)
  })
  parts.push(rest)
  return parts
}

/** 成员进度：缺席要显式交代等谁、等了多久，并给出两种不同的干预 */
function ProgressCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const p = message.payload?.progress
  if (!p) return <p className="text-sm text-text">{message.body}</p>
  const waiting = p.waitingForMemberId ? memberById(p.waitingForMemberId) : undefined
  const task = taskById(p.taskId)
  return (
    <Card className="gap-0 py-3">
      <div className="flex items-center gap-2 px-3.5">
        <p className="text-sm text-text">{message.body}</p>
        <span className="ml-auto font-mono text-xs text-text-tertiary">
          {p.done}/{p.total}
        </span>
      </div>
      <Progress
        value={(p.done / p.total) * 100}
        className="mx-3.5 mt-2"
        aria-label={`已完成 ${p.done} / ${p.total}`}
      />
      {waiting ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 px-3.5">
          <Tag appearance="outline" color="warning" className="gap-1">
            <ui.clock className="size-3" aria-hidden />
            等 {waiting.displayName}（已 {p.waitingMinutes} 分钟）
          </Tag>
          <span className="text-xs text-text-tertiary">
            TA 缺席不影响已完成的 {p.done} 份结果
          </span>
          {task ? (
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => actions?.onIntervene?.('steer', task.id)}
              >
                立即调整
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => actions?.onIntervene?.('pauseStages', task.id)}
              >
                暂停后续阶段
              </Button>
              <Button variant="ghost" size="sm" onClick={() => actions?.onIntervene?.('stop', task.id)}>
                立即停止
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <Separator className="my-2.5" />
      <InlineMeta className="px-3.5">
        <button
          type="button"
          className="flex items-center gap-1 text-primary hover:underline"
          onClick={() => actions?.onOpenRun?.(p.runId)}
        >
          <ui.terminal className="size-3.5" aria-hidden />
          查看运行详情与工具输出
        </button>
        {task ? (
          <>
            <MetaDot />
            <button
              type="button"
              className="hover:underline"
              onClick={() => actions?.onOpenTask?.(task.id)}
            >
              任务 #{task.roomTaskNumber}
            </button>
            <StatusTag view={taskStatusView[task.status]} dense appearance="outline" />
          </>
        ) : null}
      </InlineMeta>
    </Card>
  )
}

/** 分工卡：被 @全体 时冻结名单，写清楚谁做什么、各分多少轮 */
function AssignmentCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const a = message.payload?.assignment
  return (
    <Card className="gap-0 py-3">
      <p className="px-3.5 text-sm text-text">{message.body}</p>
      {a ? (
        <>
          <ul className="mt-2 flex flex-col gap-2 px-3.5">
            {a.items.map((item) => {
              const m = memberById(item.memberId)
              return (
                <li key={item.memberId} className="flex items-start gap-2">
                  {m ? <MemberAvatar member={m} size="sm" showPresence={false} /> : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text">{m?.displayName ?? item.memberId}</p>
                    <p className="text-xs text-text-secondary">{item.brief}</p>
                  </div>
                  <Tag appearance="outline" color="slate" className="shrink-0">
                    {item.budgetTurns} 轮预算
                  </Tag>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 px-3.5 text-xs text-text-tertiary">
            名单在本轮已冻结（{a.frozenRoster.length} 名成员）；中途加人不改变本轮结果口径。
            {actions?.onOpenTask ? (
              <button
                type="button"
                className="ml-1 text-primary hover:underline"
                onClick={() => actions.onOpenTask?.(a.taskId)}
              >
                进任务详情
              </button>
            ) : null}
          </p>
        </>
      ) : null}
    </Card>
  )
}

/** 报告卡：区分实测 / 推断 / 建议，并标出是否存在分歧 */
function ReportCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const r = message.payload?.report
  return (
    <Card className="gap-0 py-3">
      <div className="flex items-start gap-2 px-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">{r?.title ?? message.body}</p>
          {r ? (
            <InlineMeta className="mt-0.5">
              <span>第 {r.version} 版</span>
              {r.hasDisagreement ? (
                <>
                  <MetaDot />
                  <span className="text-orange">存在不同结论，未合并</span>
                </>
              ) : null}
            </InlineMeta>
          ) : null}
        </div>
        {r?.artifactId ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => actions?.onOpenArtifact?.(r.artifactId)}
          >
            看成果
          </Button>
        ) : null}
      </div>
      {r?.claims.length ? (
        <ul className="mt-2.5 flex flex-col gap-1.5 px-3.5">
          {r.claims.map((claim, i) => (
            <li key={i} className="flex items-start gap-2">
              <Tag
                appearance="outline"
                color={claimLabel[claim.kind].tone}
                className="shrink-0 py-0 text-[10px]"
              >
                {claimLabel[claim.kind].text}
              </Tag>
              <span className="text-sm leading-relaxed text-text-secondary">{claim.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

/** 争议卡：状态 + 引用 + 各方立场，缺席时不写「全体一致」 */
function DisputeCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const d = message.payload?.dispute
  if (!d) return <p className="text-sm text-text">{message.body}</p>
  return (
    <Card className="gap-0 border-l-2 border-l-orange py-3">
      <div className="flex flex-wrap items-center gap-2 px-3.5">
        <StatusTag view={disputeStateView[d.state]} dense />
        <span className="text-sm font-medium text-text">第 {d.round} 轮争议</span>
        <Button
          variant="text"
          size="sm"
          textButton
          className="ml-auto"
          onClick={() => actions?.onOpenDeliberation?.(d.disputeId)}
        >
          进研讨详情
          <ui.chevronRight className="size-3.5" aria-hidden />
        </Button>
      </div>
      <p className="mt-1 px-3.5 text-sm text-text-secondary">{message.body}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 px-3.5">
        {d.stances.map((s) => {
          const m = memberById(s.memberId)
          const view = reviewStanceView[s.stance]
          return (
            <Tag key={s.memberId} appearance="outline" color={view.tone} className="gap-1.5">
              {m ? <MemberAvatar member={m} size="sm" showPresence={false} className="size-4 text-[9px]" /> : null}
              {m?.displayName ?? s.memberId}
              <span className="font-normal">{view.label}</span>
            </Tag>
          )
        })}
      </div>
      {d.cites.length ? (
        <InlineMeta className="mt-2 px-3.5">
          <span>引用：</span>
          {d.cites.map((c, i) => (
            <span key={i} className="font-mono text-[11px]">
              v{c.reportVersion}·{c.section}
              {i < d.cites.length - 1 ? '，' : ''}
            </span>
          ))}
        </InlineMeta>
      ) : null}
    </Card>
  )
}

/** 授权卡：范围 + 过期时间，只有 allow_once / deny 两个动作 */
function ApprovalCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const ap = message.approval
  if (!ap) return <p className="text-sm text-text">{message.body}</p>
  const decided = ap.responded !== null
  return (
    <Card className="gap-0 border-warning-bg bg-warning-bg/40 py-3">
      <div className="flex items-center gap-2 px-3.5">
        <StatusTag view={messageCardView.approval} dense />
        <span className="text-sm font-medium text-text">{approvalCopy(ap)}</span>
      </div>
      <pre className="mx-3.5 mt-2 max-h-[120px] overflow-auto rounded-md bg-bg-container p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
        {ap.scopeJson}
      </pre>
      {decided ? (
        <p className="mt-2 px-3.5 text-xs text-text-tertiary">
          已{ap.responded === 'allow_once' ? '允许一次' : '拒绝'}，授权不延伸到其它目录或后续任务。
        </p>
      ) : (
        <div className="mt-2.5 flex items-center gap-2 px-3.5">
          <Button
            variant="primary"
            size="sm"
            onClick={() => actions?.onRespondApproval?.(ap.id, 'allow_once')}
          >
            允许一次
          </Button>
          <Button variant="outline" size="sm" onClick={() => actions?.onRespondApproval?.(ap.id, 'deny')}>
            拒绝
          </Button>
          <Tooltip content="过期后请求自动作废，需要重新发起；不会静默放行">
            <span className="ml-auto text-xs text-text-tertiary">
              {ap.expiresAt && untilIn(ap.expiresAt) === '已过期'
                ? '授权已过期，需重新发起'
                : `${untilIn(ap.expiresAt)}后过期`}
            </span>
          </Tooltip>
        </div>
      )}
    </Card>
  )
}

/** 结果卡：停止≠撤销，残留改动与归因必须交代；费用 unknown 不许显示 0 */
function ResultCard({ message, actions }: { message: Message; actions?: MessageActions }) {
  const r = message.payload?.result
  if (!r) return <p className="text-sm text-text">{message.body}</p>
  const artifact = r.artifactId
  return (
    <Card className="gap-0 py-3">
      <div className="flex flex-wrap items-center gap-2 px-3.5">
        <p className="text-sm text-text">{message.body}</p>
        <Tag appearance="outline" color="slate" className="ml-auto">
          {formatCost(r.cost)}
        </Tag>
        {artifact ? (
          <Button variant="outline" size="sm" onClick={() => actions?.onOpenArtifact?.(artifact)}>
            打开成果
          </Button>
        ) : null}
      </div>
      {r.residualDiff?.length ? (
        <div className="mx-3.5 mt-2.5 rounded-md border border-border-secondary bg-bg-container p-2.5">
          <p className="text-xs font-medium text-orange">
            任务被中断，以下是已落盘的残留改动。停止不等于撤销，需要你逐个处置。
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {r.residualDiff.map((d) => (
              <li key={d.file} className="flex items-center gap-2 font-mono text-[11px]">
                <ui.fileDiff className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
                <span className="truncate text-text-secondary">{d.file}</span>
                <span className="ml-auto shrink-0 text-success">+{d.additions}</span>
                <span className="shrink-0 text-error">−{d.deletions}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}

/** 表情只做表态，不能充当授权或共识票 */
function Reactions({ message }: { message: Message }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {message.reactions.map((r) => (
        <Tooltip
          key={r.emoji}
          content={`${r.by.map((id) => memberById(id)?.displayName ?? id).join('、')} 的表态；表情不构成授权或共识`}
          placement="top"
        >
          <Tag appearance="outline" color="slate" className="gap-1 py-0">
            <span aria-hidden>{r.emoji}</span>
            {r.by.length}
          </Tag>
        </Tooltip>
      ))}
    </div>
  )
}

/** 主池里的「任务串入口」行 */
export function ThreadEntryRow({
  message,
  onOpenThread,
}: {
  message: Message
  onOpenThread: (threadId: string) => void
}) {
  const count = taskById(message.taskId ?? '')
  return (
    <button
      type="button"
      onClick={() => onOpenThread(message.threadId ?? '')}
      className={cn(
        'ml-10 mt-1 flex items-center gap-2 rounded-md border border-dashed border-border',
        'px-2.5 py-1.5 text-left text-xs text-text-secondary transition-colors',
        'hover:border-primary hover:bg-fill-secondary',
      )}
    >
      <ui.quote className="size-3.5 shrink-0" aria-hidden />
      这条消息已开串{count ? `（任务 #${count.roomTaskNumber}）` : ''}
      <span className="ml-auto flex items-center gap-1 text-primary">
        进入回复串
        <ui.chevronRight className="size-3" aria-hidden />
      </span>
    </button>
  )
}
