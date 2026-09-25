import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'sparkdesign'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { EmptyState, LoadingRows } from '@/components/common/States'
import { MessageRow, type MessageActions } from '@/components/workspace/MessageCards'
import type { Message } from '@/data/types'

/**
 * §16.5 流式行为：新内容不能抢滚动。
 * 贴底时跟随；一旦用户上翻，就把位置留给 TA，只显示「有新消息」。
 */
export function MessageList({
  messages,
  loading = false,
  actions,
  emptyTitle = '这里还没有消息',
  emptyDescription,
  className,
}: {
  messages: Message[]
  loading?: boolean
  actions?: MessageActions
  emptyTitle?: string
  emptyDescription?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(true)
  const [pending, setPending] = useState(0)
  const seen = useRef(0)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 48) {
      setPinned(true)
      setPending(0)
    } else {
      setPinned(false)
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const added = messages.length - seen.current
    seen.current = messages.length
    if (added <= 0) return
    if (pinned) el.scrollTop = el.scrollHeight
    else setPending((p) => p + added)
  }, [messages, pinned])

  const jump = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setPinned(true)
    setPending(0)
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        {loading ? <LoadingRows rows={4} className="p-4" /> : null}
        {!loading && !messages.length ? (
          <EmptyState
            title={emptyTitle}
            description={emptyDescription ?? '发送第一条消息即可开始；@ 成员会直接派工。'}
            icon={<ui.messages className="size-5" aria-hidden />}
            className="h-full"
          />
        ) : null}
        <div className="flex flex-col">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} actions={actions} />
          ))}
        </div>
      </div>

      {pending > 0 ? (
        <Button
          size="sm"
          variant="primary"
          rounded="pill"
          onClick={jump}
          className={cn(
            'absolute bottom-3 left-1/2 z-10 -translate-x-1/2 gap-1.5 shadow-md',
          )}
        >
          <ui.chevronDown className="size-3.5" aria-hidden />
          有新消息（{pending}）
        </Button>
      ) : null}
      {!pending && !pinned && messages.length ? (
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-bg-elevated px-2 py-0.5 text-[11px] text-text-tertiary shadow-xs">
          已停在你阅读的位置，新消息不会把你顶走
        </p>
      ) : null}
    </div>
  )
}

/**
 * 演示用流式回放：把标记为 streaming 的最后一条消息按 delta 逐字补全，
 * messageId 始终不变，所以更新是原地替换而不是追加气泡。
 */
export function useStreamingMessages(source: Message[], intervalMs = 90): Message[] {
  const targetIndex = source.findIndex((m) => m.status === 'streaming')
  const fullLength = targetIndex >= 0 ? source[targetIndex].body.length : 0
  const [revealed, setRevealed] = useState(targetIndex >= 0 ? 0 : fullLength)

  useEffect(() => {
    if (targetIndex < 0) return
    setRevealed(0)
    const timer = window.setInterval(() => {
      setRevealed((n) => {
        if (n >= fullLength) {
          window.clearInterval(timer)
          return n
        }
        return Math.min(fullLength, n + 14)
      })
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [fullLength, intervalMs, targetIndex])

  return useMemo(() => {
    if (targetIndex < 0) return source
    return source.map((m, i) =>
      i === targetIndex ? { ...m, body: m.body.slice(0, revealed) } : m,
    )
  }, [revealed, source, targetIndex])
}
