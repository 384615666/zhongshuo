import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  ChatInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
import { memberById } from '@/data/mock'
import { routingModeView } from '@/data/status'
import { deriveRouting, parseMentions, type MessageKind } from '@/lib/routing'
import { setRoomWorkspaceMode, submitRoomMessage } from '@/lib/mutations'
import { useProto } from '@/lib/store'
import type { AgentProfile, Room, Task } from '@/data/types'

type RoomWorkspaceMode = NonNullable<Room['workspaceMode']>

/**
 * §4.1 + §4.2 + E6 定案（L252）：
 *
 * 发送前必须持续显示「协作模式 / 参与者 / 工作目录 / 分析或修改权限」，
 * 但**协作模式不可手选**——它由输入里的 @ 结构推导。
 * 输入条只保留两类控件：「任务 / 讨论」切换，加一颗随 @ 结构变化的「方式」芯片。
 *
 * 之前这里是一个手选模式下拉：标签写「M0 只开放 @单成员」，芯片却常年显示
 * 「指定成员」，切换还会被 disabled 项吞掉没有任何反馈——这就是报的显示 bug。
 * 现在模式是推导出来的只读预览，@ 一变预览就跟着变。
 */
export function Composer({
  room,
  members,
  workingDir,
  archived,
  generating,
  quote,
  onAppendSent,
  onStop,
  onNotice,
}: {
  room: { id: string; name: string; coordinatorMemberId: string; workspaceMode?: RoomWorkspaceMode }
  members: AgentProfile[]
  workingDir: string
  archived?: boolean
  generating?: boolean
  /** MSG-04：往输入条追加一段草稿；at 变化才算一次新动作 */
  quote?: { text: string; at: number } | null
  /** 发送成功后由页面决定要不要跳进新串；消息写入已在 mutations 完成 */
  onAppendSent: (info: { threadId: string; taskId: string | null }) => void
  onStop?: () => void
  onNotice?: (msg: string) => void
}) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MessageKind>('task')
  const [intent, setIntent] = useState<Task['intent']>('analyze')
  const [method, setMethod] = useState(false)
  const at = quote?.at
  /**
   * 引用只往输入条放文本、不发送，也**不自动 @**：§1525 P0 写明「引用不会直接触发新任务」。
   * 要派工得用户自己 @；插入内容由页面决定（任务卡的「调整指示」会带上负责人 @）。
   */
  useEffect(() => {
    if (!quote?.text) return
    setText((prev) => {
      const token = quote.text.trim()
      if (token.startsWith('@') && prev.includes(token)) return prev
      return prev.trim() ? `${prev.trimEnd()}\n${quote.text}` : quote.text
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在新的引用动作（at 变化）时插入一次
  }, [at])
  /** 能力位（M0 开放哪些模式）被改动时，这里要立刻重算预览 */
  const rev = useProto()
  /** 同一次提交内容复用同一个 commandId，重复点击不会造出第二个任务（§16.5 IDEMPOTENCY_CONFLICT） */
  const [commandId, setCommandId] = useState(() => newCommandId())

  const coordinator = memberById(room.coordinatorMemberId)
  /** 工作目录读房间状态位而不是组件本地 state：切了之后换个页面回来还得是同一个值 */
  const workspaceMode: RoomWorkspaceMode = room.workspaceMode ?? 'project_root'
  const pickWorkspace = (mode: RoomWorkspaceMode) => {
    const applied = setRoomWorkspaceMode(room.id, mode)
    onNotice?.(
      applied
        ? `本房间的派发目录已切到${mode === 'managed_worktree' ? '托管 worktree：改动先落隔离副本，验证后再确认合并' : '项目根目录：改动直接落在你正在使用的目录上'}（原型不动磁盘）`
        : `这里已经是${mode === 'managed_worktree' ? '托管 worktree' : '项目根目录'}，不重复写入`,
    )
  }
  /** 「分工执行」才走含一次修订的 7N+2；「跳过独立首稿」不减这条上限，只省 INDEPENDENT 的调用 */
  const mentionsAll = useMemo(
    () => parseMentions(text, members).some((h) => h.kind === 'all'),
    [text, members],
  )
  const routing = useMemo(
    () =>
      deriveRouting({
        text,
        members,
        coordinatorMemberId: room.coordinatorMemberId,
        kind,
        revisionPath: method && !mentionsAll,
      }),
    [text, members, room.coordinatorMemberId, kind, method, mentionsAll, rev],
  )

  const view = routingModeView[routing.mode]
  const ModeIcon = MODE_ICON[routing.mode] ?? ui.users
  const sendHint = archived
    ? '房间已归档：只读。存草稿可以，派工不行（ROOM_ARCHIVED）'
    : !routing.openInM0
      ? `${view.label} 在 M0 未开放，这条会被拒绝；改成 @单个成员 即可派工`
      : routing.derivedFrom

  const send = (value: string) => {
    const content = value.trim()
    if (!content) return
    if (archived || !routing.openInM0) {
      onNotice?.(sendHint)
      return
    }
    const info = submitRoomMessage({
      roomId: room.id,
      body: content,
      routing,
      intent,
      commandId,
    })
    onAppendSent(info)
    setText('')
    setMethod(false)
    setCommandId(newCommandId())
  }

  /** 「插入 @」是结构化 mention 节点的替身：正式版由输入框节点承载，不靠文本匹配 */
  const insertMention = (target: AgentProfile | 'all') => {
    const token = target === 'all' ? '@全体 ' : `@${target.displayName} `
    setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${token}`.trimStart())
  }

  return (
    <div className="shrink-0 border-t border-border-secondary bg-bg-container px-4 pb-3 pt-2">
      {/* §4.1 发送前常驻预览：模式（推导）· 参与者（推导）· 工作目录 · 权限 */}
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
        <Tooltip content={`${routing.derivedFrom}｜模式由 @ 结构推导，不可手选（E6 定案）`} side="top">
          <span
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border-secondary bg-bg-elevated px-1.5 py-1 text-xs"
            aria-label={`协作模式 ${view.label}`}
          >
            <ModeIcon
              className={cn('size-3.5 shrink-0', routing.openInM0 ? 'text-text-secondary' : 'text-warning')}
              aria-hidden
            />
            <span className="text-text-tertiary">模式</span>
            <span className="font-medium text-text">{view.label}</span>
            {!routing.openInM0 ? (
              <Tag appearance="outline" color="warning" className="py-0 text-[10px]">
                M0 未开放
              </Tag>
            ) : null}
          </span>
        </Tooltip>

        <ParticipantChip routing={routing} members={members} coordinatorName={coordinator.displayName} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5 font-normal">
              {workspaceMode === 'managed_worktree' ? (
                <ui.compare className="size-3.5" aria-hidden />
              ) : (
                <ui.folderTree className="size-3.5" aria-hidden />
              )}
              <span className="text-text-tertiary">目录</span>
              <span className="font-medium text-text">
                {workspaceMode === 'managed_worktree' ? '托管 worktree' : '项目根目录'}
              </span>
              <span className="max-w-[150px] truncate font-mono text-xs">{workingDir}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[320px]">
            <DropdownMenuLabel>工作目录</DropdownMenuLabel>
            <DropdownMenuItem
              aria-current={workspaceMode === 'project_root'}
              onSelect={() => pickWorkspace('project_root')}
            >
              <ui.folderTree className="size-4" aria-hidden />
              项目根目录
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-current={workspaceMode === 'managed_worktree'}
              onSelect={() => pickWorkspace('managed_worktree')}
            >
              <ui.compare className="size-4" aria-hidden />
              托管 worktree（隔离副本）
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-[11px] leading-relaxed text-text-tertiary">
              {workspaceMode === 'managed_worktree'
                ? '改动先落托管副本并建快照，你在副本里验证后再确认合并；期间你的目录保持不变。'
                : '改动直接落在你正在使用的目录上，覆盖同名文件前会先建快照。'}{' '}
              当前房间「{room.name}」的协调者是 {coordinator.displayName}；切换只改本房间的状态位，原型不动磁盘。
            </p>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip
          content={
            intent === 'analyze'
              ? '只分析：本轮不派修改。v0.1 拦不住写入，看到的仍是「文件与改动」里的真实变化'
              : '要修改：允许成员改工作目录，改动仍以 diff 形式等你处置'
          }
          side="top"
        >
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 font-normal"
            aria-pressed={intent === 'modify'}
            onClick={() => setIntent(intent === 'analyze' ? 'modify' : 'analyze')}
          >
            {intent === 'analyze' ? (
              <ui.eye className="size-3.5" aria-hidden />
            ) : (
              <ui.pencil className="size-3.5" aria-hidden />
            )}
            权限：{intent === 'analyze' ? '只分析' : '要修改'}
          </Button>
        </Tooltip>

        {/* E6：唯一的「方式」芯片，随 @ 结构换含义，默认全关 */}
        <MethodChip routing={routing} kind={kind} on={method} onToggle={() => setMethod((prev) => !prev)} />

        {/* E6：任务 / 讨论 切换 */}
        <div className="ml-auto flex items-center gap-1 rounded-md border border-border-secondary bg-bg-elevated p-0.5">
          {(['task', 'discuss'] as MessageKind[]).map((key) => (
            <Button
              key={key}
              variant={kind === key ? 'secondary' : 'text'}
              size="sm"
              textButton={kind !== key}
              aria-pressed={kind === key}
              className="px-2"
              onClick={() => setKind(key)}
            >
              {key === 'task' ? '任务' : '讨论'}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 items-end gap-2">
        <ChatInput
          value={text}
          onChange={setText}
          onSend={send}
          maxRows={6}
          showFooter={false}
          className="min-w-0 flex-1"
          placeholder={
            archived
              ? '房间已归档：可保存草稿，不能派工'
              : kind === 'discuss'
                ? '只讨论：这条会存档但不派工，也不消耗额度（决策 21）'
                : `发送到 #${room.name}：不 @ → 自动协作；@单个成员 → 直接派工；@全体 → 研讨并冻结名单`
          }
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" aria-label="插入 @ 成员" className="shrink-0 gap-1">
              <ui.at className="size-3.5" aria-hidden />
              @
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[320px] p-2">
            <p className="px-1 pb-1.5 text-xs font-medium text-text">插入 mention（文本替身）</p>
            <ul className="flex flex-col gap-0.5">
              <li>
                <MentionRow
                  label="全体（冻结房间内启用的全部 agent）"
                  icon={<ui.users className="size-4 shrink-0 text-text-secondary" aria-hidden />}
                  onClick={() => insertMention('all')}
                />
              </li>
              <Separator className="my-1" />
              {members.map((m) => (
                <li key={m.id}>
                  <MentionRow
                    label={m.displayName}
                    hint={mentionHint(m)}
                    avatar={<MemberAvatar member={m} size="sm" showPresence={false} />}
                    onClick={() => insertMention(m)}
                  />
                </li>
              ))}
            </ul>
            <p className="mt-1.5 border-t border-border-secondary px-1 pt-1.5 text-[11px] leading-relaxed text-text-tertiary">
              正式版是输入框里的结构化 mention 节点（§4.1）：Markdown 引用、代码块、文件正文里的 @ 不产生执行语义，这里按同一规则已排除。
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
        <Tag appearance="outline" color={routing.openInM0 ? 'slate' : 'warning'} className="py-0 text-[10px]">
          预算 {routing.budgetFormula}
        </Tag>
        <span className="truncate font-mono text-[10px] text-text-tertiary">commandId {commandId}</span>
        <span className="text-[11px] text-text-tertiary">同一条内容重复提交只派生一个任务</span>
        {generating && onStop ? (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onStop}>
            <ui.stop className="size-3.5" aria-hidden />
            停止本次派发
          </Button>
        ) : null}
        <span
          className={cn('ml-auto min-w-0 truncate text-[11px]', routing.openInM0 && !archived ? 'text-text-tertiary' : 'text-warning')}
        >
          {sendHint}
        </span>
      </div>
    </div>
  )
}

