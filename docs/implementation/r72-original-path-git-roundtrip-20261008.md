# R72 原始使用路径修复与桌面日常收口（2026-10-08）

> 对应复核：`review-r71-original-path-and-git-state-next-round-20261008.md`（P1 文件树容量遗漏 / P2 Git 状态往返 / 验证口径纠正三项）。
> 交付：`desktop-daily-win-v10`（见 §7）。旧包/用户数据/凭据/草稿/未知账本原地未动；迁移 001–048 冻结；零新增真实模型调用。

## 1. P1：文件树 Office 容量遗漏（用户原始路径）

**根因**：`commands.ts` 的 `PREVIEW_BINARY_EXTENSIONS`（`project.file.readFull` / `project.file.originalFile` 共用的 `resolveProjectPreviewFile` 白名单+按类上限）中 `.docx/.xlsx/.pptx` 仍硬编码 20MiB——R71 只把 `OFFICE_MAX_BYTES`（上传/视觉字节）调到 32MiB，两个入口容量源没统一。

**修复**（`src/daemon/commands.ts`）：上限改为**从共享合同取值**——`.docx/.xlsx/.pptx` = `OFFICE_MAX_BYTES`（32MiB）、`.pdf` = `PDF_MAX_BYTES`（20MiB）、图片保持 8MiB 各自通道；不再散落副本。ZIP 护栏（条目 128MiB/总量 160MiB）、解析子进程内存（768MB V8 + 896MiB Job Object）、120s office 截止全部保留不动。

**验证**：
- 命令层合同（`r67Contracts.test.ts` 新增「R72」用例，永久回归）：21MiB 合成 .pptx 走 readFull（bytes/sha256/binaryKind）+ originalFile（另存原字节）双通道通过；33MiB+512B 负例仍拒（人话消息）；**21MiB PDF 仍按 PDF 自己的 20MiB 拒**（Office 扩容不带 PDF 上车——分道）。
- **用户原始路径**（verify-daily-r72 G1，20–32MiB 区间真件正例）：打开普通项目 → 文件树点击真实 22.54MiB 内蒙古 PPT → 82 页渲染（树路径首视 ~5.3s）→ 图文页 p40 图片解码 → 末页 → 切标签回位 82 → **另存 sha256 与原文件一致**。
- 同真件分列：**上传件**通道（草稿上传→预览 82 页）与**成果文件**通道（fake 交付落盘同字节→成果报告「打开文件」→82 页）各自通过；交付落盘 sha256 一致。
- 负例（G7）：文件树 33.5MiB 合成件 → 就地「超只读上限 32MiB」人话错误、不渲染（旧 20MiB 下同样失败的件只证上限仍在——正例区间由 21MiB 合同用例+22.54MiB 真件承担）。

## 2. P2：Git 状态往返（notARepo 残留）

**根因**（`src/ui/hifi/data/actions-git.ts`）：`refreshGitState` 成功路径 `next={...cur,...}` 继承旧 `notARepo:true`（folder 变 Git 仓库后「Git 仓库｜main」与「此文件夹未初始化 Git」并存）；非 Git 路径不清旧分支/状态投影；真实错误路径不清旧中性标记、旧 `lastOp`（读失败）在成功后残留。

**修复**（按「本次回执是权威」）：
- 成功：`notARepo: undefined` + 仅当旧 `lastOp` 是 `git.status` 读失败时清（其他操作如暂存/提交的 lastOp 属各自事实，不被 status 刷新抹掉）。
- 非 Git：重置为 `emptyGit()` 投影（旧分支/状态/远端/历史不再显示），保留用户输入的 commitMessage/reflog 草稿。
- 真实错误：清 `notARepo`（红失败面板取代中性面板），`lastOp` 如实红显。

**验证**（G2，自有副本，不碰用户 .git、不重启清状态）：普通→Git（中性消失+main 出现）→普通（中性回归+「非 Git 目录」+旧投影消失）→错误（.git 变普通文件=真实错误红面板）→成功（恢复 init+commit 后红消失+main 回归）；跨项目往返 B(trunk)↔A(main) 分列不串。

## 3. /thread/:id 深链与跨项目定位（R71 登记不稳定——真修复）

**根因**：`loadThread` 的 `stillCurrent` 双门（loadGen+activeProjectId）把「线程所属项目 ≠ 活跃项目」的装载当迟到响应丢弃——冷启动深链（bootRemembered 恢复的是别的项目）、切 B 后点 A 线程直链时 `threadEntities` 永不落位，只能误报「不存在或不可访问」。另有消息高亮只在 +350ms 单次尝试（消息异步装载后静默漏定位）。

