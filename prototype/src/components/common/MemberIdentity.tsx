import { Avatar, AvatarBadge, AvatarFallback, Tooltip } from 'sparkdesign'

import { cn } from '@/lib/cn'
import { offlineReasonView, presenceView } from '@/data/status'
import type { AgentProfile, Presence } from '@/data/types'

/**
 * Tailwind 看不到动态拼接的类名，所以配色一律写成完整字面量。
 * 文档约定：codex 蓝 / claude 紫 / human 橙。
 */
const accentSurface = {
  blue: 'bg-blue-bg text-blue',
  purple: 'bg-purple-bg text-purple',
  orange: 'bg-orange-bg text-orange',
  teal: 'bg-teal-bg text-teal',
  sage: 'bg-sage-bg text-sage',
  lavender: 'bg-lavender-bg text-lavender',
} as const

const presenceBadge = {
  online: 'bg-success',
  busy: 'bg-warning',
  error: 'bg-orange',
  offline: 'bg-border',
} as const

const presenceText = {
  online: 'text-success',
  busy: 'text-warning',
  error: 'text-orange',
  offline: 'text-text-tertiary',
} as const

export function initials(name: string): string {
  const trimmed = name.trim()
  if (/^[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 2)
  return trimmed
    .split(/[\s._·-]+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function MemberAvatar({
  member,
  size = 'default',
  showPresence = true,
  className,
}: {
  member: Pick<AgentProfile, 'displayName' | 'accent' | 'presence' | 'offlineReason'>
  size?: 'sm' | 'default' | 'lg'
  showPresence?: boolean
  className?: string
}) {
  return (
    <Avatar size={size} className={cn('shrink-0', className)}>
      <AvatarFallback className={cn('font-medium', accentSurface[member.accent])}>
        {initials(member.displayName)}
      </AvatarFallback>
      {showPresence ? (
        <AvatarBadge
          className={presenceBadge[member.presence]}
          aria-label={presenceLabel(member)}
        />
      ) : null}
    </Avatar>
  )
}

/** 离线灰色必须给出可解释的原因 */
export function presenceLabel(member: {
  presence: Presence
  offlineReason?: AgentProfile['offlineReason']
}): string {
  if (member.presence === 'offline') {
    return offlineReasonView[member.offlineReason ?? 'telemetry_unknown'].label
  }
  return presenceView[member.presence].label
}

export function MemberPresenceTooltip({
  member,
  children,
}: {
  member: Pick<AgentProfile, 'displayName' | 'presence' | 'offlineReason' | 'runtime'>
  children: React.ReactNode
}) {
  const label = presenceLabel(member)
  return (
    <Tooltip
      content={
        <span className="text-xs">
          {member.displayName} · {label}
          <span className="block text-text-tertiary">
            runtime {member.runtime === 'codex' ? 'Codex CLI' : 'Claude Code'}
          </span>
        </span>
      }
      placement="right"
    >
      {children}
    </Tooltip>
  )
}

export function MemberNameLine({
  member,
  suffix,
  className,
}: {
  member: Pick<AgentProfile, 'displayName' | 'presence' | 'offlineReason'>
  suffix?: string
  className?: string
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="truncate font-medium text-text">{member.displayName}</span>
      <span className={cn('truncate text-xs', presenceText[member.presence])}>
        {presenceLabel(member)}
      </span>
      {suffix ? <span className="truncate text-xs text-text-tertiary">{suffix}</span> : null}
    </span>
  )
}