/** 参与者芯片：完全由 @ 结构推导，点 tooltip 说明来源，不给手选入口 */
function ParticipantChip({
  routing,
  members,
  coordinatorName,
}: {
  routing: ReturnType<typeof deriveRouting>
  members: AgentProfile[]
  coordinatorName: string
}) {
  const picked = routing.participantIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is AgentProfile => !!m)
  const label =
    routing.mode === 'DISCUSS'
      ? '不派工'
      : routing.mode === 'AUTO'
        ? `协调者 ${coordinatorName} 接单`
        : picked.length === 1
          ? picked[0]!.displayName
          : `${picked.length} 名成员${routing.freezesRoster ? '（名单冻结）' : ''}`
  return (
    <Tooltip
      content={
        routing.mode === 'DISCUSS'
          ? '讨论只存档：永不唤醒 agent，也不生成跟进名单'
          : `${routing.derivedFrom}${
              routing.freezesRoster
                ? `；冻结名单：${picked.map((m) => m.displayName).join('、')}`
                : ''
            }`
      }
      side="top"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
        <ui.userPlus className="size-3.5 shrink-0" aria-hidden />
        <span className="text-text-tertiary">参与者</span>
        <span className="flex min-w-0 items-center gap-1">
          {picked.slice(0, 3).map((m) => (
            <MemberAvatar key={m.id} member={m} size="sm" showPresence={false} className="size-4" />
          ))}
          <span className="truncate font-medium text-text">{label}</span>
        </span>
      </span>
    </Tooltip>
  )
}

