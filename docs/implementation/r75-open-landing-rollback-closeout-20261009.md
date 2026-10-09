# R75 项目切换落位/取消收口（2026-10-09）

> 依据：`review-r74-project-open-and-rollback-next-round-20261009.md`（独立证据 `dist/desktop/review-r74-audit-20261009/`：open-from-room 两连败 + member-cancel-clean 回滚不完整）。
> 主交付：`desktop-daily-win-v13`（`bld_d4510629e370c260`，commit `6ddd41e`，dirty=false，593/593；r63 --src v13 ok realCalls=0；启动器发布协议复证普通打开路线 ok——见 §五）。
> 零新增真实模型调用；迁移 001–048 冻结；旧包/用户数据原地未动；UNKNOWN 合同未动；渲染/容量边界未动。

## 一、P1：从房间打开另一项目被旧路由抢回（review-r74 §P1）

### 根因（复核已述，本轮先复现）
`openProjectByPath(B)` 提交 activeProjectId=B 时 URL 仍是 A 房间——App 房间路由见 pid(A)≠active(B) 且 A 房间已被 B 的装载波整表替换 → ProjectAlign(A) 挂载 → ensureProjectActive(A) → **重新打开/聚焦 A**（复核 openCalls 里的第二个 A）；打开弹窗完成时又按 `getState().activeProjectId`（已被抢回的 A）选房间落位。从设置页发起无旧房间路由，故正常——与复核对照一致。

### 修复（落位所有权三件套）
1. **目标登记**：`openProjectByPath` 提交时登记 `openInFlightTarget={projectId, urlSeqAtStart}`（`currentNavSeq()`=router 内 URL 代次，每次 hashchange +1），收尾按代次清除；
2. **陈旧路由让位**：房间路由（App）与项目主页（ProjectHomePage 聚焦 effect）在「在途打开的目标≠本路由 pid 且 URL 自打开发起未再变」时让位（不挂对齐、不抢焦点）；用户其后主动导航（代次前进）或目标正是本 pid 则照常工作——合法深链不受影响；
3. **按目标落位**：`openProjectByPath` 返回 `{id}`（取消/被取代=空 id），打开弹窗按**本次目标 id** 选房间导航（不再读异步结束时的 activeProjectId）；`pickAndOpenFolder` 同口径。

### 验证（真实 UI，零延迟钩子）
门 G1 五场景（每场景独立实例+真实弹窗：侧栏「打开/切换项目」→ autoPick 经 **pickFolder 桥**（main.ts 工程钩子 `ZS_PICK_FOLDER_FILE` 按行序供目录——发布 bat 显式直通）→「打开这个目录」）：
- **A 房间→已注册 B（反例本体）**、B 线程→新目录 C（首开）、A 文件页→已注册 B、设置页→已注册 B（复核对照）、连开 B→C（最新意图）：五项 URL 均落目标房间、active=目标、输入区在、`zs.lastProjectPath`=目标目录、旧项目保留侧栏、零 toast。
- **先复现**：stash 修复后同场景 FAIL——URL/active 留在 A 房间、lastPath=B（复核的确切签名）；修复后绿。

## 二、P2：装载期取消的回滚完整性（review-r74 §P2）

### 修复（只撤销本操作拥有的值）
`openProjectByPath` 入口快照 `prevFocus/prevLastPath(=zs.lastProjectPath 前值)/prevProjections(rooms/members/memberRuntimes/dms)`；装载刷新波后取消 → 回滚焦点+**本地启动记忆**+**整表投影**（守卫：本次确已提交、焦点仍指向本次目标、无更新代次、非同项目重开——不覆盖用户其后主动选择，项目注册表不回滚=已注册项目不删除）。装载**失败**+意图已取消走同口径（安静收尾不弹旧错）。

### 衍生真缺陷：ProjectAlign 所有权双态（本轮实测发现，先证后修）
给回滚补齐投影后，冷房间直链出现 **project.open 无限循环**（探针 cmds.log 47,172 条：开 A→房间就绪→路由切 RoomPage→ProjectAlign 卸载→R73 的卸载即取消把装载波收尾判成取消→回滚清投影→路由又回对齐→再开…）。R74 的窄回滚（只还原焦点）掩盖了同一churn（正例实际多绕一圈自愈）。修复分两半：
- **在途保持挂载**：房间路由在「本项目的打开在途」（openInFlightTarget=pid）期间持续渲染对齐分支（ProjectAlign 及其意图存活），装载波收尾后自然切 RoomPage；
- **判据=URL 而非卸载**：ProjectAlign 清理时只在 **URL 已不指向本项目**（用户真跳走）时取消意图；成功交接（URL 未变）只释放。此前「RoomPage 抢挂→意图释放→波内无主→navigation.set(A) 照写」正是复核 §P2 的另一面。
- 循环消除实证：同一探针 31 条命令、6s 进房。

