# R74 两个交叉场景修复与日常使用收口（2026-10-09）

> 依据：`review-r73-cross-context-and-inner-cancel-next-round-20261009.md`（独立复核证据 `dist/desktop/review-r73-audit-20261009/review-summary.json`：open-cancel 与 mixed-tabs 各复现 2 次）。
> 主交付：`desktop-daily-win-v12`（`bld_49bb7307dfac1435`，commit `1dbf27b`，dirty=false，593/593；r63 --src v12 ok realCalls=0；启动器发布协议复证两交叉场景+基本布局 ok）。
> 零新增真实模型调用（r74 门 realCallRoots 5×0、启动器 realCalls=0、r63 包检 realCalls=0）；迁移 001–048 冻结；旧包/用户数据/配置/凭据/CA/草稿/未知账本原地未动；UNKNOWN 人工同号确认合同未改；容量/渲染选型未动。

## 一、P1：取消凭据贯穿项目打开内部（review-r73 §P1）

### 根因（复核已由源码确认，本轮先复现再修）
`openProjectByPath(path, {fromIntent?})` 只收布尔（"不取消自己"），没有具体 NavIntent。`await project.open` 后只查 loadGen——用户跳到设置页（navigate）不产生新 open 请求、loadGen 不变，旧调用照常提交 activeProjectId/可见集合/`zs.lastProjectPath`/persistNav（=复核抓到的「取消后 navigation.set(A)」）。

### 修复
`loader.ts` `openProjectByPath(path, opts?: { fromIntent?: boolean; intent?: NavIntent })`：
- **project.open 回执后**、焦点/可见集合提交、本地导航记忆（zs.lastProjectPath）之前核 `navIntentActive(intent)`——已取消→零提交（不切项目/不写记忆/不写偏好/不弹错/安静返回），`recordWrite('project.open.cancelled')` 留观测痕迹；
- **装载刷新波（loadProjectRegistry/refreshMembers/refreshRooms/refreshDms/refreshSavedMessageRefs）之后**、persistNav 之前再核——已取消→跳过偏好写入，并把**已提交的焦点还原到打开前项目**（仅当焦点仍指向本次结果且无更新代次——不覆盖用户随后主动切走的项目；房间缓存是事实，还原后可用）；
- `ensureProjectActive` 的 openProjectByPath 调用传入具体 intent（focusProject 分支本就同步、检查后原子）。

### 验证（分列：每个等待阶段 + 反序 + 正例）
**集成测试 `tests/integration/hifiNavCancelRound74.test.ts`**（打包真实 hifi loader/store/navIntent 同 bundle=同一意图登记簿 × 正式 daemon 内存库 × 转发层受控保持——内容不 mock 只控时序）：
- S2 **project.open 等待期取消**（复核反例本体）：activeProjectId 保持 B、`zs.lastProjectPath` 不写、**取消后零 navigation.set 信封**、无 toast、安静 resolve、writeLog 有 `project.open.cancelled`；
- S3 **成员装载等待期取消**：焦点已提交 A 后取消→不写偏好+**焦点还原 B**；
- S4 **thread.get 等待期取消**：locateThread 安静停 `{projectId:'',roomId:''}`、未进入对齐链（零 project.open）；
- S5 **反序回执**：C 在途→用户点 D→C 回执晚到只落实 D（D 偏好落位、C 零偏好）；
- S6 **合同保持**：启动恢复型 `{fromIntent:true}`（无具体意图）不被无关活跃意图拦；用户级打开仍取消在途意图（R73 合同不回退）；
- S1/S8 正例：用户级/定位链打开正常提交焦点+记忆+偏好。
- **先复现**：stash 修复后该测试 FAIL 于 S2（activeProjectId 被切成 A——与复核一致）。

