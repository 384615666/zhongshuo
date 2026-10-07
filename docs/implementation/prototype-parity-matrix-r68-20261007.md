# R68 真实旧版继承与保全收口矩阵（2026-10-07）

对象：`desktop-daily-win-v6`（BUILD `bld_99dadb937ca3bc87`，commit `9c11154`，dirty=false，清单 591/591，verify-desktop-daily 绿）。
输入：`review-r67-legacy-inheritance-next-round-20261006.md` + 独立证据 `dist/desktop/review-r67-audit-20261006/`。
验证产物：交互门 `dist/desktop/gate-r68-*/result.json`（ok:true，G1–G6 全绿，real_calls=0）；视觉门 `dist/desktop/visual-gate-r68/`（11 场景，vision 复核含 s11 Select 展开态/s2 同名短标识/表格修复后 s4）；升级门 `verify-upgrade-r67` ok:true（47→48+负对照 4/4）；全量 912/912+双类型门 0 错；`r68Contracts.test.ts` 7/7。

## A. 独立反例逐项收口（review-r67 §2–§6）

| 反例 | 修复 | 证据 |
| --- | --- | --- |
| §2 首次从 v3/v4 升级丢草稿/未知账本（同目录 v1 键被跳过；旧根无标记不能证同根） | 继承重做：**继承标记 `zs.hifi.inherit.<ns>` 与 v2 键存在解耦**（先写空新键不再永久跳过）；通道① 同目录 v1 键（目录=同一物理根，构造性可信）自动继承；通道② 内嵌 dataRootId 自证；通道③ 旧目录标记核对；通道④ 旧根无标记（真实 v3/v4 形态）→ 登记**持久化导入候选**（设置→数据与存储 可见/重扫/逐键确认导入，含 hasStateDb 核对信息；不盲扫、无关根不混入） | G2 端到端：**冻结 v4 包真启动链生成真 v1 状态**（无 marker、无内嵌 id）→ 整根复制 → 当前候选首启候选可见 → 确认导入 → 横幅+原 commandId+草稿恢复 → 同号重试 delta=0；**原根同目录升级自动继承**；**冻结 v3 包同款真链→同目录首启恢复（草稿+信封）**；新格式整根移动自动继承（R67 通道回归） |
| §3A 未来版本快照被继承路径接受（v999 恢复且无提示无隔离） | `mergeInheritedSnapshots` 版本门与直接初始化**同判**（`data.v!==PERSIST_VERSION` 整体拒收：不恢复、不重发其未知信封、原件在旧键逐字保持、恢复说明列出拒收原因）；全部继承入口（自动/用户导入）统一走此函数 | G2 e1：内嵌当前 id 的 v999 键注入后重载——正文不出现、横幅不出现、原件保持 v999；合同测试坏键/坏 JSON 标记保全 |
| §3B 结构不合法的身份标记被随机新 ID 覆写 | `app.identity`：标记存在但 id 字段不合法/JSON 损坏 → **不覆写、不换 ID**，返回 `rootIdentityHealth=invalid-marker`+问题说明；renderer 退回绝对路径键并在设置页给出修复指引；仅标记确实缺失才创建（temp+rename 原子落盘） | G2 e2：坏标记首启 health=invalid-marker、原件逐字保持、无新 dri、设置页健康说明可见；合同测试三态（缺失创建/坏字段/坏 JSON） |
| §4 重试门按 title 找按钮没点击仍通过；未证明第二次命令真发出 | 门重写：按**按钮正文**定位（R67 反例：title≠正文）；`ZS_COMMAND_LOG_FILE` 记录**实际送达管道的完整信封**——证明第二次命令确实发出且 commandId+params 逐字一致；负对照（未点击时「已发出」判定必须为假）实际执行 | G1：btnFound/retry1Sent/paramsEqual 全真；重试#1 也丢（ZS_H1_LOSE_SUBMIT_TIMES）仍无重复；成功后**本条**账本清理+横幅消失；两封不同命令未知并存（重载后均保留）；等待期新正文保留；服务端恰一次 |
| §5A 归档项目仍能正式创建成员（1→2） | 服务端守卫：archived/removed 拒绝+空白名拒绝；**replayGuard**（旧回执重放受当前状态约束）；UI 归档/移除禁用+说明 | G3：归档后 UI 禁用注记+服务端拒绝（含同 commandId 重放）；恢复后再允许（合同测试全分支） |
| §5B 弹窗用实时 activeProjectId（切项目旧输入写进 B） | AddMemberModal **捕获打开时 projectId**：存续期项目切换→表单作废（可见作废说明+提交禁用）；迟到回执只刷新提交目标项目 | G3：标题栏真实切项目路径下 stale 面板出现、甲成员数不变（零误写） |
| §6 AI 成果第三来源 UI 未覆盖 | `delivery.document` 正式命令（自然链持久化的 turn 最终输出按 manifest hash 核对，进度消息不冒充）；Room 成果页+ThreadPage「打开文档」→ 共享预览：阅读（TaskComplete 字段结构：结论/文件/验证/遗留）/源码（原始 JSON）/另存（字节=文档 UTF-8，对账）/引用（版本+manifest 绑定文字引用——交付非会话附件不伪造附件合同）；hash 不一致如实标注（manifest 为验收身份） | G4：FakeWorker 自然交付→打开文档→阅读视图→源码 task-complete JSON→另存 hash==文档→引用草稿含 manifest；合同测试（含进度消息先于最终输出取 hash 一致候选） |
| §6 工作区重载链「核一致性」 | `project.file.stat` 轻量脏检测（路径安全链同源）；WorktreeBody 8s 轮询→磁盘已更新提示（幂等）→保存拦截→用户重载→新快照保存；**修复重载后 pendingRevision 被重复追加导致保存永远被拦**（旧 worktreeReadBump 在切换后再标记）；读取代次修正为最新追加版本（快照键错位） | G5：外部改文件→「磁盘已更新」提示→保存被拦（零落盘）→重新加载→新内容显示→另存字节含新尾部；空文件（0B）另存落盘 0 字节 |
| §6 共享 Select 仍是原生包装（展开态无法验收） | **自绘 listbox**（.select-wrap 按钮+.select-pop role=listbox；键盘 ↑↓/Enter/Esc/Home/End；aria-activedescendant；点击外部关闭）；全软件原生 `select[data-zs-select]` 清零 | G6：展开态可截图（s11 视觉场景+vision PASS：选项/高亮/对勾）；键盘序列实际改值；G3/G4 各页 Select 真实点击（弹层选项） |
| §6 视觉 manifest 残留 R66 过期说明 | manifest 重写：s2「无添加成员按钮」→ 已有入口+同名 #短标识；s3「无 visible 检索」→ 三档；s8/s9 空态说明 → 非空密度事实；s11 Select 展开态按**正式侧独立能力验**分列（原型为原生 select 无同格式通道——不自行制造 approvedDiffs） | 视觉门 11 场景 + vision 复核（s2 同名 #61a7/#5601 可分辨、s11 展开列表完整、s4 表格修复后重拍） |

