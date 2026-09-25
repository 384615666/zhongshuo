import { useState } from 'react'
import {
  Button,
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

import { ui } from '@/lib/icons'
import { MemberAvatar } from '@/components/common/MemberIdentity'
import { SectionLabel } from '@/components/common/Panel'
import { StatusTag } from '@/components/common/StatusTag'
import { offlineReasonView, presenceView } from '@/data/status'
import { runMemberOp, saveMemberSettings } from '@/lib/mutations'
import type { AgentProfile, MemberSettings } from '@/data/types'

const effortLabel = { low: '低', medium: '中', high: '高' } as const

/** §25.6 的五个运维动作；结果句统一由 mutations.runMemberOp 给出，这里只留标签与图标 */
const OPS = [
  { key: 'stop', label: '停止成员', Icon: ui.pauseCircle },
  { key: 'resume', label: '恢复成员', Icon: ui.refresh },
  { key: 'restart', label: '重启 runtime', Icon: ui.plug },
  { key: 'session', label: '重置任务会话', Icon: ui.dashed },
  { key: 'purge', label: '清理托管私有资料', Icon: ui.lock },
] as const

/**
 * §17.2 成员设置弹窗（560px）+ Decision 38 的七项设置 + §25.6 的五个运维动作。
 * 模型留空 = 跟随 runtime 默认，界面上要说明而不是留个空白让人猜。
 */
export function MemberSettingsDialog({
  member,
  open,
  onOpenChange,
  onSave,
  onNotice,
}: {
  member?: AgentProfile
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (settings: MemberSettings) => void
  onNotice?: (msg: string) => void
}) {
  const [draft, setDraft] = useState<MemberSettings | null>(member ? { ...pick(member) } : null)
  const current = draft ?? (member ? pick(member) : null)
  if (!member || !current) return null

  const set = <K extends keyof MemberSettings>(key: K, value: MemberSettings[K]) =>
    setDraft({ ...current, [key]: value })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MemberAvatar member={member} size="sm" showPresence={false} />
            成员设置 · {member.displayName}
          </DialogTitle>
          <DialogDescription>
            {member.runtime === 'codex' ? 'Codex CLI' : 'Claude Code'} · 设置变更会推进
            settingsRevision，正在跑的运行仍按旧设置完成本轮。
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field orientation="vertical">
            <FieldLabel htmlFor="member-name">显示名称</FieldLabel>
            <Input
              id="member-name"
              value={current.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder="给成员一个你叫得出口的名字"
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel>Runtime</FieldLabel>
            <FieldContent>
              <NativeSelect
                size="default"
                value={current.runtime}
                onChange={(e) => set('runtime', e.target.value as MemberSettings['runtime'])}
                aria-label="Runtime"
              >
                <NativeSelectOption value="codex">Codex CLI</NativeSelectOption>
                <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
              </NativeSelect>
            </FieldContent>
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="member-model">模型</FieldLabel>
            <Input
              id="member-model"
              value={current.model}
              onChange={(e) => set('model', e.target.value)}
              placeholder="留空即跟随该 runtime 的默认模型"
            />
            {!current.model ? (
              <p className="text-xs text-text-tertiary">当前留空，实际使用 runtime 默认模型。</p>
            ) : null}
          </Field>

          <Field orientation="vertical">
            <FieldLabel>思考强度</FieldLabel>
            <RadioGroup
              value={current.reasoningEffort}
              onValueChange={(v) => set('reasoningEffort', v as MemberSettings['reasoningEffort'])}
              className="flex gap-4"
            >
              {(['low', 'medium', 'high'] as const).map((v) => (
                <label key={v} className="flex items-center gap-1.5 text-sm">
                  <RadioGroupItem value={v} id={`effort-${v}`} />
                  {effortLabel[v]}
                </label>
              ))}
            </RadioGroup>
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="member-skills">技能</FieldLabel>
            <Input
              id="member-skills"
              value={current.skills.join(', ')}
              onChange={(e) =>
                set(
                  'skills',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="用逗号分隔，如 代码检索, 迁移脚本"
            />
            <div className="mt-1 flex flex-wrap gap-1">
              {current.skills.length ? (
                current.skills.map((s) => (
                  <Tag key={s} appearance="outline" color="slate">
                    {s}
                  </Tag>
                ))
              ) : (
                <span className="text-xs text-text-tertiary">还没有技能</span>
              )}
            </div>
          </Field>

          <Field orientation="vertical">
            <FieldLabel htmlFor="member-resp">职责描述</FieldLabel>
            <Textarea
              id="member-resp"
              rows={3}
              value={current.responsibility}
              onChange={(e) => set('responsibility', e.target.value)}
              placeholder="写清楚 TA 在这个项目里负责什么，协调者派工时会用这段描述"
            />
          </Field>

          <Field orientation="horizontal">
            <FieldLabel>内部子助手</FieldLabel>
            <FieldContent>
              <Switch
                checked={current.allowSubAgents}
                onCheckedChange={(v) => set('allowSubAgents', v)}
                aria-label="允许成员自行派生内部子助手"
              />
            </FieldContent>
          </Field>

          <Separator />

          <div>
            <SectionLabel>运维动作</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {OPS.map((a) => {
                const Icon = a.Icon
                const disabled = a.key === 'stop' ? !member.enabled : a.key === 'resume' ? member.enabled : false
                return (
                  <Button
                    key={a.key}
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onNotice?.(runMemberOp(member.id, a.key))}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {a.label}
                  </Button>
                )
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-text-tertiary">
              这些动作只影响该成员的运行时，不会删除消息历史、成果或工作目录里的改动。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <StatusTag view={presenceView[member.presence]} dense appearance="outline" />
            {member.offlineReason ? (
              <span className="text-xs text-text-tertiary">
                {offlineReasonView[member.offlineReason].label}
              </span>
            ) : null}
            <Tooltip content="settingsRevision 用于判断哪份设置最终生效，冲突时以更高修订号为准">
              <span className="ml-auto font-mono text-[11px] text-text-tertiary">
                settings rev {member.settingsRevision}
              </span>
            </Tooltip>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onNotice?.(saveMemberSettings(member.id, current))
              onSave?.(current)
              setDraft(null)
              onOpenChange(false)
            }}
          >
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function pick(member: AgentProfile): MemberSettings {
  return {
    displayName: member.displayName,
    runtime: member.runtime,
    model: member.model,
    reasoningEffort: member.reasoningEffort,
    skills: [...member.skills],
    responsibility: member.responsibility,
    allowSubAgents: member.allowSubAgents,
  }
}
