# DEV-04 完成报告：项目目录、锁域与基线清单

- 日期：2026-09-27 · 分支：`codex/full-implementation`（基线 `30e5424` = DEV-03 检查点）
- 状态：**VERIFIED**（真实文件系统集成测试：Windows 11 实测 junction/大小写/移动重定位）

## 实现范围

| 交付 | 落点 | 依据 |
|---|---|---|
| 目录身份解析（realpath 解析 junction/符号链接/短名；win32 比较键折叠大小写、存储保留原样；路径边界祖先判定，禁止裸前缀） | `src/daemon/directoryIdentity.ts` | §3.3 |
| 项目打开/去重/重定位（identityKey 命中→同 projectId 不新建；relocate 保 id + revision+1；不允许重定位到其他项目物理目录；PROJECT_MISSING） | `src/daemon/projectStore.ts` | §3.3/RT-14 |
| 写入租约（single_writer 同域≤1、parallel_writers 上限+跨父子域拒绝、重叠锁域逐租约检查、WORKSPACE_BUSY 携带持有者、epoch fencing、RT-07 过期阻塞至确认终止） | `src/daemon/workspaceLocks.ts` | §10.3/§14.1/RT-07/08/09 |
| 基线清单（排除 VCS/依赖/构建/凭据；大文件/二进制/junction 不跟随如实入排除表；每文件 sha256；Git HEAD 读取不依赖 git 二进制；清单内容寻址落盘+baselines 行幂等） | `src/daemon/baseline.ts` | §6.3/§14.2 最小 |

## 验证证据

- 命令：`pnpm check`；结果：typecheck 0 错、eslint 0 错、**vitest 14 文件 183/183**（新增 16 集成用例，2026-09-27 09:17）。
- 关键实测（真实 fs）：同目录二次打开命中同 id；小写入口命中且首次登记路径不被改写；**junction 入口命中同一项目**（RT-09 前置）；父子目录锁域并发被拒（single_writer 与 parallel_writers 均拒绝跨域）；RT-07 过期租约阻塞→确认终止放行；epoch 递增；重定位保 id、撞库拒绝、STALE_REVISION；基线排除五类原因+hash 可核对+Git HEAD/branch 解析（含 packed-refs 兜底路径）+同内容 hash 幂等。

## 未实现/交接

- §14.2 完整前像（Git 跟踪文件工作区内容、范围内未跟踪文件快照）与 ChangeSet diff → DEV-12；本包交付清单与 ref 记录。
- 进程树终止确认（confirmLeaseTerminated 的核实来源）→ DEV-05 supervisor。
- 快照复制前后源文件变化检测（§6.3 变化则重试）→ DEV-08 研讨基线时完善。
- appData 目录接线（§12.1 布局、baseline 存储目录默认值）→ DEV-05 daemon 引导。

## 修改文件

新增：`src/daemon/directoryIdentity.ts`、`projectStore.ts`、`workspaceLocks.ts`、`baseline.ts`、`tests/integration/projectWorkspace.test.ts`；总账更新。未触碰 `hifi-prototype/`。
