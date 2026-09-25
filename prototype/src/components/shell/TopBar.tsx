import { Button, IconButton, Separator, Tag, Tooltip } from 'sparkdesign'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { navigate } from '@/lib/router'
import { StatusTag } from '@/components/common/StatusTag'
import { workspaceStatusView } from '@/data/status'
import type { Project, Room, WorkspaceStatus } from '@/data/types'

/**
 * §17.1 顶栏：品牌｜当前项目路径｜后台任务角标｜项目全停｜设置
 * 「关闭右栏」绝不能被理解成「停止任务」，所以全停是独立按钮且要二次确认。
 */
export function TopBar({
  project,
  room,
  backgroundTasks,
  workspace,
  onStopAll,
  onOpenRecovery,
  className,
}: {
  project?: Project
  room?: Room
  backgroundTasks: number
  workspace?: WorkspaceStatus
  onStopAll: () => void
  onOpenRecovery?: () => void
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b border-border-secondary',
        'bg-bg-container px-3',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-text-on-primary"
        >
          众
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">
            {project?.displayName ?? '众说'}
            {room ? (
              <span className="text-text-tertiary"> / {room.name}</span>
            ) : null}
          </p>
          {project ? (
            <button
              type="button"
              onClick={onOpenRecovery}
              className="block max-w-full truncate text-left font-mono text-[11px] text-text-tertiary hover:text-text"
              title={project.rootPath}
            >
              {project.rootPath}
              <span className="ml-1.5 font-sans">
                · rev {project.revision}
                {project.directoryIdentity !== '00000000'
                  ? ` · ${project.directoryIdentity}`
                  : ''}
              </span>
            </button>
          ) : (
            <p className="text-[11px] text-text-tertiary">本机项目群聊工作台</p>
          )}
        </div>
      </div>

      {workspace ? (
        <>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <StatusTag view={workspaceStatusView[workspace]} dense appearance="outline" />
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip
          content={
            backgroundTasks > 0
              ? `${backgroundTasks} 个后台任务正在跑；关掉右侧页面不会停止它们`
              : '没有后台任务'
          }
          placement="bottom"
        >
          <Tag color={backgroundTasks > 0 ? 'primary' : 'slate'} className="gap-1.5">
            <ui.cpu className="size-3.5" aria-hidden />
            后台任务 {backgroundTasks}
          </Tag>
        </Tooltip>

        <Button
          variant="outline"
          size="sm"
          onClick={onStopAll}
          disabled={backgroundTasks === 0}
          prefixIcon={<ui.stop className="size-3.5" />}
        >
          全停本项目
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Tooltip content="应用设置：数据目录、并发、托盘、日志保留、M0 模式开关" side="bottom">
          <IconButton
            icon={<ui.settings className="size-4" />}
            aria-label="应用设置"
            variant="iconOnly"
            size="sm"
            onClick={() => navigate('/settings')}
          />
        </Tooltip>
      </div>
    </header>
  )
}

/** 页面级标题条：13 个页面共用，保证返回入口与操作位一致 */
export function PageHeader({
  title,
  description,
  backTo,
  backLabel = '返回',
  actions,
  meta,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  backTo?: string
  backLabel?: string
  actions?: React.ReactNode
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-start gap-3 border-b border-border-secondary',
        'bg-bg-container px-5 py-3.5',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {backTo ? <BackLink to={backTo} label={backLabel} /> : null}
        <h2 className="mt-0.5 truncate text-lg font-semibold text-text">{title}</h2>
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-text-tertiary">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function BackLink({ to, label = '返回' }: { to: string; label?: string }) {
  return (
    <Button
      asChild
      variant="text"
      size="sm"
      textButton
      className="-ml-1.5 h-6 text-text-secondary"
    >
      <a href={`#${to}`}>
        <ui.chevronLeft className="size-3.5" aria-hidden />
        {label}
      </a>
    </Button>
  )
}