function MethodChip({
  routing,
  kind,
  on,
  onToggle,
}: {
  routing: { mode: string; mentionsAll: boolean }
  kind: MessageKind
  on: boolean
  onToggle: () => void
}) {
  const key = methodCopyKey(routing, kind)
  const { chip, note } = METHOD_COPY[key]
  if (!chip) return null
  return (
    <Tooltip content={note} side="top">
      <Button
        variant={on ? 'secondary' : 'outline'}
        size="sm"
        className="font-normal"
        aria-pressed={on}
        onClick={onToggle}
      >
        {chip}
      </Button>
    </Tooltip>
  )
}

/** E6：三颗芯片互斥地出现在不同 @ 结构下，默认全关 */
const METHOD_COPY = {
  plan: {
    chip: '先给方案再执行',
    note: '决策 03：不 @ 时提供「先给方案再执行」开关，默认关',
  },
  skipDraft: {
    chip: '跳过独立首稿',
    note: '决策 05：@全体 时提供「跳过独立首稿」，会把 INDEPENDENT 阶段的额度省下来',
  },
  split: {
    chip: '分工执行',
    note: '决策 09：多个 @ 时提供「分工执行」，走含一次修订的 7N+2 额度',
  },
  none: { chip: '', note: '' },
} as const

type MethodKey = keyof typeof METHOD_COPY

