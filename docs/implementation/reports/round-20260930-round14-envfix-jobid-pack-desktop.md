# 第十四轮报告：环境块纠正 · jobId 正式绑定 · 打包验收 v2 · DEV-15 桌面便携产物 · merge 多父 diff（2026-09-30）

> 分组提交：`9caa4c3`（环境块规范调用撤回 FFI 结论+桥定时器/索引回收）→ `118effc`（jobId 正式绑定）→ `262ffa2`（打包验收 v2+daemon.shutdown+bundle 内受管全链）→ `dc9e1d9`（桌面便携产物）→ `bb12344`（merge 多父 diff）→ 本文档组。
> 数字（本地与网络分列）：**本地套件 562/562（60 文件，单次全量）**；githubSandbox 5 例**未重跑**（本轮未改远端链，按指令不重复；最近一次全绿=第十二轮 5/5）；verify-pack **17/17**、verify-desktop **6/6**、g3 fake e2e 回归 1/1；lint 0、tsc 0；**零模型调用、零真实 CLI 认证**。

## 一、环境块调用纠正（9caa4c3）——撤回第十三轮「恒 87=koffi 缺陷」结论

- **根因**：CreateProcessW 收到 UTF-16 环境块但创建标志缺 `CREATE_UNICODE_ENVIRONMENT`——系统按 ANSI 解释字节流。属**调用侧实现错误**，非 koffi 缺陷；第十三轮报告已加撤回注记，「需要覆盖环境请关闭受管开关」的绕行建议删除。
- 规范调用（按官方环境块规范逐项核对）：lpEnvironment=`const char16_t*`（LPVOID 对应）；传块必带 Unicode 标志；块=逐行 `NAME=value\0`+双 NUL 终止；**大小写不敏感去重**（Path/PATH 不产生冲突条目——按大写名去重、后写整行覆盖）；按名排序（大小写不敏感）；value 含 `=` 合法、空串=空值（与删除可区分）、`undefined`=删除（Node 语义）；空名/名字含 `=`/含 NUL 显式报错；缓冲在同步调用窗口内有效（koffi.alloc 生命周期覆盖）。
- **回读验证**（真实子进程，managedBridge）：缺省 env=继承父环境（生产路径等价）；完整替换 env 逐项回读——ASCII/中文/空值/带空格路径/覆盖父值/删除变量/32K 单值大块/同名大小写去重（后写为准）——全过；父进程环境不被修改。

## 二、受管身份 jobId 正式绑定与资源回收归属（第十四轮二）

- **登记**：`AdapterProcessIdentity` 增 `managedJobId`（契约）；两 adapter 如实上报桥进程的稳定身份；worker 登记写入 `runtime_process_registry.managed_job_id`（**迁移 020**；note 形态存量升级）；标记 managed-job 的条件=上报身份**且**本进程注册表确有其 job。
- **核对**：probe/reconcile/releaseProtection 按 `managed_job_id` 查找并核对，**PID 仅辅助属性**——缺身份（020 前历史形态）/无句柄（daemon 重启或已收尾）/登记 PID 与 job 实际 PID 不一致（复用/错位）/pid 查找可命中的**他人 job**，一律拒绝自动解除；probe 受管观察只产生 alive/unknown（释放依据独属 releaseProtection 完整证据链）。
- **顺序与收尾归属**（retireManagedJob 闸门，不依赖测试手动 dispose）：证据查询→DB 事务（租约+事件）→`markConsumed`→准入联动→闸门（最后）。per-turn job=终态 settle（closeProcessRegistrationIfTerminal）或证据消费后收尾，**有其他 open 登记共享则保留**；shared job=不随单 turn 收口（归 daemon stop `disposeAllManagedJobs` 与 adapter dispose）；失败可重试（证据不提前丢）。
- **桥资源回收**：轮询定时器 close/dispose **实际 clearInterval**（`managedActivePollers` 计数可验证）；pidIndex 复用 PID 守卫（只删仍指向本 job 的索引）；bridge close 时释放进程/线程句柄（ActiveProcesses 归零必要条件——生产 releaseProtection 无需外部手动放句柄；job 句柄保留供证据查询）。
- **正式链反例**（managedIdentity 3 用例，真实进程）：worker 全链（受管桥×Claude 回放 fixture×DispatchWorker：登记 managed_job_id→两任务 SUCCEEDED→settle 收尾→注册表/定时器归零→**准入释放（同成员第二任务继续派发）**）；PID 复用与错位引用拒绝（并实证旧口径 pid 查找确实会命中他人 job）；shared 两任务单收口不关+stop 全量收尾+重复解除幂等+准入钩子断言。断言面=数据库行/准入钩子/job 注册表与定时器计数（非只 releaseEvidence true）。

## 三、打包验收 v2（262ffa2）——修复第十三轮版假通过

