import { useEffect, useState } from 'react'
import {
  Button,
  Checkbox,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field,
  FieldContent,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Switch,
  Tag,
  Textarea,
  Tooltip,
} from 'sparkdesign'

import { ui } from '@/lib/icons'
import { MemberAvatar, MemberPresenceTooltip, presenceLabel } from '@/components/common/MemberIdentity'
import { SectionLabel } from '@/components/common/Panel'
import { StatusTag } from '@/components/common/StatusTag'
import { AddMemberDialog } from '@/components/overlays/AddMemberDialog'
import { memberById, projectRooms, threadSubscriptions } from '@/data/mock'
import { presenceView, routingModeView } from '@/data/status'
import {
  addRoomMember,
  removeRoomMember,
  setThreadFollow,
  updateRoom,
} from '@/lib/mutations'
import type { AgentProfile, Room } from '@/data/types'

/**
 * §17.1 房间设置抽屉：右滑 420px。
 *
 * 这里的每个控件都真的写数据（room.update / room.members.add / room.members.remove /
 * room.archive），不再只弹 toast。
 *
 * 关于「协作模式」：E6 定案（§4.2 L252）模式不手选，由 @ 结构推导，所以抽屉里
 * 没有「默认协作模式」选择器——之前那是一个和输入条互相矛盾的假控件。
 * 取而代之是一段只读的推导图例，让用户明白模式从哪来。
 */