## B. 衍生真缺陷（本轮额外发现并修复）

| 缺陷 | 修复 |
| --- | --- |
| **preview.css 漏出包**：build-ui 样式清单未含 preview.css——正式构建全量缺失预览样式（MD 表格无边框/无表头底色；此前面轮只断言 .md-h1 存在未发现） | 清单补入；独立复现（.md-table 规则零加载、th 边框 0px）→ 修复后 th 边框/底色/字重与设计一致；视觉门 s4 重拍+vision 复核 |
| 继承候选只存内存：首轮登记后页面重载/进程重启→候选空表且标记 done→**永久跳过导入**（正是复核「空新键成为迁移完成证据」的变体） | 继承标记持久化候选队列（boot 时回灌设置页）；导入/重扫写回标记（importedAt 保留——不复活已处理项） |
| 重载+偏好恢复后 DM/房间投影无人装载（switchFocusProject「已激活」早退）：直链 #/dm/<id> 停在「还没有私聊」回退、房间面板「找不到房间」 | DmPage 挂载/项目就绪即 refreshDms；ProjectHome 挂载即 refreshRooms+refreshMembers |
| v3/v4 时代同样存在上述直链空态（冻结旧包实证） | 属旧包已知边界（升级到 v6 即得修复）；README 情况 A 说明 |
| fake adapter 结构化终态与真实合同不一致（最终输出不是末条消息——交付文档 hash 核对无法成立） | turn.completed 前置 message.completed 携同一 TaskComplete 文本（真实 CLI final-result 同构）；全量测试同步更新（每轮=回复+最终消息） |

## C. 验证口径说明（如实）

- 冻结旧候选演练**未给旧夹具预置任何标记**：v4/v3 包以真启动链（直启 electron.exe+探针注入 ZS_* 环境）在其自有根上产生真 v1 状态（独立复核 v1State：v=1、无 marker、无内嵌 id）。
- 强杀进程会丢 Chromium localStorage（LevelDB）缓冲写——**实证**（未知信封后的新草稿在 taskkill 下丢失）→ 门内改用 Browser.close 优雅关窗链；这也是用户正常关窗（优雅）与异常断电的差异边界。
- 原生另存对话框的取消/权限路径未在门内制造（自动直写钩子覆盖落盘字节）；Select 展开态的原型对照不存在（原生 select 展开为系统渲染）——均如实分列，不代记通过。
- 未覆盖/延期不变：HTML 交互网页（脚本仍禁用）、R64 遗留 project.open 响应 rootPath/canonicalPath、多远端 upstream 复核。
