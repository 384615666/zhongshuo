# REC-LIFE-1 实施排期：受管生命周期（Job Object）落地计划

日期：2026-09-29（第十一轮·五）｜状态：**已排期，随 Git 收口后实施（不需要用户重新拍板）**
｜上游决策：[ADR-0010](adr-managed-process-lifecycle.md)（Job Object 首选；ETW 增强；受管启动器不成立）
｜承载：DEV-05 supervisor 子项 REC-LIFE-1｜验收：ADR-0010 §3 六条

## 0. 排期结论

- 本轮（第十一轮）先完成 Git 收口（提交 `1332f00`→`3d1a98b`→`44fc273`）；REC-LIFE-1 紧随其后
  独立成批，**不与 Git/设置主线并行铺开**（用户令十一轮五）。
- 依赖序列：原生绑定选型 spike（0.5 天）→ 实现+接线（1—2 天）→ ADR §3 六条验收（本地
  node 子进程 fixture，零真实模型调用）→ 能力矩阵按平台/进程模型分列。
- 「未批准施工」不是等待用户的新阻塞：REC-LIFE-1 属既定恢复工程范围，按技术依赖排期即可。

## 1. 原生依赖与打包方式（落实点①）

- Job Object 无 Node 标准库接口，需要原生绑定。两条路线，spike 先行对比：
  - **A. 自写 N-API 模块**（`src/native/jobobject/`）：最小面=CreateJobObject +
    AssignProcessToJobObject + SetInformationJobObject(KILL_ON_JOB_CLOSE) +
    QueryInformationJobObject(ActiveProcesses) + CloseHandle；构建走 prebuildify +
    Electron ABI 双编译（`electron-rebuild`，DEV-15 打包链路首次引入原生依赖即验 ABI——
    与 DEV-15 的既有里程碑对齐，不提前）。
  - **B. 现成 npm 包**（如 windows-job-objects 类）：spike 验证维护度/ABI 覆盖/权限面；
    若满足即用，不重造。
- 选型判据：能否提供 §2 的**挂起创建**一体路径 + ActiveProcesses 查询 + prebuilt 覆盖
  目标 Electron ABI。两者都不满足 A 的最小面时才考虑 C# helper——但 helper 持句柄会破坏
  KILL_ON_JOB_CLOSE 兜底语义（见 §3），默认不走。
- 失败回退：**没有回退到不受管执行**（见 §5）；打包期原生构建失败=发布阻塞项而非降级项。

## 2. 启动时纳管的竞态处理（落实点②）

- 竞态窗口：`spawn(cli)` 与 `AssignProcessToJobObject` 之间，CLI 可能已派生子进程（逃逸 job）。
- 消除方案：Windows `CREATE_SUSPENDED` 创建 → 挂 job → `ResumeThread`。挂起态进程不可能
  派生，窗口为零。原生绑定需提供 `spawnSuspendedAndAssign(cmd, args) -> { pid, jobHandle }`
  一体入口（替代 Node `child_process.spawn` 的直接使用）。
- 若选型结果无法提供挂起创建：该候选**不合格**（不采用「先 spawn 后补挂 + 快照兜底」——
  那是第九轮已证伪的观察式缓解，不构成归属证明）。

## 3. 句柄生命周期与 shared/per-turn 差异（落实点③）

- **per-turn（Claude CLI）**：每 turn 一个 job；turn 终态且解除证明达成（ActiveProcesses=0）
  后 CloseHandle；daemon 正常退出时逐个关闭（优雅）；异常退出由 KILL_ON_JOB_CLOSE 兜底终止。
- **shared（Codex App Server）**：一个 job 覆盖 server 进程及其全部派生，随 daemon 生命周期
  管理（daemon 重启=server 重新拉起=新 job）；job 内 ActiveProcesses 含所有在途 turn 的执行
  载体——**单个 turn 的解除仍需 turn 级归属**（per-turn 辅助 job 或按 PID 清单比对
  ActiveProcesses），不改「业务结果确定≠执行载体停止」的口径。
- 句柄只在 daemon 进程内有效（不可持久化）：重启后按既有 pre-launch 登记表/进程登记
  对账收口；job 带来的增量只在「daemon 存活期间」提供可证明解除。
- 句柄表（内存）+ 意图落库（turn 级 job 归属标记写 runtime_process_registry），崩溃后
  新 daemon 可读「该 turn 曾纳管」事实。

## 4. daemon 崩溃后如何取得可核对事实（落实点④）

- KILL_ON_JOB_CLOSE：daemon（句柄持有者）崩溃 → 内核自动终止 job 内全部进程 → 重启后
  既有恢复链（probe/no-os-process/进程登记对账）能确认「无存活执行」——不再依赖周期快照
  的「未观察到」。
- 重启后对账路径不变：recovery.probeProcess / reconcile / releaseProtection 命令面复用，
  仅判定依据新增「该 turn 曾纳管 job（registry 标记）+ daemon 重启 + 当前无该 PID 存活」
  → 允许自动解除；未纳管的旧执行（升级前启动）维持第九轮保守关闭口径。

## 5. 纳管失败时拒绝启动（落实点⑤）

- `spawnSuspendedAndAssign` 任一步失败（job 创建失败/挂靠失败/恢复线程失败）→ 该次
  startTurn **前置失败**（如实错误码与原因），不派发、不降级为「不受管执行却声称安全」。
- 该失败计入派发失败路径（预算按未启动处理，与既有 pre-launch identity-missing 口径一致）。
- 能力矩阵按平台分列：win32=受管生命周期 supported（验收后）；非 win32=**未实现**
  （POSIX process group 为后续等价项，不把普通进程组声明为 Job Object 跨平台等价物——
  首版按实际支持平台分列，macOS 另评）。

## 6. 交付物清单（实施批完成定义）

1. 原生绑定（或选型包）+ suspended-spawn 一体入口；2. dispatchWorker spawn 侧接线
（per-turn/shared 两模型）；3. 解除判定接入 releaseProtection（ActiveProcesses=0 且句柄存活）；
4. registry job 归属标记；5. ADR §3 六条验收全绿（真实 node 子进程 fixture）；
6. 能力矩阵/continuation 按平台分列更新；7. 零真实模型调用。