**修复**（四件）：
1. `ensureProjectActive`（loader）：项目对齐公共前置——已装载（房间缓存）→ `focusProject` 轻切换（同侧栏点击）；未装载 → `openProjectByPath` 全链（幂等合并）；有界重试吸收启动恢复观察器并发窗口。**门内迭代追加修复：「活跃≠已装载」**——`applyServerNavPrefs` 重启后恢复 activeProjectId 但不装房间/成员，此前早退导致直达房间报「找不到该房间」；现要求「活跃且房间已装载」才可早退。
2. `locateThread`：探归属（thread.get 服务端 audience 裁决）→ 对齐项目 → RoomPage 常规装载接管；`/thread/:id` 路由的缓存直渲也加「归属=活跃」条件。
3. `/project/:pid/room/:rid` 路由加 `ProjectAlign` 对齐器（看板用 switchFocusProject 已自对齐；归档页房间链接/待验收线程链接此前未对齐=房间报「不存在」）。
4. **路由直达线程时上下文侧让位**（门内迭代发现的真缺陷）：RoomPage 因路由重挂载时 `prevThreadIdRef` 初值即当前 threadId（比较相等不动作），上传芯片在主池侧打开的预览把 `previewSide` 留在 'pool'，线程面板被 `previewSide !== 'pool'` 判断整个隐藏——深链进来只见主池。补挂载期 effect：threadId 非空即 `setPreviewContextSide('thread')`。消息高亮改有界重试（~18s）等元素挂载（原 +350ms 单次在异步装载下静默漏定位）。

**验证**（G6 矩阵，单一场景链）：复制应用内链接（真实菜单→系统剪贴板）→ 切 B 后用直链回 A（线程+消息高亮）→ 看板定位（tab=task）→ 待办定位（未读线程）→ 收藏回原处 → 搜索定位 → **冷启动重开**（新进程+直链直达）→ 切 B 房间不串 A 线程内容。

## 4. 验证口径纠正（review 三）与补齐

- **82 页口径**：r71 报告/矩阵总述已改为「82 页识别、首/中/末页抽样通过」（原文「容器 82 个 slide 部件全数渲染」只证部件存在）。本轮 G3 新增**逐页真实渲染 walk**：82/82 页逐页等渲染+图片解码，页级失败逐页记录（见 §6 结果）。
- **Excel 数据行**：r71「mode=engine」口径已注记（只证引擎挂载）。本轮 G4 补：引擎 `aria-rowcount`（真实装载行数）vs openpyxl 源 69793；横纵滚动；键盘响应（Ctrl+Home 滚动归零=真实用户键盘路径）；关闭→重开的阅读位置恢复；**首/中/末可视内容与源事实核对**——门内截图（top/mid/bottom），门后视觉判读记录（合成输入无法驱动 canvas 选择/复制——诚实登记为边界，见 §8）。
- **进程内存口径**：r71「13→111MB」已注记为 renderer JS heap 采样（≠总进程）。本轮 G5 采样**全进程树**（electron 主/渲染 + daemon + 解析 worker）的 WorkingSet 峰值；并发两件解析（串行队列）都完成；关闭全部后子进程回基线（收拢）；收敛后重开可用。**不再上调任何限额**。

## 5. 六来源（同一真件 22.54MiB PPT 重查——修正 R71 两处证据错位）

R71 G5 ③「线程回复附件」实为**房间级记录**（`.composer-input` 全局选择器命中房间输入区，非 `.col-thread` 线程输入区）；R71 G5 ②的「本次仅记录」切换按钮在 2025-09-25 后已收进 ⋯ 菜单（「仅记录，不请求回复」），r71 的点击实为 no-op、其二实为一次 AI 派发线程。本轮全部修正：②经 ⋯ 菜单真实仅记录（DB 落库断言）；③用 `.col-thread` 作用域且以 DB 断言 `thread_id` 命中（真线程回复）。六源：①房间草稿 ✅／②已发根消息附件（记录意图+另存 sha 一致）✅／③**线程回复附件（thread_id DB 断言）**✅／④私信 ✅／⑤文件树（=G1）✅／⑥成果文件（=G1 交付通道）✅。

## 6. 验证总账