- **假通过修复**：「优雅退出」=`daemon.shutdown` 正式 IPC 命令+退出码 0 严格确认（超时=null/signal/spawn error 单独分类，一律不算成功）；nmOverride 修复（原传第四参被忽略——移除后 `existsSync` 断言确实移除）；koffi 平台包按实际版本解析（读 package.json，不硬编码 3.3.2）。
- **正例=bundle 内受管全链**（IPC 驱动）：产物启动（ZS_MANAGED_RUNTIME=1——koffi 在 bundle 内加载否则拒绝启动）→claude 成员绑定 `.cmd` shim fixture（resolveClaudeExecutable 正式解析）→受管桥真实进程 turn（stdin EOF 合同解析→任务 DONE）→`task.stop`→受管 job 终止→CANCELLED→截止→UNKNOWN（保护保留）→reconcile 保留→probe 受管观察（根已退+活跃计数 0）→releaseProtection 正式入口→`daemon.shutdown`→退出 0→无遗留进程（Win32_Process 命令行核对）→SQLite 直查三登记行均 managed-job+managed_job_id。
- **负例**：精确移除 koffi+@koromix（断言移除）；安装目录 sqlite 探针 OK（失败不来自 SQLite）+koffi 探针 FAIL；产物启动退出 1+stderr 含「拒绝启动」且不含 SQLite 错误。
- **顺带修复三处产品缺陷**：①esbuild cjs 产物 `import.meta.url`=undefined→createRequire 抛错——源码级双形态锚定（`__filename`/`import.meta.url`/argv 兜底）；②管道名裸名被 node:net 当 TCP（EACCES）——startDaemon 统一补 `\\.\pipe\` 前缀；③probe 受管观察 rootExited 在句柄释放后恒 false（误报「根仍存活」）——生命周期备忘优先。
- **报告分层如实**：运行时=开发机 Node（process.execPath）在独立目录+干净 PATH 运行；「不依赖开发机运行时的安装产物」由桌面便携产物（四）的随包 Node 承接。`.tmp-vp2.py`（第十三轮一次性补丁）已删。

## 四、DEV-15 桌面便携产物（第十四轮四）

- **产物**：`dist/desktop/众说-便携-win-x64/`——Electron 运行时全量+`resources/app`（UI main/preload/renderer+package.json）+`daemon/daemon.cjs`+**随包 `daemon/node/node.exe`**（daemon 启动不经开发 PATH/系统 Node——ABI 与随包原生模块自洽）+node_modules 按实际版本解析。本地可复核、不发布、不安装、不改用户环境。
- **UI main 打包形态**：布局判定（`resources/app/daemon/daemon.cjs` 存在——便携 exe 未改名时 `app.isPackaged`=false 不可作依据）；ZS_MANAGED_RUNTIME **默认 1**（koffi 缺失=daemon 拒绝启动→应用明确失败 exit 1，不静默降级；`=0` 显式关闭仅排障）；**正式停机**=daemon.shutdown（优雅→收拢→关库→退出 0）+有界等待+kill 兜底（window-all-closed 与演示退出同路径，不再裸 kill）；daemon 异常退出→应用明确失败退出（空管道挂死窗口更糟）。
- **verify-desktop 6/6**（中文+空格安装目录）：首启全链（fake turn DONE+exit 0）/正常退出（pid 文件移除+无产物残留进程）/重复启动（单例锁随干净退出释放）/精确移除 koffi 断言/受管缺失=exit 1+拒绝启动日志/负例无残留。g3 fake e2e 回归通过（开发形态入口不受影响）。
- **未验证（如实）**：安装器/代码签名/自动更新；独立 Windows 机器（当前验证均在开发机——若成为唯一剩余条件：需一台无 Node/无本仓依赖的 Windows 10/11 x64，复制产物目录运行 verify-desktop 同款断言即可，无需云主机/付费工具/额外账号）。

## 五、merge 提交多父 diff（bb12344）

- `gitCommitDiff` 增 `parentOid`：多父未选=`parentsMeta`（各父 oid/short/主题/时间）+注记（不虚构单一「合并 diff」总览）；选定=校验必须为本提交的父（跨对象比较拒绝）→diff-tree 两树形态——**差异=本提交相对该父的实际变更**（另一侧带来的变更如实体现为相对此父的新增/修改）；单父/根提交传 parentOid 同样校验拒绝。
- UI（Git 历史 diff 展开）：merge 提交渲染父选择行（短 OID+主题按钮；当前父禁用高亮），点击按该父重新加载，标题绑定对比父 OID；相对父无差异如实显示。
- 测试（gitRt24 10/10）：main 侧父=side 文件新增+正文；side 侧父=无差异（同提交换父换结果——绑定生效）；非父 oid/单父传值拒绝。

## 六、四层证据分级（仅在实际通过后升级）

| 层 | 状态 | 本轮证据 |
|---|---|---|
| 底层模块（jobManager/bridge/adapter） | ✅ | managedBridge 6/6（含环境回读）；managedLifecycle 9/9 |
| 本地正式链（daemon/worker/命令面） | ✅ | managedIdentity 3/3（worker 全链+反例+shared/stop）；recovery/processTree/dispatch 回归全绿；本地套件 562/562 |
| 打包产物 | ✅ **升级** | verify-pack 17/17（bundle 内受管全链+负例）；verify-desktop 6/6（便携桌面产物：随包 Node+受管默认开+优雅停机） |
| 真实 CLI（受管 claude/codex 实战、真实 lateEvents） | 未验证（如实） | 本轮零模型调用、零真实认证；补证方案见下，未批准不执行 |

## 七、最小受管实战补证方案（成文待批——未批准不执行）

- **目标**：在受管链（Job Object 纳管→证据→解除）上验证一次真实 Claude Code CLI turn（deepseek-flash），逐次列明目的与停止条件。
- **第 1 次（上限 1 turn）**：受管 spawn 真实 `claude -p`（成员绑定 deepseek-flash，只读档参数与既有 adapter 一致）→验证：纳管句柄登记（managed_job_id）、stdin prompt/流式事件解析、SUCCEEDED 后 settle 收尾（注册表归零）、usage 落库。**停止条件**：任一步与 fixture 链行为不一致即停，先修再议。
- **第 2 次（上限 1 turn，第 1 次通过后）**：截止/停止路径——真实 turn 运行中 `task.stop`→job 终止→CANCELLED→证据链核对。**停止条件**：进程收拢不确定（unconfirmed）即停并保留现场。
- 不动用旧批次剩余 3 次真实调用额度；真实 lateEvents（CLI 无会话持久化）维持 unsupported 口径；凭据不读不印。