/** @全体 与多个 @ 都推导成 DELIBERATE，靠 mentionsAll 区分该给哪颗芯片 */
function methodCopyKey(routing: { mode: string; mentionsAll: boolean }, kind: MessageKind): MethodKey {
  if (kind === 'discuss') return 'none'
  if (routing.mode === 'AUTO') return 'plan'
  if (routing.mode !== 'DELIBERATE') return 'none'
  return routing.mentionsAll ? 'skipDraft' : 'split'
}

const MODE_ICON: Record<string, typeof ui.users> = {
  AUTO: ui.sparkles,
  DIRECT: ui.userPlus,
  DELIBERATE: ui.layers,
  DISCUSS: ui.message,
}

function mentionHint(m: AgentProfile): string {
  if (!m.enabled) return '未启用 · 不可派工'
  if (m.presence === 'offline') return `${m.runtime} · ${m.offlineReason === 'disconnected' ? '连接断开' : '离线'}`
  return `${m.runtime} · ${m.presence === 'busy' ? '忙碌' : m.presence === 'error' ? '异常' : '在线'}`
}

function MentionRow({
  label,
  hint,
  avatar,
  icon,
  onClick,
}: {
  label: string
  hint?: string
  avatar?: React.ReactNode
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-fill-secondary"
    >
      {avatar ?? icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[11px] text-text-tertiary">{hint}</span> : null}
    </button>
  )
}

let seq = 0
function newCommandId(): string {
  seq += 1
  return `cmd-${Date.now().toString(36)}-${seq}`
}
