# R202 独立代码审计与修复（2026-11-08）

审计基线：分支 `r202-audit`，HEAD `4538a42`，众说 `0.1.3-beta.46`。开始时工作区干净。确认 **4 个问题**，均已在本 worktree 修复；没有变更版本、品牌资源、README、首页或安装器。没有安装依赖、构建安装包、安装/升级/卸载应用、推送、调用真实模型或操作用户运行数据。

## 发现与修复

下面的位置均为修复后文件行号。P1 表示高优先级安全边界问题，P2 表示数据正确性或可用性问题。

### F1 · P1 · Markdown 标签可以掩盖实际打开文件的扩展名

- 位置：`src/ui/hifi/preview/MarkdownView.tsx:328`。
- 原因：本地文件条目优先使用作者提供的 Markdown 标签；例如 `[报告.pdf](file:///C:/exports/run.cmd)` 显示为“报告.pdf”，点击却把 `run.cmd` 交给系统默认程序。这条新加入的本机打开路径使隐藏实际文件类型具有安全影响；悬停 tooltip 不能替代正确的可见文件名。
- 修复：本地条目的可见名称始终取自解析后的真实路径 basename。打开仍须用户显式操作。
- 验证：`tests/browser/localFileLinksR202.test.ts:8` 实际渲染生产 `MarkdownView`，断言显示 `run.cmd`、路径仍准确且没有伪装标签；另有 HTML/脚本链接保持转义、无可执行链接的渲染断言。修复前该用例真实失败。
- 修复 commit：未能创建，见“提交限制”。

### F2 · P2 · 手工解析 file URL 导致有效链接失效，并把无效输入变成 UNC

- 位置：`src/ui/hifi/lib/localFileHref.ts:7`。
- 原因：`file://localhost/C:/x.txt` 被转换为 `\\localhost\C:\x.txt`；查询串与 fragment 被当作文件名。`file://`、`file://server`、`file:///relative.png` 等缺少有效文件路径的输入仍生成 UNC 路径；非法百分号编码与编码控制字符也未拒绝。
- 修复：使用 URL 解析 authority、pathname、query、fragment；本机要求 Windows 绝对盘符，UNC 要求有效共享路径；只解码 pathname，保留编码后的 `#` 等真实文件名字符，拒绝无效编码、控制字符及编码路径分隔符。
- 验证：`tests/browser/localFileLinksR202.test.ts:17`、`:22` 覆盖 localhost、query、fragment、编码文件名及无效输入；原 R201 盘符、中文、空格、UNC 用例继续通过。修复前两项新增用例真实失败。
- 修复 commit：未能创建，见“提交限制”。

### F3 · P1 · 图片路径副本可经目录 junction 写出应用数据目录

- 位置：`src/daemon/commands.ts:3898`。
- 原因：`attachment.absolutePath` 只验证 `resolve(target)` 的字符串前缀；若 `attachment-paths` 是指向外部目录的 junction，`mkdirSync` 仍成功，后续写入落在外部真实目录，违反该命令只写应用数据区的合同。
- 修复：写入前核对副本目录的 realpath，拒绝含 symlink/junction 的目录；复用已有目标前也检查 lstat/realpath。写入使用已有 `atomicWriteFile`，替换目录项，不原地写入已有硬链目标；失败不先删除旧副本。
- 验证：`tests/integration/imageAttachmentPathR197.test.ts:118` 创建真实 Windows junction，调用正式命令，断言 `FORBIDDEN` 且外部目录保持空。修复前命令返回成功并写出文件，修复后通过。`:99` 另验证硬链目标保留原字节、返回副本变为正确图片。
- 修复 commit：未能创建，见“提交限制”。

### F4 · P2 · 图片副本同大小篡改未检测，前端永久缓存使删除/篡改不能恢复

