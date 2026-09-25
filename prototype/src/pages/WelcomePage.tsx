import { Button, Card, CardContent, Switch, Tag, Tooltip, toast } from 'sparkdesign'

import { ui } from '@/lib/icons'
import { navigate } from '@/lib/router'
import { InlineMeta, ListRow, MetaDot, SectionLabel } from '@/components/common/Panel'
import { StatusTag } from '@/components/common/StatusTag'
import { EmptyState, ErrorState } from '@/components/common/States'
import { MemberAvatar } from '@/components/common/MemberIdentity'
import { fromNow } from '@/lib/format'
import {
  agentProfiles,
  errorNotices,
  projectMemberIds,
  projectRooms,
  projects,
  runs,
  tasks,
} from '@/data/mock'
import { runStatusView, taskStatusView } from '@/data/status'
import type { ErrorNotice } from '@/data/types'

const runtimeNotFound: ErrorNotice = {
  code: 'RUNTIME_NOT_FOUND',
  title: '未检测到 Gemini CLI（本项目不使用）',
  detail: '',
  retryable: true,
}

/** §17.2 欢迎页：本机为唯一控制面；打开一个文件夹即成为一个项目 */
export function WelcomePage() {
  const running = runs.filter((r) => ['QUEUED', 'RUNNING', 'WAITING'].includes(r.status))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 px-6 py-8">
        <section className="rounded-xl border border-border-secondary bg-bg-container p-6">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary text-lg font-semibold text-text-on-primary"
            >
              众
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-text">众说</h1>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                本地项目群聊多 Agent 协同工作台。一个文件夹 = 一个项目；在项目群里 @ 成员，
                就是给 TA 派活。多个 CLI Agent 以 Raft 式协作互相审阅，
                <span className="text-text">控制面与工单记录都留在本机</span>，代码不外传。
              </p>
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => toast('原型不会真的读取磁盘：请在正式版里选择项目文件夹')}
                >
                  <ui.folder className="size-4" aria-hidden />
                  选择本地文件夹作为项目
                </Button>
                <Button variant="outline" onClick={() => navigate(`/project/${projects[0]?.id ?? 'p-ec'}`)}>
                  继续上次的项目
                </Button>
                <Tooltip
                  content="v0.1 只开放「@单成员」直接派工；研讨与自动分工的入口保留但禁用，看得见、点不动"
                  side="bottom"
                >
                  <Tag appearance="outline" color="slate">
                    原型 v0.1 · 数据均为演示用
                  </Tag>
                </Tooltip>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <section>
            <SectionLabel>最近的项目</SectionLabel>
            <ul className="flex flex-col gap-2">
              {projects.map((p) => {
                const rooms = projectRooms(p.id)
                const open = tasks.filter(
                  (t) => rooms.some((r) => r.id === t.roomId) && t.status !== 'DONE' && t.status !== 'CANCELLED',
                ).length
                return (
                  <li key={p.id}>
                    <ListRow
                      onClick={() => navigate(`/project/${p.id}`)}
                      className="flex items-start gap-3"
                    >
                      <span
                        aria-hidden
                        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-fill-secondary text-sm font-medium text-text"
                      >
                        {p.displayName.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-text">
                            {p.displayName}
                          </span>
                          {p.status === 'recovering' ? (
                            <Tag appearance="outline" color="warning" className="shrink-0 py-0 text-[10px]">
                              待恢复
                            </Tag>
                          ) : null}
                          {p.status === 'archived' ? (
                            <Tag appearance="outline" color="slate" className="shrink-0 py-0 text-[10px]">
                              已归档
                            </Tag>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-text-tertiary">
                          {p.rootPath}
                        </span>
                        <InlineMeta className="mt-1">
                          <span>{rooms.length} 个房间</span>
                          <MetaDot />
                          <span>{projectMemberIds(p.id).length} 名成员</span>
                          <MetaDot />
                          <span>{open} 个未完成任务</span>
                          <MetaDot />
                          <span>rev {p.revision}</span>
                        </InlineMeta>
                      </span>
                    </ListRow>
                  </li>
                )
              })}
            </ul>

            <div className="mt-4">
              <ErrorState
                notice={errorNotices.projectMissing}
                onRetry={() => toast('原型不弹系统目录选择器，也不会写入项目记录：正式版这里会打开目录选择')}
              />
            </div>
          </section>

          <aside className="flex flex-col gap-4">
            <section>
              <SectionLabel>本机运行时</SectionLabel>
              <Card className="py-3">
                <CardContent className="flex flex-col gap-2.5">
                  {(['codex', 'claude'] as const).map((kind) => {
                    const list = agentProfiles.filter((m) => m.runtime === kind)
                    return (
                      <div key={kind} className="flex items-center gap-2">
                        <ui.terminal className="size-4 shrink-0 text-text-tertiary" aria-hidden />
                        <span className="text-sm text-text">
                          {kind === 'codex' ? 'Codex CLI' : 'Claude Code'}
                        </span>
                        <Tag appearance="outline" color="success" className="ml-auto py-0 text-[10px]">
                          已检测到 · {list.length} 个配置
                        </Tag>
                      </div>
                    )
                  })}
                  <p className="text-[11px] leading-relaxed text-text-tertiary">
                    决策 D4：v0.1 只接这两个 CLI。下面的失败样式是给「找不到运行时」时的呈现参考。
                  </p>
                  <ErrorState notice={runtimeNotFound} onRetry={() => toast('重新检测完成：仍未找到，符合预期')} />
                </CardContent>
              </Card>
            </section>

            <section>
              <SectionLabel>正在跑的运行</SectionLabel>
              {running.length ? (
                <ul className="flex flex-col gap-1.5">
                  {running.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <StatusTag view={runStatusView[r.status]} dense appearance="outline" />
                      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                        {tasks.find((t) => t.id === r.taskId)?.title ?? r.taskId}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                        {r.budget.used}/{r.budget.turns}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="没有运行中的任务"
                  description="所有调用都已结束；关掉右栏不会停止任务，这里也不会替你保留假状态。"
                  icon={<ui.cpu className="size-5" aria-hidden />}
                />
              )}
            </section>

            <section>
              <SectionLabel>第一次怎么用</SectionLabel>
              <ol className="flex flex-col gap-1.5 text-xs leading-relaxed text-text-secondary">
                {[
                  '打开一个文件夹，它就是一个项目，历史与工单存在项目旁边',
                  '确认两个 CLI 运行时可用，成员设置里指定谁用什么模型',
                  '在项目群里发一条消息：@ 单个成员即直接派工',
                  '成员在自己的回复串里干活，右栏看进度、成果与活动',
                ].map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="grid size-4 shrink-0 place-items-center rounded-full bg-fill-secondary text-[10px] text-text">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex items-center gap-2">
                <Switch defaultChecked aria-label="启动时提醒未完成任务" />
                <span className="text-xs text-text-secondary">启动时提醒未完成任务</span>
              </div>
            </section>

            <section>
              <SectionLabel>待办与关注</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {tasks
                  .filter((t) => t.status === 'WAITING_USER' || t.status === 'REVIEW')
                  .slice(0, 4)
                  .map((t) => (
                    <button key={t.id} type="button" onClick={() => navigate(`/task/${t.id}`)}>
                      <StatusTag view={taskStatusView[t.status]} dense appearance="outline" />
                    </button>
                  ))}
                {tasks
                  .filter((t) => t.status === 'BLOCKED')
                  .map((t) => (
                    <Tooltip key={t.id} content="工作目录被占用或等待授权" side="top">
                      <button type="button" onClick={() => navigate(`/task/${t.id}`)}>
                        <StatusTag view={taskStatusView.BLOCKED} dense appearance="outline" trailing={t.title.slice(0, 6)} />
                      </button>
                    </Tooltip>
                  ))}
              </div>
              <p className="mt-2 text-[11px] text-text-tertiary">
                完整列表见「待我处理」；{fromNow(runs[3]?.startedAt ?? '')}起有成员在等你的答复。
              </p>
            </section>
          </aside>
        </div>

        <section>
          <SectionLabel>项目成员模板（可稍后在项目里改）</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {agentProfiles.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`/member/${m.id}`)}
                className="flex items-center gap-2 rounded-lg border border-border-secondary bg-bg-container px-2.5 py-1.5 text-left transition-colors hover:border-border"
              >
                <MemberAvatar member={m} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-text">{m.displayName}</span>
                  <span className="block max-w-[160px] truncate text-[10px] text-text-tertiary">
                    {m.responsibility || '未填职责'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