**浏览器门 G2（真实转发路径受控延迟——main.ts 既有工程观测钩子 `ZS_UI_DELAY_METHOD_MS`，复核 3.2s 同型）**：
- ① 重启注入 `project.open:3200`（重启后首个 project.open=定位链的 A 打开）：取消后 URL=settings、active 保持 B、`navigation.get`（desktop-hifi）≠A、零旧错误；
- ② 重启注入 `member.list:2500`（首个 member.list=装载刷新波，确定性 2.5s 窗口）：轮询捕获焦点翻转→跳设置→**active 还原 B**、偏好不变；
- ③ 反序两条房间直链（140ms 间隔）→只落实 C（active/prefs=C）；
- ④ 未取消正例：同一 A 房间直链正常落位（composer+active=A）。
- **先复现**：unfixed 构建上 ①② 均 FAIL（active=A + prefs=A——复核的确切签名「URL settings + 标题切 A + 取消后 navigation.set(A)」）。

## 二、P2：混合标签自动收起失效（review-r73 §P2）

### 根因
`Room.tsx` 用 `visible.every(t.openedFrom.target.kind==='files')` 才收起——任一历史房间/线程标签（保留的 room-file.md）让条件失效，文件页预览继续占房（复核 mixedAfter：两标签可见、previewVisible=true、无重开按钮）。

### 修复（判据=**当前活动预览的来源**，不要求历史全部一致）
- `actions-preview.ts` 新增 `shouldAutoHidePreviewFor(target)`：hidden/tabs 空早退；`explicitShow===true`（房间/线程/私信内主动打开、显式重开）恒不收起；本上下文无可见标签（跨项目/私信隔离）不动全局状态；否则取**活动标签**（activeKey，缺省首个可见）判 `openedFrom.target.kind==='files'`；
- Room/线程共用该判据；**DmPage 同判据新增**（工作区资源 audience=project 在 DM 上下文同样放行——侧栏点私信是同一占用问题），并在 DM 头部加 `PreviewReopenButton`（hidden 时 PreviewPane 不挂载——自动收起不能是单向门）；
- 不清空旧标签、不全局 navigate 关闭、显式恢复正常尊重、迟到读取不回弹（effect 依赖含 s.resources 沿用）。

### 验证（门 G1 矩阵，真实侧栏点击）
- ① room+files：房间开 room-file.md 留标签→文件页开 layout-file.md→侧栏房间=**收起**（composer/池正常、草稿保留、重开按钮在）；显式恢复=**两标签俱在**（active=layout-file、内容/阅读位置/草稿保留）；
- ② thread+files：线程来源标签+文件页来源→回线程（卡片路径）收起；恢复 4 标签（含 thread-file.md）；
- ③ 显式恢复→再去文件页**开新文件**→回房间再收起（显式不是永久豁免）；③b 显式恢复后仅访问文件页**不开新文件**→回房间不收起（不过度收起）；
- ④ 跨项目：再武装后进 X 项目房间=收起+X 房间正常+可恢复；
- ⑤ 在途读取：房间标签在场+文件页点 22.5MB PPT 装载中侧栏回房→9s 窗后不回弹；
- ⑥ DM：文件页活动预览→侧栏「私信」=收起（DM 列表/输入框正常）+DM 头部重开+恢复；
- 阅读位置用**原生滚轮**（合成 scroll 事件不触发 React onScroll）：240→收起→恢复 240。
- **先复现**：unfixed 构建上 G1 FAIL 于 ①③⑤⑥（mixedRoom previewVisible=true 无重开按钮等）+截图视觉判读确认（两标签预览占房）。

### 衍生真缺陷：阅读位置恢复（复核矩阵明示「恢复后的阅读位置」）
原恢复 effect 挂载即赋 `scrollTop`——工作区/附件正文**异步装载前 scrollHeight 尚小**，赋值被钳到 0（r73 门实测 reopen scrollTop=0，当时未设断言）。且钳制赋值会触发 scroll 事件→rememberScroll 防抖把**钳制值写回标签**=丢位置。修复：逐帧重试到**目标可达**才赋值（≤90 帧≈1.5s），用户滚轮/按下即停；门实测 240→恢复 240（早/晚双读）。