- 位置：`src/daemon/commands.ts:3909`；`src/ui/hifi/lib/imageAttachmentPaths.ts:47`、`:96`。
- 原因：副本只比较字节数；用相同长度的其它内容覆盖副本后，命令继续报告正确的 MIME/长度并返回损坏文件路径。前端又永久缓存成功结果，因此后续复制、引用、复制路径操作不会重新调用 daemon；副本被删除也持续得到失效路径。
- 修复：只有实际字节等于已验证原件才复用，否则原子重建；前端只合并在途请求，请求完成后释放缓存，下次用户操作重新核验。
- 验证：`tests/integration/imageAttachmentPathR197.test.ts:80` 同长度改写、删除、再请求，均恢复原图，且 `attachment.previewImage` 返回的托管原件不受影响；`tests/browser/imageAttachmentPathsR202.test.ts:8` 模拟桥，断言并发只请求一次、下次操作再次发送正式命令。修复前同长度篡改用例真实失败。
- 修复 commit：未能创建，见“提交限制”。

## 审计范围与未新增发现的部分

- 已读 AGENTS、continuation 顶部 R201/R200/R199/R198/R197、implementation-status、R201 review 和 package.json；核查所列近期 UI、导航、身份、图片路径、剪贴板及相关测试。
- R200：回复标读仍受当前回复页、前台、历史阅读状态等门控制；成果/交付深链与任务继续、结束入口保留。正式成员命令仍有 audience、项目、成员可用性、归档及 expectedVersion 校验；已有测试覆盖移除覆盖历史身份、ABA/陈旧版本拒绝及移除后派发阻断。没有把有意删除详情页视作缺陷。
- R198：AUMID 删除参数由受限标识生成并以参数数组传给 `reg.exe`；快捷方式的 AUMID 与激活元数据保留。没有实际执行注册表删除或系统通知实验。
- 本地文件桥继续校验 IPC 来源、绝对路径与文件存在性，打开方式由主进程重新解析枚举 ID；剪贴板桥继续检查来源、图片 data URL、长度和实际解码。Markdown 原始 HTML 保持转义。没有根据假设扩大文件打开白名单或改写这些合同。
- 测试可信度：R201 部分测试确实只断言源码字符串，截图脚本中的 LiveProgress 探针也是构造 DOM。新增测试直接渲染生产组件、调用正式 daemon 并检查真实文件字节/junction/硬链，补足本次缺陷的行为证据。R152/R153 helper 使用合成桥，没有真实业务模型派发；本机 Chromium 验证受下述环境限制。

## 验证命令与结果

默认 Vitest 配置加载会尝试写 junction 指向的共享 `node_modules/.vite-temp`，被权限拒绝；因此统一附加 `--configLoader native --no-cache`，未修改共享依赖或项目配置。需要临时构建的补充验证将 `TEMP`/`TMP` 指向本 worktree 的 `dist/r202-audit/tmp`。

1. `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.hifi.json`：均 exit 0，最后新增用例后再次通过。
2. `node scripts/build-ui.mjs`：exit 0；仅保留已有 windowsFileAssociations 的 import.meta/CJS 提示。`node scripts/pack-daemon.mjs`：exit 0，仅为 fake UI 回归准备 daemon 测试 bundle，不制作安装包。
3. 最终定向 4 文件：`node node_modules/vitest/vitest.mjs run tests/browser/imageAttachmentPathsR202.test.ts tests/browser/localFileLinksR202.test.ts tests/integration/imageAttachmentPathR197.test.ts tests/integration/r201UiFeedback.test.ts --maxWorkers=2 --configLoader native --no-cache`：**4 文件 / 22 项通过**；日志 `dist/r202-audit/repairs-tests.log`。
4. 补充正式链验证（本地 TEMP）：上述四文件 + `hifiThreadRound51`、`hifiNavCancelRound74`、`threadMembersR87`、`windowsIdentityR163`、`taskNotificationDesktopR108`、`localFileActionsR172`：**10 文件 / 77 项通过**；日志 `dist/r202-audit/focused-final.log`。
5. 快测 `node node_modules/vitest/vitest.mjs run tests/unit tests/browser --maxWorkers=4 --configLoader native --no-cache`：**126 文件通过 / 16 失败；982 项通过 / 17 失败**，失败集中在 Electron 启动/加载及系统临时目录构建；日志 `dist/r202-audit/fast-tests.log`。
6. 全量按 `git ls-files` 选取 unit/integration/browser 的 `.test.ts`，排除 `githubSandbox.test.ts`，加入两个新文件，`--maxWorkers=4 --configLoader native --no-cache`：**382 文件：325 通过 / 55 失败 / 2 跳过；3428 项：3222 通过 / 187 失败 / 3 预期失败 / 16 跳过**，约 283 秒。日志 `dist/r202-audit/full-tests.log`，失败摘要 `full-failures.json`。此轮在最后新增硬链用例之前运行，该新增用例已由第 3/4 项验证。
7. 对 `codexPreparationR84`、`coordinationManifestR154`、`taskProjectionR78`、`gitWrite`、`workerRecoveryR126`、`writeConcurrencyR152`、`executionConcurrencyR153`、`projectBaselineR118`、`sessionWriteQueueFeedback3` 做原 HEAD/修复后同条件对照：**两边均 28 项通过 / 81 项失败，失败集合相同，新增失败 0**。对照仅暂时恢复本轮四个生产源文件，finally 恢复修复字节，没有修改 Git 索引。证据 `dist/r202-audit/comparison.json` 与 `baseline-comparison.json`、`fixed-comparison.json`。
8. `node scripts/capture-r201-ui.cjs --run=audit`、R193、R195、R197 同命令：**均未完成验收**。Electron GPU 子进程反复退出（`-1073741515`），最终 `GPU process isn't usable`，主进程 exit `2147483651`，未生成场景结果；R197 只完成 3 项前置校验。仅在 ignored 临时 wrapper 中关闭硬件加速补试 R201，仍失败，没有改产品或正式 harness。见 `dist/r{201,193,195,197}-ui/audit/process.log`、R201 `audit-software/process.log`。
9. `git diff --check`：通过。

