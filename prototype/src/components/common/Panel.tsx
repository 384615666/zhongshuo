import type { ReactNode } from 'react'

import { Card, CardAction, CardContent, CardHeader, Separator } from 'sparkdesign'

import { cn } from '@/lib/cn'

export function SectionPanel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  flush = false,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  flush?: boolean
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className={cn(flush ? 'px-4 pt-4' : 'px-5 pt-5')}>
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text">{title}</h3>
          {description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-text-tertiary">{description}</p>
          ) : null}
        </div>
        {action ? <CardAction className="self-start">{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={cn(flush ? 'p-0' : 'px-5 pb-5', contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )
}

/** 键值行：左列固定宽度，对齐可视化指南里的 code-note 呈现 */
export function KVDL({
  items,
  className,
  columns = 1,
}: {
  items: { key: string; value: ReactNode; mono?: boolean }[]
  className?: string
  columns?: 1 | 2
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-2.5',
        columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 gap-3">
          <dt className="w-[132px] shrink-0 truncate text-xs text-text-tertiary">
            {item.key}
          </dt>
          <dd
            className={cn(
              'min-w-0 flex-1 text-sm text-text',
              item.mono && 'font-mono text-xs break-all',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function InlineMeta({
  children,
  className,
  separator = true,
}: {
  children: ReactNode
  className?: string
  separator?: boolean
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-tertiary',
        className,
      )}
    >
      {children}
      {separator ? null : null}
    </span>
  )
}

export function MetaDot() {
  return <span aria-hidden className="text-border">·</span>
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary',
        className,
      )}
    >
      {children}
    </p>
  )
}

export function ListRow({
  children,
  onClick,
  active = false,
  className,
  as = 'div',
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  className?: string
  as?: 'div' | 'button'
}) {
  const Comp = as === 'button' ? 'button' : 'div'
  return (
    <Comp
      type={as === 'button' ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2.5 text-left transition-colors duration-150',
        onClick || as === 'button' ? 'cursor-pointer hover:bg-fill-secondary' : '',
        active && 'bg-fill-secondary',
        className,
      )}
    >
      {children}
    </Comp>
  )
}

export function DividedList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      {Array.isArray(children)
        ? children.map((child, i) => (
            <div key={i}>
              {child}
              {i < children.length - 1 ? <Separator /> : null}
            </div>
          ))
        : children}
    </div>
  )
}
