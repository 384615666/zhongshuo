import { useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldContent,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  Tooltip,
} from 'sparkdesign'

import { ui } from '@/lib/icons'
import { MemberAvatar, presenceLabel } from '@/components/common/MemberIdentity'
import { navigate } from '@/lib/router'
import { isHuman, memberById, projectMemberIds, rooms } from '@/data/mock'
import { createRoom } from '@/lib/mutations'

/**
 * room.create（§15）。之前项目主页的「新建房间」只弹一句「原型不创建房间」，
 * 于是整条「开一个项目 → 拉人 → 派活」的路径在原型里是断的。
 *
 * 两条来自文档的硬约束直接反映在界面上：
 * · E5（§12.2 注）协调者是房间级字段，新房间沿用项目当前默认；
 *   协调者必须是房间成员，所以名单里勾掉协调者时这里会拒绝提交，而不是悄悄补一个。
 * · §17.1 示意图里的房间名（开发大厅 / 方案讨论）就是按议题分房，不按人分房。
 */
export function CreateRoomDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const memberIds = projectMemberIds(projectId)
  const agents = memberIds.map((id) => memberById(id)).filter((m) => !isHuman(m.id))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [coordinator, setCoordinator] = useState(agents[0]?.id ?? '')
  const [picked, setPicked] = useState<string[]>(agents.map((m) => m.id))

  const error = !name.trim()
    ? '房间名不能为空'
    : !coordinator
      ? '项目里还没有 agent 成员：先添加成员，再开房间'
      : !picked.includes(coordinator)
        ? '协调者必须在房间名单内（room.create 会直接拒绝）'
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ui.hash className="size-4" aria-hidden />
            新建房间
          </DialogTitle>
          <DialogDescription>
            房间按议题分，不按人分；成员先加入房间，之后 @ 谁、派不派研讨由输入条推导。
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[58vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field orientation="vertical">
            <FieldLabel htmlFor="new-room-name">房间名称</FieldLabel>
            <Input
              id="new-room-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：方案讨论"
            />
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="new-room-desc">房间简介</FieldLabel>
            <Textarea
              id="new-room-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说清这个房间在讨论什么（会显示在房间名下方）"
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel>协调者</FieldLabel>
            <FieldContent>
              <NativeSelect
                size="default"
                value={coordinator}
                onChange={(e) => setCoordinator(e.target.value)}
                aria-label="协调者"
              >
                {agents.map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.displayName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FieldContent>
          </Field>
          <p className="-mt-2 text-[11px] leading-relaxed text-text-tertiary">
            E5 定案：协调者是房间级字段，新房间沿用项目当前默认。TA 负责判定协作模式与分工。
          </p>

          <Field orientation="vertical">
            <FieldLabel>房间成员（room.members.add）</FieldLabel>
            <ul className="flex flex-col gap-1">
              {agents.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={picked.includes(m.id)}
                    aria-label={`把 ${m.displayName} 加入本房间`}
                    onCheckedChange={(next) =>
                      setPicked((prev) =>
                        next === true ? [...prev, m.id] : prev.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <MemberAvatar member={m} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{m.displayName}</span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">{presenceLabel(m)}</span>
                </li>
              ))}
            </ul>
          </Field>

          {error ? (
            <p className="rounded-md border border-error-border bg-error-bg/50 p-2 text-xs text-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Tooltip content={error ?? '创建后直接进入该房间，可立刻 @ 成员派工'} side="top">
            <Button
              variant="primary"
              disabled={!!error}
              onClick={() => {
                const id = createRoom({
                  projectId,
                  name: name.trim(),
                  description,
                  coordinatorMemberId: coordinator,
                  memberIds: picked,
                })
                onOpenChange(false)
                setName('')
                setDescription('')
                navigate(`/project/${projectId}/room/${id}`)
              }}
            >
              创建房间
            </Button>
          </Tooltip>
        </DialogFooter>

        <p className="text-[11px] leading-relaxed text-text-tertiary">
          当前项目共 {rooms.filter((r) => r.projectId === projectId).length} 个房间；
          归档的房间仍在此列出，只是不再接受派工。
        </p>
      </DialogContent>
    </Dialog>
  )
}
