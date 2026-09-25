import type { ComponentType } from 'react'

import { Tag } from 'sparkdesign'

import { cn } from '@/lib/cn'
import { statusIcons } from '@/lib/icons'
import type { StatusView, Tone } from '@/data/status'

/**
 * 所有状态呈现都走这里：文字 + 图标，绝不只靠颜色
 * （设计文档可访问性要求，也是 Spark 的 hard rule）。
 */
export function StatusTag({
  view,
  className,
  appearance = 'filled',
  dense = false,
  trailing,
}: {
  view: StatusView
  className?: string
  appearance?: 'filled' | 'outline'
  dense?: boolean
  trailing?: string
}) {
  const Icon = statusIcons[view.icon] as ComponentType<{ className?: string }>
  return (
    <Tag
      appearance={appearance}
      color={view.tone as Tone}
      className={cn('shrink-0', dense && 'gap-1 px-1.5 py-0', className)}
    >
      <Icon className={cn(dense ? 'size-3' : 'size-3.5')} aria-hidden />
      <span className="truncate">
        {view.label}
        {trailing ? <span className="text-text-tertiary"> {trailing}</span> : null}
      </span>
    </Tag>
  )
}

/** 纯状态点，只允许出现在已经有文字标签的旁边 */
export function StatusDot({
  view,
  className,
}: {
  view: StatusView
  className?: string
}) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full bg-primary', className)}
      data-tone={view.tone}
      aria-hidden
    />
  )
}

const toneBg: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  info: 'bg-info',
  primary: 'bg-primary',
  slate: 'bg-slate',
  purple: 'bg-purple',
  teal: 'bg-teal',
  orange: 'bg-orange',
  blue: 'bg-blue',
  sage: 'bg-sage',
  lavender: 'bg-lavender',
  mauve: 'bg-mauve',
  yellow: 'bg-yellow',
}

export function ToneDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', toneBg[tone], className)} aria-hidden />
}
