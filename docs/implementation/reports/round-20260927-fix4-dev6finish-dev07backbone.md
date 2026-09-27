# 修复轮 4 + DEV-06 认证收口 + DEV-07 骨干报告

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `dc61db8`）
- 输入：用户指令（两个代码不一致问题先行、零额度反例优先、补齐剩余认证、实际推进 DEV-07、向 G3 收敛）
- 结果：默认 `pnpm check` **270/270**；daemon smoke **4/4**（零额度）；DEV-06 剩余认证 **5/5 + B6 双路径重跑通过**（gpt-6-luna，本轮真实 turn 共 10 次含 B6 重跑与排错）

## 一、两个收口（先零额度反例）

### 1. B6 证据与报告一致性

- 共享验证器 `src/adapter/codex/evidence.ts`（verifySandboxRejectionEvidence）：e2e 与负例回放共用。
- **可辨识拒绝原因**收窄为两种：`status:declined`（审批/沙箱明确拒绝）或 `status:failed;...;sandbox-denial`（失败输出 aggregatedOutput 命中沙箱/权限拒绝签名，adapter 侧携带 exitCode 并扫描签名）。纯 `status:failed`（语法错误等）、unknown、无关工具、错路径、口头拒绝（无工具活动）均不通过——7 个负例单测（tests/unit/b6Evidence.test.ts）。
- **B6-1 直接编辑**：真实重跑发现 read-only+never 下模型不产生可观测 fileChange 工具事件（首轮证据不足）→ 改为 **on-request 审批仪器化**：写尝试触发 `approval.requested`（请求含目标文件清单）→ deny → 内容逐字节未变。验证器接受「审批请求含目标 token」作为 fileChange 路径的可辨识权限门。
- **B6-2 shell 写入**：真实重跑通过——commandExecution 指向 b6-shell.txt + `status:failed;exit:N;sandbox-denial`（aggregatedOutput 命中拒绝签名）+ 文件未创建。
- 磁盘前后状态纳入断言（内容比对，非存在性）。

### 2. 单实例锁未知身份与接管

- **未知身份一律 BUSY**（ADR-I34 最小保守方案）：owner/claim 身份缺失、半写入、stat/read 失败——无论多久都不证明持有者死亡，不自动破坏锁，提示人工核对。移除 mtime 宽限后自动清理路径。
- **确认死亡的接管**：claim 归档用**原子 rename**（不再 rmSync）+ 归档内容**代次校验**（与所确认 pid 不符→还原+放弃启动）；死 claim 清理同样 rename+校验，绝不删除新接管者的 claim。
- 受控反例（tests/integration/m0Fixes.test.ts 修复轮4 组）：身份写入前暂停任意时长竞争者 BUSY；claim/owner 半写入（推老 mtime 后仍）BUSY 且锁不被自动破坏；清理者确认死后被替换→代次校验放弃且新 claim 原样保留；双进程并发恰一成功。

## 二、DEV-06 剩余认证（tests/e2e/realCodexRemaining.test.ts，gpt-6-luna）

| 用例 | 结果 | 证据 |
|---|---|---|
| steer 正常路径 | ✅ | 活跃 turn 追加输入（真实 expectedTurnId）→ 输出含原结果 LUNA-7 **且** STEERED-OK；对已完成 turn 再 steer → 服务端 JSON-RPC 拒绝（区分本地拒绝） |
| 审批 allow 路径 | ✅ | approval.requested 到达时磁盘快照=无文件（确认前无变更）→ allow_once → allow-probe.txt 创建且内容正确（BOM 归一） |
| resume 后权限不放宽 | ✅ | thread/resume 恢复上下文（LUNA-7 可回忆）+ 写请求仍被拒（文件未创建）——read-only 恢复不升权 |
| usageTokens 口径 | ✅ | 采集 9 条真实通知：cumulative、同 turn 单调非减、跨 turn 不串账（resume-ro-t2 首条与 t1 相同基数=恢复后重新累计，无重复求和） |
| 真实 interrupt | ✅ | 等待真实 turn.started 后 interrupt → turn/completed status=interrupted → 映射 turn.failed{code:INTERRUPTED} |

排错记录（如实）：interrupt 首跑「no active turn」——测试等待点读积压事件误判活跃（改为等待真实 turn.started 通知，单迭代器）；等待循环每轮新建迭代器导致 worker OOM（4GB）——改单迭代器复用（ADR-I23 同族经验）。

## 三、DEV-07 骨干（零额度落地）

- `src/daemon/commands.ts`：统一命令面——project.open（打开/去重/引导默认房间与成员）、message.submit（路由→单事务落库→outbox，runCommand 同步事务）、events.list、dispatch.resume（门禁用户确认）、task.stop（requestStop 自包幂等）；信封 strict 校验+本地可信 CallerContext+结构化错误（不吞异常）。
- `src/daemon/entry.ts`：startDaemon 组装（单实例锁→开库迁移→applyRecovery 落门禁→命名管道 IPC→drain tick→优雅退出）；runtime 注册表 fake（默认）/codex；独立进程入口（ZS_APP_DATA/ZS_RUNTIME）。
- `src/daemon/pipeClient.ts`：UI/renderer 侧 JSON 行协议客户端。
- smoke（tests/e2e/daemonSmoke.test.ts，4/4）：project.open 真实目录+幂等重放；message.submit→worker→任务 DONE→events.list 回流（run.created/thread.replyAdded）；信封多余字段/未知命令结构化错误；**重启**→历史保留+门禁 held 不自动续跑→dispatch.resume 后第二任务完成。
- 过程修复（真实缺陷）：**孤儿租约重排**（applyRecovery 原只重排过期租约——未过期孤儿租约卡死重启后派发；单实例锁保证旧持有者已死，改为全量重排）；**fake 会话 id 唯一化**（重启后 runtime_sessions 主键冲突）；commands 的 run helper 曾把 async handler 传同步 runCommand（data 序列化为空——修正为同步 handler+异步命令自包）。

## 四、G3 收敛状态

- **fake 层全链已通**（daemon smoke）：真实目录→project.open→指定成员→输入组装→执行→回复入正确线程→事件回流→重启保留+门禁→确认续跑。
- **真实层 G3 尚未打通**：需要 Electron main/preload + renderer 接线（挂 hifi-prototype 交互）+ ZS_RUNTIME=codex 的端到端演示（含停止/重启/双任务）。列为下一轮首要工作。
- 同成员双任务/切换界面/迟到事件串线：worker+存储层已有隔离测试（isolationTasks + 回放迟到反例）；UI 焦点切换不串线待 Electron 接线后验证。

## 口径（三段式）

- **已实现**：本报告全部代码改动；daemon 骨干（命令面/IPC/客户端/组装）。
- **已验证范围**：默认套件 270/270（含 B6 证据负例 7、锁 r4 反例 5、协议回放含 DispatchWorker×mock 集成）；daemon smoke 4/4（fake，零额度）；真实层累计 12 用例（C1/PP-01、B6 双路径、steer 正常+服务端拒、审批 allow+deny、resume 续接+不放宽、interrupt、usageTokens、resume 暗号）。
- **尚未验证/受阻**：真实层 G3（Electron UI+codex runtime 端到端）未打通；确认档 allow 后续接不放宽负例、structuredFinal 真实输出、steer 断连/不明投递、审批过期——未测；DEV-07 的 Electron 壳与正式 renderer 接线未开始。真实 turn 本轮消耗 10 次（B6-1×3、B6-2×2、steer×1、allow×1、resume×2、interrupt×1 排错另计）。
