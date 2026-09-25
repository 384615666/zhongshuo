import {
  IconButton,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarNavMenu,
  SidebarNavMenuItem,
  SidebarProvider,
  SidebarSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tag,
  useSidebar,
} from 'sparkdesign'
import { Moon, Sun } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { MemberAvatar } from '@/components/common/MemberIdentity'
import { Link, navigate, useRoute } from '@/lib/router'
import { useTheme } from '@/lib/theme'
import { AddMemberDialog } from '@/components/overlays/AddMemberDialog'
import { CreateRoomDialog } from '@/components/overlays/CreateRoomDialog'
import { agentProfiles, projects, rooms } from '@/data/mock'
import { attentionItems, savedItems } from '@/data/mock'
import type { Project } from '@/data/types'

const primaryNav = [
  { to: '/project/p-ec', label: '群聊', icon: ui.workflow, key: 'chat' },
  { to: '/tasks', label: '任务', icon: ui.listChecks, key: 'tasks' },
  { to: '/members', label: '成员', icon: ui.users, key: 'members' },
  { to: '/runtimes', label: '运行时', icon: ui.plug, key: 'computers' },
  { to: '/activity', label: '待我处理', icon: ui.siren, key: 'activity' },
  { to: '/saved', label: '收藏', icon: ui.star, key: 'saved' },
] as const

export function GlobalNav({
  children,
  onOpenSearch,
}: {
  children: ReactNode
  onOpenSearch: () => void
}) {
  return (
    <SidebarProvider className="h-svh overflow-hidden" defaultOpen>
      <Sidebar
        collapsible="offcanvas"
        className="h-full border-r border-border-secondary bg-bg-container"
        style={{ width: 'var(--sidebar-width)' }}
      >
        <NavBody onOpenSearch={onOpenSearch} />
      </Sidebar>
      <SidebarInset className="min-h-0 h-full">{children}</SidebarInset>
    </SidebarProvider>
  )
}