- **verify-daily-r72.cjs**：`{"ok":true,"errs":[]}`（run `gate-r72-r72-gate-20261008140515`），realCallRoots **6×0**。关键事实：
  - G1 文件树原始路径：22.54MiB 真件 **82 页 / 5.4s**；图文页 p40 图片 **1/1 解码**；末页 82；切标签回位 **82**；**另存 sha256 一致**（23,629,598B）；上传件 7.1s；成果件落盘字节一致。
  - G3 **82/82 逐页真实渲染 walk，0 页失败**（3.6s 全程；页级失败逐页记录=空）。
  - G2 Git 往返：中性→Git(main)→非 Git（中性+旧投影清）→**objects 损坏=红失败**（`fatal: bad object HEAD`——真实错误不落中性分类）→恢复（红消失+main 回）；B(trunk)↔A(main) 跨项目分列。
  - G4 Excel：引擎 aria-rowcount **69913** vs 源 69793（+20 头部余量）；Ctrl+Home 键盘滚动 **8000→0**（真实用户键盘路径）；纵向 mid 726,881 / bottom 1,453,762；横向 2,417；重开 sheet 恢复（滚动按 R70 合同不持久——重开回顶）；console 零错误；**视觉判读 TOP/MID/BOTTOM 全 PASS**（top=表头「文本ID」+U3-a9f4ba…；mid=行 34947-34967 U3-/DATA/对话脚本族；bottom=行 69792/69793 U3-fe38d…/U3-c2766…+DATA_AS2+DATA_AS2.BIN_01478+内部字段表——绝对底部为尾部 ~120 行空网格行带，属正常表格形态）。
  - G5 进程资源：**全进程树采样**（electron×3+daemon+conhost），单进程峰值 **887MiB**（解析 worker，< 896MiB Job Object 硬界）、全树合计峰值 2171MiB（记录值，无断言越界）；两件大文件上传解析**串行队列都完成**；关闭全部后子进程**回基线 5**；加载中关闭同样收敛；收敛后重开可用。
  - G6 深链矩阵 **10/10**：复制应用内链接（真实菜单→系统剪贴板）/真跨项目（活跃=projB6 下直链 A 线程）/消息高亮/看板定位/待办定位（二次派发制造新鲜未读）/收藏回原处/搜索定位/冷启动重开/切 B 不串 A。
  - G7 六源真件 22.54MiB：①草稿②已发（记录意图经 ⋯ 菜单+DB 落库断言+另存一致）③**真线程回复（thread_id DB 断言）**④DM⑤树（=G1）⑥成果（=G1）；文件树 33.5MiB 负例就地「超只读上限 32MiB」不渲染。
- 全量 **921/921**（117 文件；新增 r67Contracts R72 边界用例）；主/hifi typecheck 0 错；**r71 门回归 `ok:true`（realCalls 8×0）**——前两次失败为环境 CPU 争用 flake（截断 G1 单独跑即绿+全量重跑绿，如实记录）。
- G4 附加边界（如实）：合成 CDP 输入无法驱动 canvas 引擎的单元格选择/复制（pointerdown 命中且 preventDefault 已发生、键盘滚动正常，但选择未提交）——数据行核对改由视觉判读承担；真机鼠标选择属用户自然使用面。

## 7. 交付

- **desktop-daily-win-v10** = `bld_0558b208779db4a7`（commit `a700a58`，dirty=false，清单 **593/593** 一致）。源码形态验证（r72 门/全量/r71 门）与交付形态验证分列。
- **r63 `--src` v10**：`ok:true`，realCalls=0（独立副本×真实启动器×发布协议）。
- **R72 启动器原始路径复证**（`verify-r72-launcher-treepath.cjs`，独立副本+start-desktop.bat+zsres://app+CSP）：文件树点击真件 → **82 页 5.4s** → p40 图片 **1/1 解码**（发布形态 CSP blob: 链）→ console 零错误 → realCalls=0；project.open DTO rootPath 在发布形态同样返回。
- 升级门负对照沿用 R71 结论（本轮零 schema/迁移变更，`verify-upgrade-r67` 4/4 维持）。

## 8. 未覆盖/边界（如实）

- Excel canvas 引擎的**选择/复制**无法由合成输入驱动（§6）；真机鼠标选择、69793 行逐帧滚动性能、82 页逐页**像素级**对照（本轮为逐页渲染+解码断言+抽样视觉判读）待用户自然使用。
- 深链定位链在门迭代中出现过**低频竞态**（locateThread 对齐偶发一轮失败）：已加产品级吸收（对齐落位校验+一次重试+门内双轮重试），take-19 与启动器复证均稳定通过；如用户实际使用中复现「链接打不开」，按新日志面再收。
- r71 门回归前两次失败判为环境 CPU 争用 flake（同代码第三次干净通过+G1 单段通过）——如再复现将按独立反例处理。
- （既有延期不动：Android/安装器签名/价值评价/DEV-11/并行写入/G5 等。）
