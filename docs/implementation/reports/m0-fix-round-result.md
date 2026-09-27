# M0 核心修复轮报告（外部只读审查整改）

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `2535a74` = DEV-17 检查点）
- 输入：用户转交的外部只读审查（8 项缺陷 + 2 项记录错误）
- 结果：**全部整改完毕**；`pnpm check`（tsc + eslint + vitest）**222/222 全绿**（新增 18 个反例/行为用例）

## 整改对照

| 审查项 | 整改 | 验证 |
|---|---|---|
| 1 过期租约绕过 + RT-07 假阳性 | acquire 检查 active+expired；测试先断言 expired 再验阻塞/终止放行 | projectWorkspace.test.ts（含前置断言与 holders 状态） |
| 2 超时依赖事件到达 | 独立截止计时+中断宽限；worker 级两用例 | m0Fixes：沉默→中断 CANCELLED（2117ms→按时）；中断无响应→UNKNOWN/INTERRUPTED 不伪造 |
| 3 会话打开期停止失效 | openSession 后复查→不 startTurn、取消收尾+审计 | m0Fixes：openSessionDelayMs 400ms 窗口内停止；无消息产生 |
| 4 恢复无执行约束 + 重领冲突 | 003 迁移 daemon_state 门禁（held/open）；重领→failOutbox+reconcileRequired | m0Fixes：恢复后 drain=0、确认后续派；重领不新建 turn |
| 5 单实例锁非原子 | O_EXCL+陈旧锁原子接管 | 真实双进程竞态 fixture：恰好一个赢家 |
| 6 上下文过滤不足 | 白名单归属校验+3 反例；worker 接入 ContextBundle（过滤+落库+真实输入）；同成员双任务隔离 | isolation.test.ts / isolationTasks.test.ts / m0Fixes |
| 7 事件 ID 不一致 | replyAdded payload 用实际 rowId；按事件可查到消息 | m0Fixes |
| 8 模式不拒绝/验收不执行 | 非 DIRECT→BLOCKED+审计；user_review→REVIEW+pending 交付、auto_deliver→DONE+not_required | m0Fixes（AUTO/DELIBERATE 两例 + 验收两例） |
| 记A 总账双记录 | implementation-status.md 整体重写（去 3 行重复、下一步更新、修复轮小节） | 本文件 |
| 记B parallel_writers 违约开放 | 入口一律拒绝（ADR-I19），放行测试改拒绝测试 | projectWorkspace.test.ts |

## 修复中额外发现并修复的缺陷（审查未列出）

1. worker 事件竞速丢弃 pending 的 `iterator.next()` 会吞事件（async iterator 禁止并发 next）——保留 pending promise 复用（ADR-I23）；沉默超时用例正是被它击穿后暴露。
2. 命名管道 IPC 同 socket 并发处理导致响应乱序（坏行响应先于前序合法请求）——改行 FIFO 串行队列。

## 完成声明修正（采纳审查建议口径）

- **本轮后成立**：六包实现程度不同、经修复与反例覆盖后，写入租约、调度生命周期（超时/竞态/门禁/重领/模式/验收）、恢复、任务级隔离与事件合同在**fake adapter + SQLite 存储级**验证通过。
- **仍不成立**：真实进程停止与恢复（随 DEV-06 实测）、IPC 的 Electron 接线（传输层已可用测试客户端验证，UI 接线随 DEV-07）、完整用户闭环（G3）、阶段级隔离（DEV-08/09）。不据此认定 M0 后端核心全部验收通过——M0 收口以 G3 为准。

## 修改文件

`src/daemon/`（workspaceLocks/dispatchWorker/stopFlow/singletonLock/namedPipeIpc 新增）、`src/persistence/`（daemonState.ts、migrations/003）、`src/adapter/fake/runtimeAdapter.ts`（openSessionDelayMs/closeAllSessions）、`src/domain/isolation/contextFilter.ts`、`src/persistence/stores/roomRootTask.ts`（route_json/owner）、`tests/`（m0Fixes.test.ts 新增 18 例 + projectWorkspace/isolation/isolationTasks/dev05Daemon 更新）、`docs/implementation/`（总账重写、三报告勘误、ADR-I19—I23、本报告、continuation）。未触碰 `hifi-prototype/`。
