# R158：项目归档、私信头像/状态与项目切换

用户反馈：项目无法归档，私信列表头像与消息头像不一致，当前私信仍显示「打开私信」，普通回复完成后仍有横幅，以及在私信/成员管理页点击项目名不能切到对应项目。

## 改动

- `project.lifecycle` 不再仅用任务的非终态状态判定归档/移除：已停止且没有后续排队请求的失败尝试可以保留归档。失败任务的 ACTIVE/BLOCKED、运行与错误历史均不改写。无运行的 ACTIVE 私信仍算排队；OPEN、等待用户/验收、在途运行/轮次、未释放 UNKNOWN、保留保护、pending/leased outbox、两类普通回复队列继续阻止归档。已释放的历史 UNKNOWN 不会阻止已完成项目永久归档。
- `conversation.list` 原已返回 `peerMemberId`，loader 却丢弃并填空 `memberIds`。现在保留身份，列表直接按此身份取头像，即使成员列表尚未装载也能取到同一张图片，不按显示名猜测。
- 私信向共享执行状态组件传入当前 conversationId：移除指向自身的「打开私信」，普通 COMPLETED 隐藏；待验收及其他处理状态保留，任务记录详情中的完成事实继续显示。
- 项目名称负责切换，小箭头负责展开/收起房间，两者不互相触发。在私信/成员管理中切换项目保留页面类型，顶部项目菜单使用同一入口。点击当前项目不会重置已选私信。切换期间私信按当前项目过滤，旧项目的迟到响应沿用装载代次隔离。房间展开偏好保持。
- 归档说明及操作手册同步。

## 验证

- 定向 7 文件 **69 项通过**：`stopArchiveR126`、`dmDirect`、`archiveActivityR85`、`r90SidebarRooms`、`executionStatusR108`、`r99ExecutionStatus`、`dmInterruptedNoRunR106`。
- `node scripts/verify-dm-project-r158.cjs`：**10/10**。真实 App/loader/组件、模拟命令响应、隔离 Electron profile、Chromium 原生鼠标点击；检查头像、运行/完成/验收显示、项目与箭头分工、成员页项目切换、900px 宽度及零渲染错误。0 模型调用，不打开用户数据库。
- 最终 UI 证据：`dist/r158-dm-project/1793602400250/result.json` 及 `01-running-dm.png`、`02-completed-dm.png`、`03-member-project-switch.png`、`04-dm-narrow.png`。早期脚本点击了错误的 nth-of-type 目标而失败，失败证据留存；最终改为按项目按钮集合的明确索引执行原生点击。截图脚手架补齐标题栏高度，避免遮住底部输入框。
- hifi TypeScript 通过。跟踪主工程 TypeScript 诊断 **0**；默认根类型检查仍有本机既有未跟踪 R130 夹具 **13 条**错误，未修改这些文件。
- 改动文件 ESLint 对 HEAD **新增 0**（原 commands/App 的 12 条问题保留），新 UI 验证脚本无 lint 问题。`dist/r158-eslint-delta.json`。
- `node scripts/package-user-guide.mjs`、`node scripts/build-ui.mjs`、`git diff --check` 通过。
- 已跟踪源码完整回归 **348 文件（346 通过、2 跳过），3125 通过 / 3 预期失败 / 16 跳过，0 非预期失败**，367.57 秒，退出码 0。正常配置继续排除真实远端 GitHub 测试；没有纳入本机未跟踪 R130/R131 夹具。日志：`dist/r158-tracked-tests.log`。

## 现场边界

本轮对安装版常用数据根只做只读查询。任务表查询返回 `SQLITE_CORRUPT`，工作流状态聚合可读；数据位置指针仍指向该默认根。对现有后台的只读连接在凭据握手阶段被拒，没有发送业务命令或尝试绕过。因此没有确认截图中那一个项目的具体任务身份，也不能把隔离库验证视为原库已修复。没有运行修复、导入/迁移、归档用户项目或重放任务。本轮修复的是源码中的归档判定与界面行为。

源码与界面构建完成；未改版本号、未制作/安装新 EXE、未提交或推送。原未跟踪文件保留。依赖目录为本机既有链接，当前 pnpm 会因 `ERR_PNPM_UNSAFE_MODULES_DIR` 拒绝自动检查/安装，故验证直接调用已安装的 Node 工具入口，没有改动依赖目录。

## beta.11 构建与安装准备

用户随后明确授权「推送打包安装给我测试」。版本更新为 0.1.3-beta.11 / Windows 0.1.3.11，按当前源码冻结构建；沿用数据结构 61。已通过的产品完整回归不重复运行，追加版本与安装包验证。构建与实际安装均已完成，结果如下。


## beta.11 实际交付

- 源码提交 `5f9c28531ca9a25e0a68431db908672b8112f27f` 已推送公开 `main`。从独立干净 worktree `dist/r158-source` 构建，未纳入既有未跟踪夹具。
- 安装器 `dist/installers/Zhongshuo-Setup-0.1.3-beta.11-x64.exe`：160,100,067 字节，SHA256 `b50d373614e2489f3c1174863aaf3b840943b6f109c8e45bc7fc1a10f98c4139`，附 `.sha256` 与 `.release.json`。
- 安装镜像 BUILD `bld_1959944f73bcdd45` / dirty=false / 665 文件逐项 hash 一致；随包 EXE 的产品、文件说明与原始文件名为众说 / 众说 / Zhongshuo.exe，版本为 0.1.3-beta.11。
- 追加版本测试 3/3，包内隔离验证 20/20：保留上一版设置/通知/外链/停机验证，新增正式私信接口返回对端身份、包内列表正确渲染保存的成员头像；仅记录消息，0 模型调用。证据 `dist/r158-delivery/package-qa-063b92ad/result.json`。
- 本机旧版无活动轮次，经正式 `daemon.shutdown` + 窗口关闭正常退出；`desktop-shutdown.json` 确认 complete=true、exitCode=0、forceKilled=false。托盘退出的手动操作提示后来已撤回为无需操作，没有等待用户再次授权，也未强杀用户程序。
- 退出后完整本地备份 4455 文件、255,577,055 字节，逐文件 hash 核对通过。备份及所有运行数据仅留 ignored 的 `dist/r158-delivery/`，不提交、不进入安装包。备份数据库 integrity_check=ok、schema=61。
- 当前用户安装器正常退出 0，覆盖原程序目录；安装后 665 文件 hash 全部与镜像一致，注册表 DisplayVersion=0.1.3-beta.11。启动新版前数据库原件字节 hash 与备份时一致，安装未改写数据库。
- 新版已从正常安装入口打开；后台健康、仍使用原数据根、schema=61，数据库 integrity_check=ok。聊天、项目、房间、任务、运行、轮次和调用行数与备份一致，0 新增真实调用。原生界面打开私信、点击项目名后仍停留私信页。
- 前一轮运行期间观察到的 SQLITE_CORRUPT，在本次正常关闭后的备份及新版运行库中均未复现。没有执行数据库修复、导入、迁移或改写任务状态；不推测旧异常的根因。没有代替用户归档实际项目。
- 本机证据：`dist/r158-delivery/payload-verification.json`、`pre-upgrade-backup.json`、`installation-result.json`、`installed-startup-result.json`、`install.log`。此次只推送源码与交付文档，未创建 GitHub Release。
