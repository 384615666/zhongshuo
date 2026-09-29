# 第十轮报告：Git 只读协议重写 · 写操作闭环 · 验收开关与正式闭环（2026-09-29）

> 范围口径：全部本地/临时 Git fixture 与 fake 档验证，**零真实模型调用**（未跑 real*，旧批次剩余 3 次未动用）。
> 既定决定保持：价值评分暂缓；DEV-11 未过闸门不开放；有子进程 runtime 自动解除路径保守关闭；并行写入增强延期。
> 分组提交：`0e9842f`（只读协议）→ `12a1ea2`（写操作）→ `0abe89e`（验收开关与正式闭环）→ 本文档组。

## 一、Git 只读数据协议与边界（重写 `gitStatus.ts`）

**改动本质**：文件身份不再从面向显示的 diff 头正则猜测，全部改机器可解析输出；容量控制在采集阶段。

| 项 | 实现 | 验证 |
|---|---|---|
| 文件身份 | `git diff --raw -z`（`meta\0path\0[orig\0]`；重命名**先旧后新**——od 实测确认，porcelain status -z 才是先新后旧）+ `--numstat -z`（计数/二进制 `-`；重命名=计数后空路径+旧/新两条，实测） | 单元解析+集成（特殊名重命名 `renamedFrom` 归属正确）；残缺记录抛错不静默跳过 |
| 字面路径 | `GIT_LITERAL_PATHSPECS=1`——`b[a]r.txt` 只命中自身，glob 语义会带的 `bar.txt` 不进结果（控制组证明测试有效） | gitProtocol 用例 4 |
| 外部处理器 | 差异正文固定 `--no-textconv --no-ext-diff`；env 剥离 `GIT_EXTERNAL_DIFF*` | **标记程序反例**：控制组普通 `git diff` 确实执行 textconv/ext 驱动（marker 文件出现）；正式命令两文件查看后 marker 均不存在、正文为真实 unified diff |
| 容量 | 采集超限即 SIGKILL：单文件 64KB/整体 512KB/文件数 50（身份仍列出、正文省略计数）/status 256KB；截断带标记与完整查看指引 | 单文件截断（含标记）/文件数省略（55→50+5）/整体预算（第 9 个正文=''区别于单文件截断） |
| numstat 失败 | `stat: text|binary|unknown` 三分——失败≠文本成功；`numstatError` 带原因；正文仍真实 | 注入 runner 失败 → stat=unknown+正文含 diff |
| 未跟踪内容 | 按新增文件语义读工作区内容（NUL 嗅探二进制、64KB 限量、目录明确拒绝）；不再「只列文件名」 | 中文文件名/二进制/超限/目录拒绝 |
| 子目录项目 | 返回 `worktreeRoot`/`projectPrefixIsWorktreeRoot`；条目按项目范围标注 `outsideProjectRoot`，UI 显式说明——范围不悄悄扩大 | gitProtocol 用例 3+UI |
| 平台边界 | NTFS 禁 `"`/`*`/TAB 等文件名（实测 ENOENT）——fixture 覆盖 Windows 允许的全部特殊字符（中文/空格/`!#$&'()`/前导横线/子目录），注释注明协议侧 NUL 分隔本可往返 | 用例 1；前导横线还抓出 `git add --` 分隔符需求 |

## 二、Git 写操作闭环（新 `gitWrite.ts` + 迁移 016 `git_operations`）

**功能对照表（§14.6 v0.1 能力表 × 本轮状态，引用现行正文）**：

| §14.6 能力行 | 本轮状态 | 说明 |
|---|---|---|
| 工作区状态（含未跟踪，三组分开） | ✅（第八/九轮+本轮协议重写） | §14.2 归属分组的任务/用户/冲突三组视图经改动集数据面支持（stageTask 结果呈现归属）；状态页三分类 |
| 暂存与取消暂存（单文件+按任务/改动集批量） | ✅ 本轮 | `git.stage/unstage/stageTask`；批量跳过 userPreExisting（基线 porcelain -z `dirtyPaths`，第十轮起入 manifest）；旧捕获回退=before 前像 sha vs `HEAD` blob 逐文件核对，不可核对保守冲突 |
| 提交（冲突未解决禁止；不改 ChangeSet 状态） | ✅ 本轮 | 预览绑定 `expectedHead`+`expectedIndexDigest`；U*/AA/DD 阻止；application_status/review 不写（测试断言） |
| 提交历史与单提交 diff，关联 taskId/changeSetId | ✅ 历史+关联本轮；**单提交 diff 未做**（历史条目可跳文件与 Git 页 diff 组合查看，按提交聚合 diff 列项） | 关联仅来自操作日志——外部提交不虚构归属（RT-24⑩） |
| 分支列表/创建/切换 | ❌ 未做（精确列项） | 需 expectedHead 语义与「不自动 stash 告知」 |
| 远端 push/pull（AUTH_REQUIRED） | ❌ 未做（精确列项） | 仅临时本地 bare remote 验证（指令边界） |
| 冲突解决（三方+手动） | ❌ 未做（精确列项） | 本轮仅「冲突阻止提交」 |
| reflog/撤销提交（软回退） | ❌ 未做（精确列项） | `git.commit.undo` 待做 |
| 提交的任务关联（无独立验收队列） | ✅ 本轮 | 关联=日志注记，不生成 pendingReview；RT-24⑦⑧ 保持 |
| 历史改写禁令 | ✅ 维持 | 未实现也未放宽；仅 add/restore --staged/commit/log |
| 非 Git 目录不自动 init | ✅ 维持 | 如实拒绝 |

