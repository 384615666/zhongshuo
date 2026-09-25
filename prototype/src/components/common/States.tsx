import type { ReactNode } from 'react'

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
} from 'sparkdesign'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { errorCopy } from '@/data/status'
import type { ErrorNotice } from '@/data/types'

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  const Icon = ui.folderTree
  return (
    <Empty className={cn('py-10', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Icon />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/**
 * §16.5 的 19 个错误码统一按这份文案渲染：
 * 标题说人话，detail 交代下一步，能重试的才给重试。
 */
export function ErrorState({
  notice,
  onRetry,
  className,
}: {
  notice: ErrorNotice
  onRetry?: () => void
  className?: string
}) {
  const copy = errorCopy[notice.code]
  return (
    <Alert variant="destructive" className={cn('items-start', className)}>
      <ui.alert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <AlertTitle>
          {copy.title}
          <span className="ml-2 font-mono text-xs font-normal text-text-tertiary">
            {notice.code}
          </span>
        </AlertTitle>
        <AlertDescription>{notice.detail || copy.detail}</AlertDescription>
        {notice.title && notice.title !== copy.title ? (
          <AlertDescription className="mt-1 font-medium text-text">
            {notice.title}
          </AlertDescription>
        ) : null}
        {notice.lockHolder ? (
          <p className="mt-1.5 text-xs text-text-secondary">
            锁持有者：{notice.lockHolder.memberName}
            <span className="ml-1 font-mono text-[11px]">{notice.lockHolder.memberId}</span>
            {' · '}已持有 {notice.lockHolder.since}
            {' · '}前面排队 {notice.lockHolder.queueLength} 个
          </p>
        ) : null}
        {notice.retryable && onRetry ? (
          <Button variant="secondary" size="sm" className="mt-2.5" onClick={onRetry}>
            <ui.refresh className="size-3.5" aria-hidden />
            重试
          </Button>
        ) : null}
      </div>
    </Alert>
  )
}

export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 p-4', className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton rounded="circle" className="size-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-[42%]" />
            <Skeleton className="mt-2 h-3 w-[70%]" />
          </div>
        </div>
      ))}
    </div>
  )
}