### 验证
- **集成 `hifiNavCancelRound74`（扩展）**：S3 补 `zs.lastProjectPath` 前后值（dirA→回滚回 dirB）、rooms/members/dms 投影归属（全 B）、A 仍在注册表；**S3b** 装载波中用户主动新开 G——不回滚覆盖（active/lastPath=G、A 保留）；**S3c** member.list 注入失败+取消——同口径回滚+安静收尾；S1 返回合同（成功={id:目标}）。
- **门 G2（真实转发层受控延迟，重启换钩子）**：基线经**真实弹窗**进 B（title/URL/lastPath=B）；①thread.get:3200 与 ②project.open:3200 取消——URL settings+active B+lastPath **dirB**+零 nav 写入；③装载波取消（saved.list:2500——B 基线装载不消耗该钩子的确定性窗）——active/lastPath 回 B、**侧栏 B 房间投影恢复**、A 保留、零 nav 写入（i4NavSets=0）；④重启——仍进入 B（最后用户意图）。

## 三、验证按真实用户路线（review §三逐项）
| 项 | 结果 |
| --- | --- |
| 从房间/线程/文件页/设置页开已注册 B + 首开 C | 门 G1 五场景全绿（真实弹窗+pickFolder 桥，无延迟钩子） |
| 快速 B→C，最新意图落位 | 门 G1 场景五 + 集成 S5（反序回执） |
| thread.get/project.open/装载三相位取消 | 门 G2①②③ + 集成 S2/S3/S3c |
| 取消后焦点/本地记忆/服务端偏好一致 | 门 G2 各相位断言 active=lastPath=prefs=B；重开程序仍进 B（G2④） |
| 冷启动/跨项目深链/冷房间直链 | 门 G3（crossThread/coldRoom/coldBoot/prefs 全对） |
| 看板/待办/收藏/搜索定位 | r72 门整体回归（十步矩阵）ok |
| R74 混合标签/恢复/阅读位置/草稿/拖动/放大/Esc | r74 门整体回归 ok（含 r73 三项与 R72 容量/Git/另存回归） |

## 四、验证总账
| 项 | 结果 |
| --- | --- |
| r75 门 `verify-daily-r75.cjs`（take `gate-r75-r75-gate-20261009104803`） | **ok:true errs:[]**，realCallRoots 3×0 |
| 集成 `hifiNavCancelRound74`（S1–S8+R75 扩展） | 1/1（含 S3b/S3c） |
| 全量 vitest | **922/922** |
| r73 / r74 门回归 | ok:true errs:[] 各（r74 前两次环境残留进程撞管道名假阴性——清杀后绿，如实登记） |
| r72 门回归（看板/待办/收藏/搜索矩阵+成果文件链） | ok:true errs:[]（**其 G1 超时暴露 R74 交付文件回归**——见 §二衍生②，修复后绿） |
| typecheck | main 0 / hifi 0 |
| v13 包 / r63 --src v13 / 启动器复证 | 593/593（bld_d4510629e370c260/6ddd41e/dirty=false）/ ok realCalls=0 / ok（A 房间真实弹窗开 B 全落位+再开 C+重启进 C+console 0+realCalls 0） |

## 五、交付形态（源码测试 / 独立 UI 演练 / 最终启动器 三分列）
- **源码测试**：集成 + 全量 922 + typecheck（上表）。
- **独立 UI 演练**：r75 门（冻结构建 dist/ui，自有数据根，真实弹窗链+受控延迟分列；realCalls 3×0）。
- **最终启动器**（`verify-r75-launcher.cjs`，v13 副本真实 start-desktop.bat）：A 房间→真实弹窗开已注册 B（URL/active/输入区/lastPath 落 B、A 保留、零 toast）→ 再开新目录 C（最新意图）→ 重启仍进 C → 文件页可达、console 0、realCalls=0。启动器 bat 对 `ZS_PICK_FOLDER(_FILE)` 显式工程直通（文档化，同 ZS_DEV25_DEBUG_PORT；用户默认不受影响）。

## 六、边界与如实登记
- 发布启动器无延迟钩子（bat 清洗 ZS_*，仅显式直通项）——装载期取消的强复现在源码门/集成（受控延迟），启动器复核普通打开路线与重启恢复。
- G2③ 的确定性窗用 saved.list:2500（B 基线装载不调用它；member.list 会被基线消耗——时序工具选择，非产品语义差异）。
- r74 门两次「no such table/directory」= 残留 electron 树占用户级管道名（daemonPipeNameFor 按 home 派生）——环境清理后同构建绿；非本轮代码缺陷，如实登记。
- 触屏/触摸板、<940px 分隔条细分、逐页像素对照（沿用）；15s 上传未复现维持悬置（诊断仪器常驻）；既有延期不动。

## 七、用户确认（一次，约 3 分钟）
双击 v13 的 `start-desktop.bat` → 在任一项目房间里点侧栏「打开/切换项目」→ 选另一个**已打开过**的目录 → 点「打开这个目录」：应直接进入那个项目的房间（不再弹回原房间）。顺手在新项目里发条消息或打开个文件确认可用。遇到什么反馈什么即可。