## 三、上传重传口径（review §三）
- `uploadWithRetry` 仅测试脚本内（未动产品）；本轮改 **uploadDiagnosed**：每次失败先记录（耗时/芯片错误原文 title/artifacts 同名行=saved-behind/分类：`__TRANSPORT__`=传输、`服务未在时限内回执`=未知窗、`CODE:` 前缀=明确拒绝），再移除失败芯片重传（≤3）；每次结果全量入 result.json。
- **本轮事实**：3 次门内 XLSX 上传（9.8MB/69793 行）全部**首次通过**（4.7s/5.1s/4.8s）——15s 失败未复现。诚实结论：未复现即不能归类，r73「环境 CPU 抖动」说法**维持未证实**；分类仪器已在门内常驻，再复现即有原文+落库事实；UNKNOWN 人工同号确认合同未动、未引入任何产品自动重发。

## 四、验证总账
| 项 | 结果 |
| --- | --- |
| r74 门 `verify-daily-r74.cjs`（take `gate-r74-r74-gate-20261009061151`） | **ok:true errs:[]**，realCallRoots 5×0（G1 矩阵/G2 四相/G3 诊断/G4 walk/G5 回归） |
| G4 PPT 逐页 render-ready | 82/82 ready 0 失败（walk 4.8s；一次 p82 图片解码滞后 flake→门加 8s 有界解码等待后绿，如实登记） |
| G5 R72 必要回归 | 树开 82 页/页码 40 保持/另存 sha 一致/XLSX 69913+底部滚动/Git 中性→仓库 |
| 集成测试 | `hifiNavCancelRound74` 1/1（unfixed FAIL→fixed 绿） |
| 全量 | **922/922**（921+新增 1） |
| r73 门回归（thread.get 相取消+基本三项+R72 全量） | **ok:true errs:[]**（realCallRoots 6×0） |
| typecheck | main 0 / hifi 0 |
| v12 包 | 593/593，bld_49bb7307dfac1435 / 1dbf27b / dirty=false |
| r63 --src v12 | ok:true，realCalls=0 |
| 启动器发布协议复证（`verify-r74-launcher.cjs`，最终副本真实 start-desktop.bat） | **ok:true errs:[]**：混合收起+恢复 2 标签（active=布局文件）+草稿；拖动 608→460；放大铺满+Esc 回 460；双 hash 取消=URL settings+active 项目B+**prefs=B 的 id（与包库 projects 表核对）**+零旧错误；未取消正例=A 落位；console 0；realCalls=0 |

### 启动器形态说明（如实）
`start-desktop.bat` 清洗父环境 ZS_*（仅 ZS_DEV25_DEBUG_PORT 透传——包自治设计），受控延迟钩子无法注入发布形态。最终副本的取消复证改用**同刻双 hash**（取消先于任何异步回执到达——时序确定性）；3.2s 延迟反例的强复现留在源码门（同一 main.ts 观测钩子，工程环境变量门控、产品默认不激活）。

## 五、边界与未覆盖（如实）
- 15s 上传失败未复现——归类悬置（仪器常驻，见 §三）；不据此改产品。
- 触屏/触摸板拖动、<940px 分隔条细分、逐页像素级对照（沿用 R72/R73 登记）。
- 本轮观察（非缺陷登记）：侧栏房间只列**最后聚焦项目**（refreshRooms 为替换语义）——跨项目回房经项目页路由完成（门 ④/⑤ 同路径）；未在本轮改动范围。
- 浏览器门取消相位依赖 main.ts 既有观测钩子（env 门控）；发布形态用无钩子双 hash 变体+集成测试受控保持补强。
- 既有延期（Android/签名/价值评价/DEV-11/并行写入/G5）不动。

## 六、用户确认（一次，约 5 分钟）
双击 v12 的 `start-desktop.bat`→房间里打开一个文件留着→去文件页打开另一个文件→点侧栏房间（应自动收起；房间头部「文件预览」可恢复，两个标签都在、阅读位置和草稿保留）→拖动分隔条→放大/Esc 还原。遇到什么反馈什么即可。