function NavBody({ onOpenSearch }: { onOpenSearch: () => void }) {
  const { path } = useRoute()
  const { toggleSidebar } = useSidebar()
  const { appearance, toggleAppearance } = useTheme()
  /** 侧栏就能开房间 / 加成员：不必先进项目主页，否则「+」是个假入口 */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [roomProjectId, setRoomProjectId] = useState<string | null>(null)
  const [memberProjectId, setMemberProjectId] = useState<string | null>(null)

  const active = (to: string) => path === to || path.startsWith(`${to}/`)

  return (
    <>
      <SidebarHeader className="gap-0 py-2">
        <div className="flex items-center gap-2 px-1">
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-sm font-semibold text-text-on-primary"
          >
            众
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">众说</p>
            <p className="truncate text-[11px] text-text-tertiary">本机 · 控制面在本地</p>
          </div>
          <IconButton
            icon={<ui.panelRight className="size-4" />}
            aria-label="收起侧边栏"
            variant="iconOnly"
            size="sm"
            onClick={toggleSidebar}
          />
        </div>
        <button
          type="button"
          onClick={onOpenSearch}
          className={cn(
            'mt-2 flex items-center gap-2 rounded-lg border border-border-secondary',
            'bg-bg-elevated px-2.5 py-1.5 text-xs text-text-tertiary',
            'transition-colors hover:border-border hover:text-text',
          )}
        >
          <ui.search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">搜索消息、任务、成员</span>
          <kbd className="rounded border border-border-secondary px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarNavMenu>
              {primaryNav.map((item) => (
                <SidebarNavMenuItem key={item.key}>
                  <SidebarMenuButton asChild isActive={active(item.to)} size="sm">
                    <Link to={item.to}>
                      <item.icon className="size-4" aria-hidden />
                      {item.label}
                      {item.key === 'activity' && attentionItems.length ? (
                        <Tag
                          color="warning"
                          appearance="filled"
                          className="ml-auto gap-0 px-1.5 py-0 text-[10px]"
                        >
                          {attentionItems.length}
                        </Tag>
                      ) : null}
                      {item.key === 'saved' && savedItems.length ? (
                        <span className="ml-auto text-[10px] text-text-tertiary">
                          {savedItems.length}
                        </span>
                      ) : null}
                    </Link>
                  </SidebarMenuButton>
                </SidebarNavMenuItem>
              ))}
            </SidebarNavMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* 频道 = 项目 → 房间 */}
        <SidebarGroup className="min-h-0 py-1">
          <SidebarGroupLabel className="px-2">
            频道
            <span className="ml-1 text-text-tertiary">（以文件夹为项目）</span>
          </SidebarGroupLabel>
          <SidebarGroupAction
            aria-label="打开文件夹作为项目"
            title="打开文件夹作为项目（project.open 只在欢迎页发生）"
            onClick={() => navigate('/welcome')}
          >
            <ui.plus className="size-3.5" aria-hidden />
          </SidebarGroupAction>
          <SidebarGroupContent className="overflow-y-auto">
            <SidebarNavMenu>
              {projects.map((project) => {
                const ownRooms = rooms.filter((r) => r.projectId === project.id)
                const on = active(`/project/${project.id}`)
                return (
                  <SidebarNavMenuItem key={project.id}>
                    <SidebarMenuButton asChild isActive={on} size="sm">
                      <Link to={`/project/${project.id}`}>
                        <ui.folder className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{project.displayName}</span>
                        {project.status === 'recovering' ? (
                          <ui.refresh className="ml-auto size-3.5 shrink-0 text-warning" aria-hidden />
                        ) : null}
                        {project.status === 'archived' ? (
                          <ui.lock className="ml-auto size-3 shrink-0 text-text-tertiary" aria-hidden />
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                    <ProjectActionMenu
                      project={project}
                      roomCount={ownRooms.length}
                      open={menuFor === project.id}
                      onOpenChange={(next) => setMenuFor(next ? project.id : null)}
                      onCreateRoom={() => {
                        setMenuFor(null)
                        setRoomProjectId(project.id)
                      }}
                      onAddMember={() => {
                        setMenuFor(null)
                        setMemberProjectId(project.id)
                      }}
                    />
                    {ownRooms.length ? (
                      <SidebarMenuSub>
                        {ownRooms.map((room) => (
                          <SidebarMenuSubItem key={room.id}>
                            <SidebarMenuSubButton
                              asChild
                              size="sm"
                              isActive={active(`/project/${project.id}/room/${room.id}`)}
                            >
                              <Link to={`/project/${project.id}/room/${room.id}`}>
                                {room.muted ? (
                                  <ui.lock className="size-3 shrink-0 opacity-60" aria-hidden />
                                ) : null}
                                <span className="truncate">{room.name}</span>
                                <span className="ml-auto text-[10px] text-text-tertiary">
                                  {room.memberIds.length}
                                </span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    ) : null}
                  </SidebarNavMenuItem>
                )
              })}
            </SidebarNavMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* 私信：与单个成员的一对一，不进房间上下文 */}
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>私信</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarNavMenu>
              {agentProfiles.filter((m) => m.enabled).map((member) => (
                <SidebarNavMenuItem key={member.id}>
                  <SidebarMenuButton asChild size="sm" isActive={active(`/dm/${member.id}`)}>
                    <Link to={`/dm/${member.id}`}>
                      <MemberAvatar member={member} size="sm" showPresence={false} />
                      <span className="truncate">{member.displayName}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarNavMenuItem>
              ))}
            </SidebarNavMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1.5">
        <div className="flex items-center gap-1.5">
          <IconButton
            icon={
              appearance === 'dark' ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )
            }
            aria-label={appearance === 'dark' ? '切到浅色' : '切到深色'}
            variant="iconOnly"
            size="sm"
            onClick={toggleAppearance}
          />
          <SidebarMenuButton asChild size="sm" className="flex-1">
            <Link to="/settings">
              <ui.settings className="size-4" aria-hidden />
              应用设置
            </Link>
          </SidebarMenuButton>
        </div>
        <p className="px-1 text-[10px] text-text-tertiary">
          原型 v0.1 · 数据均为演示用，不写盘
        </p>
      </SidebarFooter>

      {roomProjectId ? (
        <CreateRoomDialog
          open
          onOpenChange={(next) => {
            if (!next) setRoomProjectId(null)
          }}
          projectId={roomProjectId}
        />
      ) : null}

      {memberProjectId ? (
        <AddMemberDialog
          open
          onOpenChange={(next) => {
            if (!next) setMemberProjectId(null)
          }}
          projectId={memberProjectId}
        />
      ) : null}
    </>
  )
}

/**
 * 项目行上的「···」：之前只画了个图标，点了没反应，等于在导航里留了个假入口。
 * 这里把 §17.1 左侧栏要求的三件事（开房间 / 拉人 / 进项目）一次补齐，
 * 且都直接调用已有的写操作，不新增状态口径。
 */
function ProjectActionMenu({
  project,
  roomCount,
  open,
  onOpenChange,
  onCreateRoom,
  onAddMember,
}: {
  project: Project
  roomCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateRoom: () => void
  onAddMember: () => void
}) {
  const archived = project.status === 'archived'
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <SidebarMenuAction showOnHover aria-label={`${project.displayName} 项目操作`}>
          <ui.more className="size-3.5" aria-hidden />
        </SidebarMenuAction>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1.5">
        <p className="truncate px-1.5 pb-1 pt-1 text-xs font-medium text-text">
          {project.displayName}
          <span className="ml-1 font-normal text-text-tertiary">{roomCount} 个房间</span>
        </p>
        <button
          type="button"
          disabled={archived}
          onClick={onCreateRoom}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm text-text transition-colors hover:bg-fill-secondary disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent"
        >
          <ui.hash className="size-3.5 shrink-0" aria-hidden />
          新建房间…
        </button>
        <button
          type="button"
          onClick={onAddMember}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm text-text transition-colors hover:bg-fill-secondary"
        >
          <ui.userPlus className="size-3.5 shrink-0" aria-hidden />
          添加成员…
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false)
            navigate(`/project/${project.id}`)
          }}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm text-text transition-colors hover:bg-fill-secondary"
        >
          <ui.folder className="size-3.5 shrink-0" aria-hidden />
          项目主页（房间名单·授权）
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false)
            navigate(`/project/${project.id}/changes`)
          }}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm text-text transition-colors hover:bg-fill-secondary"
        >
          <ui.fileDiff className="size-3.5 shrink-0" aria-hidden />
          变更与成果
        </button>
        <p className="px-1.5 pb-1 pt-1.5 text-[11px] leading-relaxed text-text-tertiary">
          {archived
            ? '项目已归档：不接受新派工，先到项目主页恢复状态。'
            : '重新定位文件夹 = project.open，只在欢迎页发生（§16.4 恢复流程）。'}
        </p>
      </PopoverContent>
    </Popover>
  )
}