## 未解决及验证限制

- 不宣称全量或真实 Electron UI 通过。部分失败已定位为 CIM/WMI `拒绝访问`、CLI 执行程序不可读/未找到、系统临时目录祖先目录读取拒绝、Word 自动化登录会话不可用、共享依赖缓存不可写、Electron GPU 启动失败。9 个文件的 81 项失败已完成原 HEAD 对照；其余失败没有逐项证明原因，保留为待在正常权限环境复核的事项，未为追求绿色测试改动产品逻辑或跳过断言。
- 本次没有实机安装验证通知点击激活、设置中的通知身份及安装器更新行为；静态与可运行的相关单元测试之外，不推断其系统表现。
- realpath 检查与原子写入符合现有存储边界，但不声称可防御同一 OS 用户持续并发替换父目录的竞态；本次修复已确认的静态链接越界，没有扩展为跨平台文件句柄安全层重构。
- 测试隔离的附加观察：WMI 查询失败后，`processTreeSupervisor` 的临时进程树有 7 个空转 Node 子进程未收尾，导致全量测试输出汇总后管道仍等待。通过只读原生命令行查询，结合精确创建时间及 `zs-tree8-N9EkNT` 夹具路径确认归属，逐个复核进程代次后已清理；没有按进程名批量结束。证据 `dist/r202-audit/remaining-test-processes.json`、`test-process-cleanup.json`。这属于受限环境下测试失败时的清理可靠性问题，未纳入上述 4 个产品缺陷；本轮没有扩大改写旧进程树测试。

## 提交限制与最终工作区

`git add -- <本轮文件>` 被拒绝：`Unable to create 'D:/zhongshuo-public/.git/worktrees/r202-audit/index.lock': Permission denied`。该 worktree 的真实索引在允许写入目录之外，当前权限策略不允许提权；没有绕过限制写主仓库 Git 元数据。因此 **新增 commit 为 0**，所有修复均在工作树中，不能提供不存在的修复 hash。

分支仍为 `r202-audit`、HEAD `4538a42`。最近已有提交：`4538a42`（R201 交付记录）、`31a6f66`（R201 修复）、`0e9f48c`（R200 交付记录）。工作区不干净：4 个生产文件、1 个已有测试文件修改，新增 2 个行为测试和本报告，共 8 个本轮文件。测试留下的临时 profile 已移入 ignored `dist/r202-audit/fixture-leftover-r115`，没有遗留用户文件改动。

可审查补丁：`dist/r202-audit/r202-fixes.patch`（包括上述 8 个文件；不需要 Git 索引即可生成）。所有日志、对照报告、测试构建和补丁均在本 worktree 内；后续应在允许写该 worktree Git 索引的会话提交这些文件。
