import { useEffect, useMemo, useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tag,
} from 'sparkdesign'

import { ui } from '@/lib/icons'
import { navigate } from '@/lib/router'
import {
  agentProfiles,
  errorNotices,
  projects,
  recoveryPrompt,
  roomById,
  rooms,
  taskById,
  tasks,
  threadSummaries,
} from '@/data/mock'
import { errorCopy, taskStatusView } from '@/data/status'
import { StatusTag } from '@/components/common/StatusTag'
import type { ErrorCode } from '@/data/types'

/** ⌘K / Ctrl+K 全局搜索：§27.2 要求一次输入同时命中项目、房间、消息串、任务、成员 */
export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [term, setTerm] = useState('')
  const q = term.trim().toLowerCase()

  const hits = useMemo(() => {
    const match = (s: string | undefined) => (!q ? true : !!s && s.toLowerCase().includes(q))
    return {
      projects: projects.filter((p) => match(p.displayName) || match(p.rootPath)),
      threads: threadSummaries.filter(
        (t) => t.previews.some((p) => match(p)) || match(taskById(t.rootTaskId)?.title),
      ),
      tasks: tasks.filter(
        (t) => match(t.title) || match(t.objective) || match(`#${t.roomTaskNumber}`),
      ),
      rooms: rooms.filter((r) => match(r.name) || match(r.description)),
      members: agentProfiles.filter((m) => match(m.displayName) || match(m.responsibility)),
    }
  }, [q])

  const go = (to: string) => () => {
    onOpenChange(false)
    navigate(to)
  }

  const nothing =
    !hits.projects.length &&
    !hits.threads.length &&
    !hits.tasks.length &&
    !hits.rooms.length &&
    !hits.members.length

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="搜索"
      description="搜索项目、房间、消息串、任务和成员"
      showCloseButton={false}
    >
      <CommandInput
        placeholder="输入关键词，如「支付」「小满」「#12」"
        value={term}
        onValueChange={setTerm}
      />
      <CommandList>
        {nothing ? (
          <CommandEmpty>没有匹配结果，可以试试任务编号（#12）或成员显示名</CommandEmpty>
        ) : null}

        {hits.projects.length ? (
          <CommandGroup heading="项目">
            {hits.projects.map((p) => (
              <CommandItem key={p.id} value={`project:${p.id}`} onSelect={go(`/project/${p.id}`)}>
                <ui.folder className="size-4" aria-hidden />
                {p.displayName}
                <span className="ml-auto max-w-[240px] truncate font-mono text-[11px] text-text-tertiary">
                  {p.rootPath}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {hits.threads.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="消息串">
              {hits.threads.map((t) => {
                const room = roomById(t.roomId)
                return (
                  <CommandItem
                    key={t.id}
                    value={`thread:${t.id}`}
                    onSelect={go(
                      room ? `/project/${room.projectId}/room/${room.id}/thread/${t.id}` : '/activity',
                    )}
                  >
                    <ui.quote className="size-4" aria-hidden />
                    {taskById(t.rootTaskId)?.title ?? `任务 ${t.rootTaskId}`}
                    <span className="ml-auto text-[11px] text-text-tertiary">
                      {t.replyCount} 条回复 · {t.unreadCount} 未读
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        ) : null}

        {hits.tasks.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="任务">
              {hits.tasks.map((t) => (
                <CommandItem key={t.id} value={`task:${t.id}`} onSelect={go(`/task/${t.id}`)}>
                  <ui.listChecks className="size-4" aria-hidden />
                  #{t.roomTaskNumber} {t.title}
                  <span className="ml-auto">
                    <StatusTag view={taskStatusView[t.status]} dense appearance="outline" />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {hits.rooms.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="房间">
              {hits.rooms.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`room:${r.id}`}
                  onSelect={go(`/project/${r.projectId}/room/${r.id}`)}
                >
                  <ui.hash className="size-4" aria-hidden />
                  {r.name}
                  <span className="ml-auto text-[11px] text-text-tertiary">
                    {r.memberIds.length} 名成员
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {hits.members.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="成员">
              {hits.members.map((m) => (
                <CommandItem key={m.id} value={`member:${m.id}`} onSelect={go(`/member/${m.id}`)}>
                  <ui.users className="size-4" aria-hidden />
                  {m.displayName}
                  <span className="ml-auto max-w-[220px] truncate text-[11px] text-text-tertiary">
                    {m.responsibility}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}

/** §16.5：启动时发现未完成的任务，只问「是否继续」，绝不自动恢复 */
export function RecoveryDialog({
  open,
  onOpenChange,
  onNotice,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNotice: (msg: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="default">
        <DialogHeader>
          <DialogTitle>
            上次退出时有 {recoveryPrompt.unfinishedCount} 个任务未完成，是否继续？
          </DialogTitle>
          <DialogDescription>
            控制面在本地，任务不会自己跑完。这里只列出待确认项，不做任何自动恢复；
            逐个确认时还会复核工作目录是否仍然是同一个。
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1.5 text-sm text-text-secondary">
          {recoveryPrompt.tasks.map((t) => (
            <li key={t.taskId} className="flex items-center gap-2">
              <StatusTag view={taskStatusView[t.status]} dense appearance="outline" />
              <span className="truncate">{t.title}</span>
              <Button variant="text" size="sm" textButton className="ml-auto" onClick={goTask(t.taskId)}>
                查看
              </Button>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              onNotice('已忽略本次提示：任务保持未开始，应用设置里的恢复策略（always_ask）没有被改动')
            }}
          >
            暂不处理
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false)
              const first = recoveryPrompt.tasks[0]
              if (!first) {
                onNotice('待确认列表是空的：没有任务需要逐个恢复')
                return
              }
              if (!taskById(first.taskId)) {
                onNotice(`任务 ${first.taskId} 已不在任务列表里：逐个恢复跳过它，请从项目主页确认目录与预算`)
                return
              }
              navigate(`/task/${first.taskId}`)
              onNotice(`已打开第一个待恢复任务：逐个确认工作目录与剩余预算，确认前不会自动续跑（§16.4）`)
            }}
          >
            逐个确认恢复
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function goTask(taskId: string): () => void {
  return () => {
    if (taskById(taskId)) navigate(`/task/${taskId}`)
  }
}

/** 项目全停是破坏性操作，必须与「关闭右栏」分开且二次确认 */
export function StopAllConfirm({
  open,
  onOpenChange,
  projectName,
  count,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  count: number
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>停止「{projectName}」的全部 {count} 个后台任务？</AlertDialogTitle>
          <AlertDialogDescription>
            停止只终止后续派发与阶段，不会撤销已经写入工作目录的改动。残留改动会出现在
            「文件与改动」里等你逐个处置；归因不明确的改动不会被自动还原。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline">取消</Button>
          </AlertDialogCancel>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            确认全停
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** §16.5：错误码原文 + 人话文案，全站共用一份 */
export function ErrorInspectDialog({
  code,
  onClose,
}: {
  code: ErrorCode | null
  onClose: () => void
}) {
  const copy = code ? errorCopy[code] : undefined
  const retryable = code
    ? Object.values(errorNotices).some((n) => n.code === code && n.retryable)
    : false
  return (
    <Dialog
      open={!!code}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent size="default">
        {code && copy ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>页面文案直接取自设计文档 §16.5 错误码表，不额外发明说法。</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2 text-sm text-text-secondary">
              <p>{copy.detail}</p>
              <div className="flex items-center gap-2">
                <span>错误码</span>
                <Tag color="error" appearance="outline">
                  {code}
                </Tag>
                {retryable ? (
                  <Tag color="warning" appearance="outline">
                    可重试
                  </Tag>
                ) : (
                  <Tag color="slate" appearance="outline">
                    不可自动重试
                  </Tag>
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** 注册 ⌘K / Ctrl+K */
export function useCommandK(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}