**关键机制**：
- **预览绑定**：预览→提交期间 HEAD 移动或暂存区变化（sha256 摘要）→ `STALE_REVISION` 拒绝并要求重新预览（「不提交用户没看到的内容」）；gitWrite 用例 6 两个失效场景+正常闭环。
- **既成事实核对**（指令三）：commit 信息附 `Zhongshuo-Command-Id: <commandId>` 尾标记；重试链=命令回执重放 → git_operations 日志重放 → **尾标记+父提交精确核对**恢复（git 提交已发生、回执/日志均未落库的崩溃窗口）→ 均无才执行。用例 7：删回执+日志后重试 `recovered:true`、HEAD 计数不变（不重复 commit）；仅日志幸存路径同样恢复。
- **保护约束**（指令六）：stage/unstage/commit 前核对 `workspace_leases` 活跃租约（目录身份+重叠判定）——执行保护中拒绝写操作，只读与预览不受影响（blockers 如实列出持有者）。
- **身份缺失**：repo/global `user.name/email` 均无 → 预览 blocker+提交拒绝；不代改用户配置（测试用 `GIT_CONFIG_GLOBAL/SYSTEM` 指空文件真实模拟）。
- **范围**：子目录项目的写操作只收项目前缀内路径（项目外拒绝并说明），读视图仍全工作树+标注。
- **崩溃恢复标记的透明性**：UI 历史可见尾标记行；提交面板帮助文案说明标记用途。

## 三、验收开关与正式闭环（RT-25/§10.5）

- `project.reviewPolicy.set`（§15.2）：CAS `expectedRevision`；领域事件 `project.reviewPolicyUpdated`；同值 `unchanged`；**只影响之后创建的用户任务**（message.submit 创建时经 `reviewPolicyOf` 快照），已有任务不批量改写（测试：开关前后两任务策略各自保持）。
- 持久化：文件库重开后开关保持、新任务仍按开启策略快照（projectSettings 4/4）。
- 「要求修改」必填意见（§10.5-4）：服务端拒绝空意见；意见入 `review_note` 并经 `latestReviewFeedback` 注入返工输入（第九轮已验注入，本轮补 UI 入口：返工意见行+**「追加执行」按钮**=task.redispatch 正式派发链——此前 UI 无再执行入口）。
- **e2e 正式闭环（不经补库，全程 UI+正式命令）**：项目设置开→重载保持→发送任务→fake 交付→REVIEW（第 1 版）→返工（意见记录）→追加执行→**第 2 版**（v1 保留 changes_requested+意见）→验收通过→DONE；DB 事实断言交付账本与任务终态。
- **顺带修复的产品缺陷**：交付守卫原为「存在任何其他 run 的交付→不交付」，返工第二轮（新 run）被旧 run 的 v1 挡住——SUCCEEDED 但无 v2、任务卡 ACTIVE。改为按 run 创建先后（rowid）判定：旧 run 迟到输出仍不覆盖新交付（lateOutcomePath 全绿），返工新 run 正常递增 revision（§10.5-5）。
- 设置页纪律：写入并发策略如实显示「单写者（并行已延期）」不可点；无占位假开关。

## 四、恢复缺口：不循环修快照，出决策记录

`adr-managed-process-lifecycle.md`（ADR-0010）：候选=Job Object（首选，内核归属、无盲区、回退=挂 job 失败即拒绝派发）/ETW（增强候选）/受管启动器（评估不成立——CLI 自派生进程不在包裹内）；验收六条（归属/解除/终止兜底/回退/矩阵分列/零真实调用）；承载=**DEV-05 子项 REC-LIFE-1**，不阻塞本轮、不重写快照释放规则、不需用户重新拍板方向。

## 五、数字与验证

- 集成/单元：**524/524**（新增 gitProtocol 9 + gitWrite 9 + projectSettings 4；lateOutcomePath fixture 补真实 run 行）。
- e2e：**29 passed + 3 skipped**（新增 Git 写操作闭环、正式验收闭环两条真实点击链）。
- lint 0、tsc 0、`npm run build:ui` 通过。零真实模型调用；跨进程预算护栏未受影响未重跑（指令五豁免）。
- 既有口径维持：真实 CLI lateEvents unsupported；写档未认证入口关闭；并行写入延期；价值评分暂缓。

## 六、剩余项（精确列项，不以「Git 已接入」概括 RT-24）

Git 读侧剩余：单提交聚合 diff 视图（按 commit 而非工作区聚合）。
Git 写侧剩余（按 §14.6/§15.2 顺序）：git.branch.create/checkout（不自动 stash+带入改动数告知）；git.push/pull（AUTH_REQUIRED、临时 bare remote 验证、推送风险告知）；git.conflict.resolve（三方内容+手动编辑，不整文件一键覆盖）；git.commit.undo（reflog 软回退）；历史深分页优化。
设置剩余：项目设置页其余项（协作限制/文件修改策略——依赖后端命令面）；应用设置按任务书逐项推进。
恢复：REC-LIFE-1（ADR-0010）待排期。
