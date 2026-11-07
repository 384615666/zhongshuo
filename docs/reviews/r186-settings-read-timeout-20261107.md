# R186：通知设置读取超时

日期：2026-11-07。用户截图为设置页「暂时无法确认通知设置」，错误是 `app.settings.get` 超过 15000ms。

## 定位与修复

- `app.settings.get` 只读取 `daemon_state` 的白名单设置。命名管道原来将它和 `message.submit`、运行时模型/参数查询等异步操作放入同一连接的串行队列。运行时元数据可以等待 30 秒、IPC 期限为 40 秒，但排在后面的设置读取仍会在 15 秒超时。
- 隔离命名管道和内存数据库复现了三种前置慢操作，以及「先写设置、再查元数据、最后回读」的阻塞。修复前四项均因 `app.settings.get` 超时失败。测试缩短读取期限到 1.5 秒，用显式屏障保持慢操作在途，避免每项实际等待 15 秒。
- 设置读取现在只等待该连接此前的设置写入，独立于无关慢操作响应。所有写命令和其他默认操作仍按 FIFO；保存后回读仍看到已保存值。按精确方法白名单处理，不对所有 `.get`/`.list` 方法开放并发；凭据、参数校验和 commandId 配对不变。
- 实际读取仍失败时，设置超时错误显示「读取设置超时，请稍后重试。」，保留原重试入口和失败时禁用开关的行为。未用默认值冒充读取成功，也未延长默认 15 秒期限。

## 现场证据边界

只读确认用户运行 beta.30（BUILD `bld_47ecf506a0d396af`）。尝试以现有本地凭据建立独立只读诊断连接时，后台拒绝了认证；未修改或重建凭据、未绕过认证。因此本轮修复的是已复现的排队缺陷，不能断言截图那次请求具体排在了哪个操作之后，也不能宣称原运行程序已恢复。

没有停止用户程序、安装更新、重放任务、修改运行数据或触发真实模型调用。该修复不解决同步代码长时间占用后台事件循环等其他超时来源；此前设置写入本身仍在等待时，后续回读会保留顺序等待。

## 验证

- 最终定向 **10 文件 / 81 项通过**：R186 新增 6 项，覆盖三个前置慢操作、写入与回读顺序、无关写入 FIFO、无效设置拒绝后继续读取、未知键拒绝和认证；并验证既有权限提示并发、超时迟到响应、通知开关、应用设置、设置页、导航取消、M0 IPC 和版本规则。
- 命令：`node node_modules/vitest/vitest.mjs run tests/integration/settingsReadQueueR186.test.ts tests/unit/permissionReadQueueR121.test.ts tests/unit/pipeClientTimeout.test.ts tests/unit/userFacingTextR119.test.ts tests/integration/notificationSwitchR157.test.ts tests/integration/dev14Commands.test.ts tests/browser/settingsSinglePageR157.test.ts tests/integration/m0Fixes.test.ts tests/integration/hifiNavCancelRound74.test.ts tests/unit/windowsReleaseVersionR148.test.ts --maxWorkers=2`，退出 0。未重跑完整套件。
- hifi 类型检查、4 个本轮源文件/测试的 ESLint、`git diff --check` 通过。根 `tsc --noEmit` 仍有 29 条既有 localOpen DOM 和本机未跟踪 R130/R180 夹具错误；本轮文件没有报告错误。
- 本机 pnpm 发现 `node_modules` 指向旧目录而拒绝自动安装；使用现有依赖的直接 Node 入口完成测试和构建，未删除或重装共享依赖。
- 安装器内 **668 文件**逐项长度/SHA256 核对、连接组件归档与源码一致、后台正式 IPC 等 **22 项通过**。在隔离数据目录启动随包 Node/daemon，通过测试钩子让前一个 `app.identity` 响应等待 **18000ms**，同一连接的设置读取 **1ms** 返回，前一个请求此时仍在等待；之后慢响应正确配对、通知设置写入与回读通过，正常停机 exit 0，真实模型调用 0。
- 证据仅本机 ignored：`dist/r186/targeted-tests.json`、`typecheck.log`、`installer-build.log`、`payload-check/result.json`。

## 交付

- Windows 安装包：`dist/installers/Zhongshuo-Setup-0.1.3-beta.31-x64.exe`，**160183624 字节**。
- SHA256：`f60f2a7e17b2b2df493f642b1522007fa2a31819ca41b7300a2190beda21c31e`，附 `.sha256`、`.release.json`。
- 安装器 BUILD `bld_b1d1b110b77f096c`，内部装配 BUILD `bld_b0241660983db5bb`。当前工作区候选，包含既有 R185 修改并如实标记 dirty，未签名。
- 仅交付安装包，用户自行安装。未安装、升级、卸载或进行静默安装验收；内部装配目录不作为便携交付物。未提交推送或创建 GitHub Release，保留既有未提交文件。