export function RoomSettingsDrawer({
  room,
  members,
  projectId,
  open,
  onOpenChange,
  onNotice,
}: {
  room: Room
  members: AgentProfile[]
  projectId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onNotice?: (msg: string) => void
}) {
  const [name, setName] = useState(room.name)
  const [description, setDescription] = useState(room.description)
  const [coordinator, setCoordinator] = useState(room.coordinatorMemberId)
  const [muted, setMuted] = useState(room.muted)
  const [addMember, setAddMember] = useState(false)

  // 抽屉重新打开时按最新的 room 复位草稿（别的页面可能已经改过）
  useEffect(() => {
    if (!open) return
    setName(room.name)
    setDescription(room.description)
    setCoordinator(room.coordinatorMemberId)
    setMuted(room.muted)
  }, [open, room])

  const candidateIds = (projectId ? projectRooms(projectId) : [room])
    .flatMap((r) => r.memberIds)
    .filter((id) => !room.memberIds.includes(id))
  const candidates = [...new Set(candidateIds)].map((id) => memberById(id))

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent side="right" className="w-[420px] max-w-[92vw]">
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-1.5">
            <ui.hash className="size-4" aria-hidden />
            房间设置 · {room.name}
          </DrawerTitle>
          <DrawerDescription>{room.description}</DrawerDescription>
        </DrawerHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
          <Field orientation="vertical">
            <FieldLabel htmlFor="room-name">房间名称</FieldLabel>
            <Input id="room-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="room-desc">房间简介</FieldLabel>
            <Textarea
              id="room-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说清这个房间在讨论什么"
            />
          </Field>

          <Field orientation="vertical">
            <FieldLabel>协调者</FieldLabel>
            <NativeSelect
              size="default"
              value={coordinator}
              onChange={(e) => setCoordinator(e.target.value)}
              aria-label="协调者"
            >
              {members.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.displayName}（{m.runtime === 'codex' ? 'Codex CLI' : 'Claude Code'}）
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-text-tertiary">
              协调者负责判定 §4.2 的协作模式与分工；待决 E5 若改为项目级，这一项会上移。
            </p>
          </Field>

          <Field orientation="horizontal">
            <FieldLabel>静音本房间</FieldLabel>
            <FieldContent>
              <Switch checked={muted} onCheckedChange={setMuted} aria-label="静音本房间" />
            </FieldContent>
          </Field>

          <Separator />

          {/* E6：模式只能推导，这里给图例而不是选择器 */}
          <div>
            <SectionLabel>协作模式怎么定</SectionLabel>
            <ul className="flex flex-col gap-1.5">
              {(
                [
                  { key: 'DISCUSS', rule: '标为「讨论」，不派工，0 次模型调用' },
                  { key: 'DIRECT', rule: '@ 单个成员 → 直接派给 TA，预算 6 轮' },
                  { key: 'DELIBERATE', rule: '@ 两个以上或 @全体 → 全体研讨，名单当场冻结' },
                  { key: 'AUTO', rule: '没 @ 任何人 → 交给协调者判断，预算 20 轮' },
                ] as const
              ).map((row) => (
                <li key={row.key} className="flex items-start gap-2">
                  <Tag appearance="outline" color="slate" className="shrink-0 py-0 text-[10px]">
                    {routingModeView[row.key].label}
                  </Tag>
                  <span className="min-w-0 text-[11px] leading-relaxed text-text-tertiary">
                    {row.rule}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">
              所以这里没有「默认模式」可选项：模式由输入框里的 @ 结构推导，发送前在输入条上实时预览。
              交付评审按任务定（默认报告自动交付、代码需你确认），请在任务详情里改。
            </p>
          </div>

          <Separator />

          <div>
            <div className="flex items-center gap-1.5">
              <SectionLabel className="mb-0">房间成员（{members.length}）</SectionLabel>
              <Button
                variant="text"
                size="sm"
                textButton
                className="ml-auto gap-1"
                onClick={() => setAddMember(true)}
              >
                <ui.userPlus className="size-3.5" aria-hidden />
                添加成员
              </Button>
            </div>
            <ul className="mt-1.5 flex flex-col gap-1">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Checkbox
                    checked
                    disabled={m.id === room.coordinatorMemberId}
                    aria-label={`把 ${m.displayName} 移出本房间`}
                    onCheckedChange={(next) => {
                      if (next === true) return
                      removeRoomMember(room.id, m.id)
                      onNotice?.(`${m.displayName} 已移出本房间；项目级授权与历史发言保留`)
                    }}
                  />
                  <MemberPresenceTooltip member={m}>
                    <span className="flex min-w-0 items-center gap-2">
                      <MemberAvatar member={m} size="sm" />
                      <span className="truncate text-sm text-text">{m.displayName}</span>
                    </span>
                  </MemberPresenceTooltip>
                  <span className="ml-auto shrink-0 text-[11px] text-text-tertiary">
                    {presenceLabel(m)}
                  </span>
                  {m.id === room.coordinatorMemberId ? (
                    <Tag appearance="outline" color="primary" className="shrink-0 py-0 text-[10px]">
                      协调者
                    </Tag>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-text-tertiary">
              取消勾选即 room.members.remove：只改变可派工范围，项目级授权与历史发言都保留。
              协调者不能移出自己房间。
            </p>
          </div>

          {candidates.length ? (
            <div>
              <SectionLabel>把已有成员拉进本房间</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((m) => (
                  <Tooltip key={m.id} content={`room.members.add · ${presenceLabel(m)}`} side="top">
                    <button
                      type="button"
                      onClick={() => {
                        addRoomMember(room.id, m.id)
                        onNotice?.(`${m.displayName} 已加入本房间，可被 @ 派工`)
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-border-secondary px-2 py-1 text-xs text-text transition-colors hover:bg-fill-secondary"
                    >
                      <MemberAvatar member={m} size="sm" />
                      {m.displayName}
                      <ui.plus className="size-3 text-text-tertiary" aria-hidden />
                    </button>
                  </Tooltip>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">
                新加入房间的成员不会自动进入正在进行的研讨名单（§4.3 名单冻结）；
                要在某一轮生效，请到该任务的回复串里点「加入成员」。
              </p>
            </div>
          ) : null}

          <div className="rounded-md border border-border-secondary bg-bg-container p-3">
            <p className="text-xs font-medium text-text">归档房间</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary">
              归档后房间只读，历史与串仍可检索；正在运行的任务不会被归档动作停止。
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                updateRoom(room.id, { archivedAt: room.archivedAt ? null : new Date().toISOString() })
                onNotice?.(room.archivedAt ? '已取消归档，房间恢复可写' : '已归档本房间（任务不受影响）')
              }}
            >
              {room.archivedAt ? '取消归档' : '归档房间'}
            </Button>
          </div>
        </div>

        <DrawerFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !members.some((m) => m.id === coordinator)}
            onClick={() => {
              updateRoom(room.id, {
                name: name.trim(),
                description,
                coordinatorMemberId: coordinator,
                muted,
              })
              onNotice?.(`房间设置已保存（协调者：${memberById(coordinator)?.displayName}）`)
              onOpenChange(false)
            }}
          >
            保存
          </Button>
        </DrawerFooter>

        <AddMemberDialog
          open={addMember}
          onOpenChange={setAddMember}
          projectId={projectId}
          defaultRoomId={room.id}
          onCreated={() => setAddMember(false)}
        />
      </DrawerContent>
    </Drawer>
  )
}

/**
 * §17.1「正在关注的成员」弹层 320px。
 *
 * 之前只能减不能加，而且关注状态存在组件本地，切串就丢。
 * 现在读写同一份 threadSubscriptions（thread.follow），加/减都落数据。
 */
export function FollowMembersPopover({
  threadId,
  memberIds,
  onNotice,
}: {
  threadId: string
  /** 可选对象：本串的参与者 + 房间成员 */
  memberIds: string[]
  onNotice?: (msg: string) => void
}) {
  const followed = threadSubscriptions
    .filter((s) => s.threadId === threadId && s.followed)
    .map((s) => s.memberId)
  const candidates = memberIds.filter((id) => !followed.includes(id))

  const toggle = (id: string, next: boolean) => {
    setThreadFollow(threadId, id, next)
    onNotice?.(
      next
        ? `${memberById(id).displayName} 已开始跟进本串：只影响提醒，不影响派工范围`
        : `${memberById(id).displayName} 已移出跟进：TA 仍能看到串，只是不再收到新回复提醒`,
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 font-normal">
          <ui.eye className="size-3.5" aria-hidden />
          正在关注
          <span className="text-text-tertiary">{followed.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-2">
        <p className="px-1 pb-1.5 text-xs font-medium text-text">正在关注本串的成员</p>
        <ul className="flex flex-col gap-0.5">
          {followed.map((id) => {
            const m = memberById(id)
            if (!m) return null
            return (
              <li key={id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-fill-secondary">
                <MemberAvatar member={m} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{m.displayName}</span>
                <StatusTag view={presenceView[m.presence]} dense appearance="outline" />
                <Button variant="text" size="sm" textButton onClick={() => toggle(id, false)}>
                  取消关注
                </Button>
              </li>
            )
          })}
          {!followed.length ? (
            <li className="px-1.5 py-3 text-xs text-text-tertiary">
              还没有人关注这条串；关注只影响提醒，不影响成员能否被派工。
            </li>
          ) : null}
        </ul>

        {candidates.length ? (
          <>
            <Separator className="my-1.5" />
            <p className="px-1 pb-1 text-[11px] font-medium text-text-tertiary">添加关注</p>
            <ul className="flex flex-wrap gap-1.5 px-1">
              {candidates.map((id) => {
                const m = memberById(id)
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => toggle(id, true)}
                      className="flex items-center gap-1.5 rounded-md border border-border-secondary px-2 py-1 text-xs text-text transition-colors hover:bg-fill-secondary"
                    >
                      <MemberAvatar member={m} size="sm" />
                      {m.displayName}
                      <ui.plus className="size-3 text-text-tertiary" aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        ) : null}

        <Separator className="my-1.5" />
        <p className="px-1 text-[11px] leading-relaxed text-text-tertiary">
          关注是订阅提醒，不等于授权；被关注的成员不会因此自动进入分工名单。
        </p>
      </PopoverContent>
    </Popover>
  )
}
