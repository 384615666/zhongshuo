# 修复轮 5 + DEV-07 Electron 接线 + 真实 G3 首通报告

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `f6fa5df`）
- 结果：默认 `npx vitest run` **270/270**；daemon smoke **6/6**（纯 IPC）；G3 Electron **fake 档 ✓ + codex 档 ✓**（真实 runtime gpt-6-luna，本轮真实 turn 2 次）

## 一、命令链路修复（零额度先行）

1. **pipeClient 重写**（响应分配）：每请求独立 pending 关联 + FIFO 配对（不再重复 shift 丢等待者）；超时只失败本请求；断连/错误/坏 JSON failAll 未决请求（无 pending 泄漏）；握手前 auth.ok 不进命令队列。反例：3 并发各归其位、业务错误不串、断连后未决请求明确 reject 并可重连（smoke 用例 4）。
2. **smoke 去直接补库**：project.open 正式命令内引导成员/房间/**房间成员关系**/会话；新增查询命令 room.list / member.list / thread.history / task.get。smoke 重写为纯 IPC（空库起步，只读断言，无 INSERT/UPDATE）。
3. **IPC 服务端握手凭据**：首帧 `{"type":"auth","token"}`；错/无凭据连接被拒（AUTH_REQUIRED + 断开）；daemon 每实例生成 token（appData/local.token，0600 语义）。`dispatch.resume` 参数化 `{confirm:true}`（空参数拒绝）+ runCommand 幂等。同 socket FIFO 串行恢复（响应不再错位）。
4. **daemon 生命周期**：drain 单飞保护（计时器不重入，串行调度）；stop 顺序=停 tick→断 IPC→收拢 adapter（等待子进程退出）→关库→释放锁；重复 stop 幂等；启动失败部分资源清理；孤儿租约重排（ADR-I36）与旧进程确认分开（进程身份核实随 DEV-13/20）。

## 二、DEV-07 正式 UI（Electron）

- **main**（src/ui/main.ts）：daemon 为**系统 Node 子进程**（Electron ABI 与 better-sqlite3 预编译不兼容——ELECTRON_RUN_AS_NODE 实测失败 UnknownVizError/ABI mismatch，ADR-I38）；管道客户端 + 断连重连通知；`ZS_UI_DEMO` 自动化演示（G3 取证）；fake 需 `ZS_ALLOW_FAKE=1`（正式路径不静默 fake）。
- **preload**：唯一暴露 `zs.command/zs.pickFolder/断连重连回调`；无 Node 直访。
- **renderer**（沿原型布局：侧栏项目+房间、主池卡片、线程回复、底部输入区）：打开文件夹、成员选择（结构化 mention）、DIRECT 发送、一次性「仅记录」、线程回复轮询、断连提示、停止按钮挂命令面；失败 alert 如实展示、无种子回退。
- 构建：esbuild → dist/ui/main.cjs + preload.cjs（package type:module 需 .cjs）；renderer 静态文件。

## 三、真实 G3（ZS_RUNTIME=codex，gpt-6-luna，fixture=真实文件 notes.md 暗号 G3-CODEX-8848）

**链路**：Electron UI（ZS_UI_DEMO 自动化，等价人工点击）→ project.open（真实目录）→ 查询命令选成员 → message.submit（DIRECT）→ worker 正式输入组装（含用户根消息）→ codex adapter（thread/start + developerInstructions）→ turn/start → 模型真实读取 notes.md → 回复进正确线程 → TaskComplete JSON → worker schema 校验 → 任务 DONE。

- 第 1 次（真实 turn）：模型读到真实文件（回复含 G3-CODEX-8848）但输出契约字段不符（自带 `kind/result` 字段）→ OUTPUT_INVALID、任务 ACTIVE——如实记录为 structuredFinal 链路缺陷。
- 修复（零额度）：renderTurnBundle 输出契约分节加入**精确字段约束**（schemaVersion/resultKey/changeSummary/files/…）。
- 第 2 次（真实 turn）：**通过**——任务 DONE、线程含 G3-CODEX-8848、交付经 schema 校验（tests/e2e/g3Electron.test.ts codex 档 ✓）。
- 截图：本会话 GPU 合成器不可用（RDP，capturePage 抛 UnknownVizError）——已改为非致命（shot=null 如实记录），业务链路证据以结果 JSON + 测试断言为准。

## 四、G3 场景覆盖现状（如实）

| 场景 | 状态 | 证据 |
|---|---|---|
| 打开真实目录→选成员→UI 发送→正式输入→真实文件→正确线程 | ✅ 真实（codex 档） | g3Electron codex 用例 |
| structuredFinal 真实结果经 worker 校验→交付 | ✅ 真实（第 2 次 turn） | 同上（taskStatus DONE） |
| 重启后历史保留+门禁不自动续跑+确认续跑 | ✅（fake 档 daemon smoke） | daemonSmoke 用例 5（Electron demo 内等价链路） |
| 同成员双任务不串输入/事件/输出 | ✅（存储+worker 层） | isolationTasks（含输入包隔离）+ 协议回放双会话并发/迟到 |
| 重复点击/重试不重复派发 | ✅（命令层） | smoke 幂等重放 + RT-01/RT-05 |
| 后台失败/断连不显示假成功 | ✅（IPC 层） | pipeClient 断连清理 + smoke 业务错误；UI 侧 alert |
| 运行中停止（UI→task.stop→真实 interrupt） | 部分：组件各自已验（task.stop 真实 INTERRUPTED + UI 停止按钮接线），端到端 UI 停止演示未录 | realCodexRemaining interrupt ✓ |
| 双任务**真并发交错**（非先后） | ⚠️ 未验：当前 worker 串行 | 记入下一步 |
| 运行中退出→重启不重复执行不确定工作 | ⚠️ 部分：恢复重排+门禁已验；"不确定窗口不重跑"的端到端注入未做 | 记入下一步 |

**G3 判定**：核心链路（真实目录→成员→发送→真实文件→正确线程→持久交付）已真实验证通过；两个子场景（UI 停止演示、双任务真并发交错）待补，不据此宣称"G3 全部完成"。

## 五、权限证据按实际配置分别记录

- B6-1 证据=**read-only + on-request + deny 审批仪器化**（read-only+never 下模型不产生可观测 fileChange 工具事件——如实标"该配置直接编辑限制证据不足"）。
- B6-2 证据=read-only + never（commandExecution + sandbox-denial 签名）。
- 确认档=ro+on-request：allow/deny 双路径。三者已在能力矩阵分列，不互相冒用。

## 六、未完成/下一步

- UI 停止按钮端到端真实演示；双任务真并发交错（需 worker 并发调度或双 daemon 实例——按 §10.3 并发限制设计）。
- 运行中退出→重启的"不确定窗口不重跑"注入用例（DEV-13 联动）。
- Electron 打包形态的随包 Node（DEV-15）；renderer 全面复用原型组件级样式（本轮为布局对齐+命令面接线）。
- steer 正常路径已有（r4）；不重跑已过项。
