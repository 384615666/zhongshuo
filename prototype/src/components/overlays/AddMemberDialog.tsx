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
  RadioGroup,
  RadioGroupItem,
  Separator,
  Switch,
  Tag,
  Textarea,
  Tooltip,
} from 'sparkdesign'

import { cn } from '@/lib/cn'
import { ui } from '@/lib/icons'
import { projectRooms, rooms } from '@/data/mock'
import { createAgentMember } from '@/lib/mutations'
import type { AgentProfile, MemberSettings } from '@/data/types'

const EFFORT: { value: AgentProfile['reasoningEffort']; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

/**
 * §17.2「成员设置」的创建态 + §15 room.members.add。
 *
 * 之前整个原型没有任何添加成员的入口，成员页还写「到房间设置里把 TA 加入房间」，
 * 而房间设置里并没有那个控件——这条路径是断的。这里把断点接上：
 * 创建 agent 身份（决策 38 的七项设置）→ 选择立刻加入哪些房间 → 建完先记「遥测未知」，
 * 不假装在线。
 *
 * 邀请人类成员/多机协作按 §28 属 P2，界面保留但明确标注未开放，不做「看起来能用」的假象。
 */
export function AddMemberDialog({
  open,
  onOpenChange,
  projectId,
  defaultRoomId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  defaultRoomId?: string
  onCreated?: (member: AgentProfile) => void
}) {
  const [settings, setSettings] = useState<MemberSettings>({
    displayName: '',
    runtime: 'codex',
    model: '',
    reasoningEffort: 'medium',
    skills: [],
    responsibility: '',
    allowSubAgents: false,
  })
  const [skillsText, setSkillsText] = useState('')
  const [roomIds, setRoomIds] = useState<string[]>(defaultRoomId ? [defaultRoomId] : [])
  const [error, setError] = useState<string | null>(null)

  const projectRoomList = projectId ? projectRooms(projectId) : rooms
  const set = <K extends keyof MemberSettings>(key: K, value: MemberSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  const submit = () => {
    const name = settings.displayName.trim()
    if (!name) {
      setError('显示名称不能空：@ 它的时候总得有个叫得出口的名字。')
      return
    }
    if (projectRoomList.length && !roomIds.length) {
      setError('至少选一个房间，否则这个成员谁也进不去，只能躺在成员列表里。')
      return
    }
    const member = createAgentMember({
      ...settings,
      displayName: name,
      skills: skillsText
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      roomIds,
    })
    onCreated?.(member)
    onOpenChange(false)
    setSettings({
      displayName: '',
      runtime: 'codex',
      model: '',
      reasoningEffort: 'medium',
      skills: [],
      responsibility: '',
      allowSubAgents: false,
    })
    setSkillsText('')
    setError(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>
            决策 38 的七项设置在创建时就定好；runtime 用本机检测到的 CLI，
            新成员建完先记「遥测未知」，跑过一次才有在线事实。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <TabButton active onClick={() => undefined}>
            <ui.cpu className="size-3.5" aria-hidden />
            Agent 成员
          </TabButton>
          <Tooltip
            content="人类成员、邀请链接与多机协作按 §28 属 P2：首版只做单机项目，不引入服务器账号与联网协作依赖。界面保留入口，但明确标注未开放。"
            side="top"
          >
            <TabButton active={false} disabled onClick={() => undefined}>
              <ui.userPlus className="size-3.5" aria-hidden />
              邀请人类成员
              <Tag appearance="outline" color="slate" className="py-0 text-[10px]">
                后续版本
              </Tag>
            </TabButton>
          </Tooltip>
        </div>

        <div className="flex max-h-[58vh] flex-col gap-3.5 overflow-y-auto pr-1">
          <Field orientation="vertical">
            <FieldLabel htmlFor="new-member-name">显示名称</FieldLabel>
            <Input
              id="new-member-name"
              value={settings.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder="例如 Codex-3"
            />
          </Field>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field orientation="vertical">
              <FieldLabel>Runtime</FieldLabel>
              <NativeSelect
                size="default"
                aria-label="Runtime"
                value={settings.runtime}
                onChange={(e) => set('runtime', e.target.value as MemberSettings['runtime'])}
              >
                <NativeSelectOption value="codex">Codex CLI</NativeSelectOption>
                <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
              </NativeSelect>
            </Field>

            <Field orientation="vertical">
              <FieldLabel htmlFor="new-member-model">模型</FieldLabel>
              <Input
                id="new-member-model"
                value={settings.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder="留空即跟随该 runtime 默认模型"
              />
            </Field>
          </div>

          <Field orientation="vertical">
            <FieldLabel>思考强度</FieldLabel>
            <RadioGroup
              value={settings.reasoningEffort}
              onValueChange={(v) =>
                set('reasoningEffort', v as MemberSettings['reasoningEffort'])
              }
              className="flex gap-4"
            >
              {EFFORT.map((item) => (
                <label key={item.value} className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value={item.value} id={`new-effort-${item.value}`} />
                  {item.label}
                </label>
              ))}
            </RadioGroup>
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="new-member-skills">技能标签</FieldLabel>
            <Input
              id="new-member-skills"
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              placeholder="空格或逗号分隔，例如 前端 测试 重构"
            />
            {skillsText.trim() ? (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {skillsText
                  .split(/[,，\s]+/)
                  .filter(Boolean)
                  .map((s) => (
                    <Tag key={s} appearance="outline" color="slate" className="py-0 text-[10px]">
                      {s}
                    </Tag>
                  ))}
              </div>
            ) : null}
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="new-member-duty">职责说明</FieldLabel>
            <Textarea
              id="new-member-duty"
              value={settings.responsibility}
              onChange={(e) => set('responsibility', e.target.value)}
              rows={2}
              placeholder="协调者按职责判断该不该把活派给 TA"
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel>允许内部子助手</FieldLabel>
            <FieldContent>
              <Switch
                checked={settings.allowSubAgents}
                onCheckedChange={(v) => set('allowSubAgents', v === true)}
                aria-label="允许内部子助手"
              />
              <p className="text-xs text-text-tertiary">
                决策 11：不再作为认证否决项，改为按成员开关；开启后计入该成员用量与活动记录。
              </p>
            </FieldContent>
          </Field>

          <Separator />

          <div>
            <p className="px-1 pb-1.5 text-[11px] font-medium tracking-wide text-text-tertiary uppercase">
              立即加入房间（room.members.add）
            </p>
            <ul className="flex flex-col gap-0.5">
              {projectRoomList.map((room) => {
                const checked = roomIds.includes(room.id)
                return (
                  <li key={room.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-fill-secondary">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          setRoomIds((prev) =>
                            next === true
                              ? [...prev, room.id]
                              : prev.filter((id) => id !== room.id),
                          )
                        }
                        aria-label={`加入 ${room.name}`}
                      />
                      <ui.hash className="size-3.5 text-text-tertiary" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{room.name}</span>
                      <span className="shrink-0 text-[11px] text-text-tertiary">
                        {room.memberIds.length} 名成员
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <p className="mt-1 px-1 text-[11px] leading-relaxed text-text-tertiary">
              §4.3：任务运行中新加入房间的成员不会自动进正在跑的研讨——扩名单要在任务串的参与名单里单独确认。
            </p>
          </div>

          {error ? (
            <p className="rounded-md border border-error-border bg-error-bg/50 px-2.5 py-2 text-xs text-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={submit}>
            <ui.userPlus className="size-3.5" aria-hidden />
            创建成员
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
        active
          ? 'border-primary bg-primary-bg text-text'
          : 'border-border-secondary text-text-secondary hover:bg-fill-secondary',
        disabled && 'cursor-not-allowed opacity-55',
      )}
    >
      {children}
    </button>
  )
}
