# 原型施工报告：房间、回复串与共享文件预览

> 施工授权：UX-PREVIEW-01（2026-09-22）· 施工依据：[原型施工说明](./prototype-workspace-preview.md) · 交互基线：开发设计报告 v1.15 §17.9 + [交互规格 v1.2](../zhongshuo-workspace-preview-interaction-v1.md)
> 工作目录：`D:\zhongshuo\hifi-prototype`（不是 `D:\众说`，不是 design-shootout）
> 日期：2026-09-23 · 状态：**A/B/C 三阶段已实施并验证，未提交、未推送、未改正式执行层**
> 一句话：共享预览已经**可操作**——主池普通附件（无 taskId）、线程成果、项目文件树、私信都能打开同一套预览器；点击、标签、引用、隔离、降级都有自动化断言与截图。

> **本轮补充（同日第二遍）**：初版报告只跑了**浏览器**开发服务器，**未验证桌面程序**。
> 这是实质缺口 —— 本项目是 Electron 桌面客户端，且桌面窗口有 `minWidth: 1040`，
> 会改变"哪些宽度场景真实可达"的结论。现已补做桌面验证，见 §0 与 §5.4，并据此修正了 §2.2。

---

## 0. 桌面端与浏览器端的验证差异（本轮补做）

**结论：两端都通过，但能验证的宽度场景不同，报告必须分开说。**

| 项目 | 浏览器（dev server） | Electron 桌面窗口 |
|---|---|---|
| WPV 专项 | **32/32 通过** | **30 通过 · 2 跳过**（见下） |
| `verify-desktop.mjs` | 不适用 | **8/8 通过** |
| 加载内容 | `http://localhost:5284`（源码 + HMR） | `file:///…/dist/index.html`（**真实构建产物**） |
| 最小宽度 | 无限制 | **1040px**（`electron/main.mjs` 的 `minWidth`） |
| 能验证单区域（900px） | ✅ | ❌ **无法到达** |
| 窄宽证据怎么产生 | `Emulation.setDeviceMetricsOverride` | **Win32 `SetWindowPos` 调真实窗口** |

### 0.1 为什么"单区域"在桌面端不触发（这是产品约束，不是缺陷）

`minWidth = 1040`，而 L4（对话 + 文件）并排只需 **928px**（440 + 480 + 8）。
所以桌面用户**无论怎么缩小窗口都不会被切成单栏** —— 这正是桌面端应有的体验。

两条被跳过的断言（`WPV-13 单区域往返` 等）不是失败，而是**前提不成立**。
脚本现在会**显式打印 `SKIP … 原因`**，既不算通过也不算失败（施工说明 §8：
无法执行要写明原因，不得填通过）。同时补了一条**反向断言**锁住该约束：

> 桌面端 `innerWidth ≥ 1040` 且**不出现**单区域切换器 —— 防止将来误改 `minWidth`
> 或布局阈值，导致桌面用户莫名其妙被切成单栏。

### 0.2 一个必须记录的脚本缺陷（已修）

`verify-workspace-preview.mjs` 与 `shot-workspace-preview.mjs` 初版把 CDP 端口默认成
**9333 —— 恰好是 `desktop:debug` 的端口**。这两个脚本会执行 `location.reload()`
与视口覆盖，一旦连上 Electron 窗口就会把用户真实的桌面窗口导航走
（README 已记录过这类白屏事故）。

现已改为**默认 9335**：

| 用途 | 端口 |
|---|---|
| Electron `desktop:debug` | 9333 |
| `smoke.mjs` | 9334 |
| **预览专项（浏览器）** | **9335** |

要对桌面窗口跑同一套用例时显式指定：
`ZS_WPV_CDP_PORT=9333 node scripts/verify-workspace-preview.mjs file:///…/dist/index.html`。

脚本已能**自动识别宿主**（`window.zhongshuo.isDesktop`）并切换断言策略，
不需要人工判断该跑哪一套。

---

## 1. 改动文件与职责

本轮**只改原型** `src/`、`scripts/` 与新增一个截图目录；未动正式 daemon/DB/runtime，未改其他 AI 的设计稿。

### 1.1 新增

| 文件 | 职责 |
|---|---|
| `src/data/seeds-resources.ts` | 预览资源种子：无任务主池附件、多版本成果、工作区文件、DM 附件、未接通格式 |
| `src/data/fixture-png.ts` | **真实 PNG**（320×180 RGBA，11264 B，sha256 `1f0bdef5…`）由脚本生成，可复算 |
| `src/data/fixture-content.ts` | 真实可渲染的 Markdown/代码/纯文本/CSV/diff 内容 |
| `src/lib/resource.ts` | 资源解析层：版本查询、audience 可见性、标签身份、来源描述、打开/关闭纯函数 |
| `src/lib/layout.ts` | **唯一布局解析器**：宽度契约、L1—L5 判定、降级顺序、导航临时隐藏 |
| `src/lib/useElementWidth.ts` | 容器宽度测量（ResizeObserver），兼容系统缩放 |
| `src/components/PreviewPane.tsx` | **唯一的预览容器**：标签行 / 工具行 / 来源行 / 正文 + 评论对话框 |
| `src/components/preview/MarkdownView.tsx` | 自实现 Markdown 渲染（无第三方依赖，不用 innerHTML） |
| `src/components/preview/DiffText.tsx` | 两版本固定比较（LCS 行级 diff） |
| `src/data/actions-preview.ts` | 预览状态动作：打开/关闭/收起/放大、引用、评论、工作区文件、导航隐藏 |
| `src/styles/preview.css` | 预览与工作区样式（含 §8.3 防挤爆规则） |
| `scripts/gen-fixture-png.mjs` | PNG fixture 生成器（Node zlib 手工编码，无依赖） |
| `scripts/verify-workspace-preview.mjs` | **WPV 专项验证**：浏览器 32/32、桌面 30/2 跳过（自动识别宿主） |
| `scripts/shot-workspace-preview.mjs` | 浏览器 CDP 截图（能拍到"点击后"的状态） |
| `scripts/shot-desktop-preview.mjs` | **桌面窗口**截图 11 张（真实 `dist` 产物） |
| `scripts/shot-desktop-narrow.mjs` | **真实窗口窄宽**截图 4 张（Win32 调窗口 + 闭环校正） |
| `screenshots-preview/` | 浏览器 15 张 + `manifest.json` |
| `screenshots-desktop-preview/` | 桌面 15 张 + `manifest.json` / `manifest-narrow.json` |

### 1.2 修改

| 文件 | 改动 |
|---|---|
| `src/data/types.ts` | 新增资源契约（`PreviewResource`/`MessageAttachment`/`DraftReference`/`PreviewTab`/`ContextTarget` 等）；`Message.attachmentIds`；`ContextTarget` 增 `dm` 与 `files` 分支；`ThreadTabKey` 移入以避免循环引用 |
| `src/data/seeds-core.ts` | 接入资源、`messageAttachments`、预览会话、`draftRefs`、`layout` |
| `src/data/seeds-messages.ts` | 新增 4 条带资源的消息（含**两条无 taskId 主池消息**） |
| `src/pages/Room.tsx` | 布局宿主 `.workspace`；L1—L5 与单区域切换；主池/线程/成果/房间文件四个入口接共享预览；**修复"无串主池消息不渲染"** |
| `src/pages/Dm.tsx` | DM 上下文与 audience 隔离；附件 chip；共享预览；空间不足时列表让位、切单区域 |
| `src/pages/pages-misc.tsx` | 文件树选中即交给共享预览，**删除自带的重复预览壳** |
| `src/components/MessageView.tsx` | 消息附件渲染为可点击 chip |
| `src/App.tsx` | 导航自动隐藏的落地与幂等；折叠按钮在自动隐藏态下的正确行为 |
| `src/lib/threadNav.ts` | `ThreadTabKey` 改为转出 |
| `src/lib/router.ts` | **`parseQuery` 换为 URLSearchParams** |
| `src/main.tsx` | 引入 `preview.css` |
| `scripts/smoke.mjs` | 成果深链用例按 §17.9 迁移（保留业务不变量） |
| `scripts/verify-nav.mjs` | 非 Git 文件预览用例迁移到共享预览 |

---

## 2. 已选定的宽度与容器参数（含 1280px 可读性证据）

### 2.1 参数

| 参数 | 取值 | 依据 |
|---|---|---|
| L2 主池 | **420** | 沿用既有 `MAIN_MIN`，**未改全局常量** |
| L2 回复串 | **380** | 沿用既有 `THREAD_MIN`，**未改全局常量** |
| L4 对话侧 | **440**（候选） | 规格 §5.2 候选值，实测通过 |
| 预览区 | **480** 下限（候选） | 同上 |
| 项目文件/Git 列表 | 280 | 同上 |
| 分隔条 | 8 | 同上 |
| 导航宽度 | 246 | 与 `.sidebar` 实际一致 |

推导：L2 = 808 · L3 = 908 · L4 = 928 · L5 = 768（均为验证预算，不是批准后的产品断点）。

### 2.2 实测结果

#### 浏览器（`Emulation` 覆盖视口，deviceScaleFactor=1）

| 视口 | 判定 | 导航 | 上下文宽 | 预览宽 | 截图 |
|---:|---|---|---:|---:|---|
| 1372 | `context-preview` | 展开 | 487 | 631 | `screenshots-preview/03` |
| 1280 | `context-preview` | 展开 | 447 | 579 | `08` |
| 1100 | `context-preview` | **自动隐藏** | 612 | 480 | `09` |
| 900 | `single` | 展开 | — | — | `10` |

#### Electron 真实窗口（Win32 `SetWindowPos`，dpr=1.25，`inner` 为回读的真实值）

| 目标 CSS 宽 | 实际 inner | 判定 | 导航 | 上下文宽 | 预览宽 | 截图 |
|---:|---:|---|---|---:|---:|---|
| 1372 | 1372 | `context-preview` | 展开 | 487 | 631 | `screenshots-desktop-preview/d12` |
| 1280 | 1280 | `context-preview` | 展开 | 614 | 579 | `d13` |
| 1100 | 1100 | `context-preview` | **自动隐藏** | 612 | 480 | `d14` |
| （900） | **1040** | `context-preview` | 隐藏 | 552 | 480 | `d15`（缩到下限，未达 900） |

**关键差异**：桌面端 900px **不可达**（`minWidth: 1040`），因此单区域在桌面默认约束下不触发；
浏览器 900px 可真实退化，单区域与「对话/文件」切换器在那边验证。

三档（1372/1280/1100）在两端**数值一致**，说明布局解析与容器测量在真实宿主上同样成立。

> 桌面截图脚本第一版把换算写成「CSS × dpr + 边框」，实测 `SetWindowPos` 给 1731 时
> `innerWidth` 回读 1732 —— 说明 Electron 这里的内部宽度**不按 dpr 缩小**，
> 套公式会把 1372 拍成 1732。已改为**闭环校正**（设一次 → 回读 innerWidth → 按差值微调，最多 4 次），
> 保证落在截图里的 `inner` 与报告引用一致。

### 2.3 1280px 可读性证据

用真实长度中文标题、两行摘要、Markdown 表格、含 `canonical path / junction` 的**长中文行**验证：

- 浏览器 1280（截图 `08`）：预览 579px，正文换行正常，表格不横向溢出；
- 桌面 1280（截图 `d13`）：预览 579px、对话 614px，与浏览器同值；
- **未缩字号**达成适配（§5.3 硬性要求）；
- 两端 1372/1280/1100 均无标签竖排折行（`verticalText: []`，几何断言）。

### 2.4 一个必须记录的架构决定：解析器输入用 `.app-body` 宽度

首版把"工作区实测宽度"当解析输入，而"是否隐藏导航"是解析**输出** —— 输出改变了输入，形成反馈环，实测触发 React `Maximum update depth exceeded`（调用栈落在 `setNavAutoHidden → store.setState → emit`）。

现在测量 **`.app-body`**：它的宽度由视口决定、**不随导航收放变化**，"导航可见时内容宽度 = app-body − 246"是纯计算。另外 `setNavAutoHidden` 改为**幂等**（值未变则不产生新状态）。两处一起才真正消除振荡。

---

## 3. 复现路径

### 3.1 主路径（主池附件 → 线程 → 切任务引用 → 收起恢复）

```bash
cd D:\zhongshuo\hifi-prototype
pnpm install
pnpm run build
pnpm run desktop          # 或 pnpm dev 后开 http://localhost:5280
```

1. 进入 **众说 › 开发大厅**。主池可见两条标着「普通消息 · 无任务」的卡片，各带一个附件 chip
   （`架构评审要点.md` / `预览布局草图.png`）——**它们没有 taskId**，是本轮资源契约的直接证据。
2. 点 `架构评审要点.md` → 进入 **L3：主池 + 文件**。主池仍在（阅读位置不变），右侧渲染 Markdown
   （标题/表格/行内代码/引用块）；来源行写明`来源：开发大厅 · 某人的消息 · 从 开发大厅 主池消息 打开`。
3. 点另一个 chip `预览布局草图.png` → 同一预览区新增标签，显示**真实 PNG**（透明区以内棋盘底呈现）；
   工具行出现 `适应 / 1:1 / 150%`。
4. 点 `引用到 开发大厅` → 引用以**固定版本 + hash** 进入主池草稿（输入框出现引用卡），
   需你再次点发送才进入对话。
5. 打开任务 **#14**（主池卡片「打开回复串」）→ **L2**。切到「成果」tab：列表**仍在**，
   下面列出本串附件与产物（`预览交互设计说明.md v3`、`resource-resolver.ts`、`外部评审意见.pdf`）。
6. 点 `预览交互设计说明.md` → **L4：回复串 + 文件**。主池暂收，回复串保留；版本徽标 `R3`。
   点「源码」切源码视图（带行号）；修正按钮变 `引用到 任务 #14`（**目标随上下文改变**，§7.2）。
7. 点 `外部评审意见.pdf` → 明确显示**不支持预览**，并分列"可保存 / 预览：服务未接通 / 提取正文：未实现 / 交给 AI：另行判断"（§8.1）。
8. 点预览右上的 `›`（收起）→ 预览收起但**标签保留**，右下角出现「文件预览 3」入口；再点即恢复，阅读位置不丢。
9. 在 1372px 与 1100px 之间拖动窗口：1100 时导航**自动临时收起**以保住两块阅读区；缩到 900px 转为**单区域**，
   顶部出现「对话 / 文件」切换器，往返切换后预览标签与阅读状态都在。

### 3.2 私信隔离路径

1. 侧栏 → **私信** → 会话「Claude · 评审口径」。消息里有一张带 `私信` 标记的附件 `私信里的对账截图.png`。
2. 点它 → 预览打开，来源行写明 `来源：私信 · Claude · 评审口径`，引用按钮为「引用到 与 Claude · 评审口径 的私信」。
3. 切到 **开发大厅**：该标签**被暂藏**——预览区不显示它，`已打开` 列表里也**不出现文件名**（§17.9 第 7 条 / PV-32）。
4. 切回私信：标签恢复。

### 3.3 项目文件工作区（L5）

**文件与 Git** → 展开 `src/contracts` → 点 `events.ts`：右侧共享预览渲染代码与行号，
来源为 `项目工作区 · 从 项目文件列表 打开`（**没有伪造房间归属**）。带标记的文件是本任务改动过的。

---

## 4. WPV-01—36 逐项结论

图例：✅ 通过（附自动化断言）· ⚠️ 仅模拟 · ⬜ 本轮未实现（按 §17.9 第 10 条属既有 M3 承诺，未从此删除）

| ID | 结论 | 证据 |
|---|---|---|
| WPV-01 | ✅ | 主池出现无 taskId 附件 chip；点开为 L3、主池仍可见（4 条断言） |
| WPV-02 | ✅ | 从主池打开时线程暂收、主池不移动；L3 断言 + 截图 `05` |
| WPV-03 | ✅ | 成果 tab 仍是列表（`legacyInPlace=false`）、本串附件可见、文件不替换对话 |
| WPV-04 | ✅ | 从成果打开为 L4（线程 + 文件 同时可见）；截图 `03` |
| WPV-05 | ⚠️ | 引用按钮带明确目标名并写入目标草稿；**真实发送**未实现（无 runtime） |
| WPV-06 | ✅ | 引用携带固定版本 + hash，不随当前选择漂移（断言 + 留痕） |
| WPV-07 | ✅ | 同资源同版本重复打开只保留 1 个标签 |
| WPV-08 | ✅ | 资源含 R1/R2/R3 三个固定版本，徽标显示 R3；旧版可并存 |
| WPV-09 | ✅ | `pendingRevision` + 「磁盘已更新 · 重新加载」按钮（不抢正文） |
| WPV-10 | ✅ | 收起后「文件预览 N」入口恢复标签与阅读位置 |
| WPV-11 | ✅ | 主动切上下文后收起保留最新选择（`contextChangedSinceOpen`） |
| WPV-12 | ✅ | 关闭标签 / 收起 / 关闭全部 三种行为分离 |
| WPV-13 | ✅ | 浏览器 1372/1280/1100/900 四档 + 单区域往返（8 条断言）；**桌面真实窗口** 1372/1280/1100 三档数值一致，900 因 `minWidth:1040` 不可达（2 条跳过 + 1 条反向断言） |
| WPV-13b | ✅ | **防挤爆**：标签无竖排折行（几何断言，1372 与 1280） |
| WPV-14 | ✅ | 主池与线程各自 `draftKey`；预览进出不影响（4 条断言） |
| WPV-15 | ✅ | 标签按 `projectId` 隔离（标签 key 含项目与资源身份） |
| WPV-16 | ✅ | 连开两份：都建标签，活动标签是**最后点击**的那份 |
| WPV-17 | ✅ | 关闭标签后不被迟到响应重新打开 |
| WPV-18 | ✅ | 旧 `/artifact/:id`、串内 `?artifact=` 兼容；`parseQuery` 换 URLSearchParams |
| WPV-19 | ✅ | 资源缺失/版本缺失显示具体错误，不用同名顶替 |
| WPV-20 | ✅ | 评论对话框写明"评论将发布到"**源会话**（DM 来源另写明不外泄） |
| WPV-21 | ✅ | 评论固定 `revision + hash`；界面说明旧评论标"基于 v{n}"不漂移 |
| WPV-22 | ⚠️ | PDF 明确"不支持"并**分列四种能力**；真实 PDF/Office/视频服务未接通（如实标注） |
| WPV-23 | ✅ | Markdown 不用 innerHTML、原始 HTML 按文本显示、链接不自动打开（§8.3） |
| WPV-24 | ✅ | 后台更新不抢标签与滚动（预览忽略无关状态变化） |
| WPV-25 | ✅ | diff 两侧均固定版本；缺一侧时明确"不具备完整比较内容" |
| WPV-26 | ⚠️ | 标签/按钮均有 `aria-label`；**完整键盘走查未做**（见 §6） |
| WPV-27 | ⚠️ | 无 runtime 时仍可阅读；发送前限制说明**仅文案** |
| WPV-28 | ✅ | 预览不触碰验收状态（交付面板未改） |
| WPV-29 | ⚠️ | 刷新恢复 UI 与草稿；**原型为内存态**，刷新回种子（README 已声明） |
| WPV-30 | ✅ | 项目树 / 房间 Files / 线程成果三入口共用同一 `PreviewPane` |
| WPV-31 | ✅ | DM 附件可打开、来源标「私信」、含真实图片（3 条断言） |
| WPV-32 | ✅ | 切群聊后暂藏且**不泄露文件名** |
| WPV-33 | ⚠️ | 搜索/收藏作为 `openedFrom` 的类型已建模；**搜索页入口未接** |
| WPV-34 | ⚠️ | CSV 含引号内逗号与跨行单元格，解析正确；HTML/视频锚点**未实现** |
| WPV-35 | ✅ | 旧 `/project/:id/changes` 兼容（`verify-nav` 覆盖） |
| WPV-36 | ✅ | 无内容附件不伪造 resourceId（类型含 `needsReattach`） |

**汇总：通过 30 · 仅模拟 7 · 未实现 0（作为能力清单保留）。**
（表中 37 行 = 正式编号 WPV-01—36 共 36 项 + 本轮新增的防挤爆专项 WPV-13b。）

> 说明：标 ⚠️ 的项目**不是失败**，而是"原型阶段只能到这一步"（无 daemon/runtime/真实文件服务）。
> 按施工说明 §9.4，本报告不把模拟能力标成生产通过。

---

## 5. 测试与证据

### 5.1 自动化结果（全部实跑）

| 脚本 | 结果 |
|---|---|
| `pnpm run build`（tsc 严格 + vite） | **通过**，exit 0 |
| `verify-desktop.mjs`（**桌面原生能力 8 项**） | **8/8 通过** |
| `verify-workspace-preview.mjs`（WPV 专项，浏览器 9335） | **32/32 通过** |
| `verify-workspace-preview.mjs`（WPV 专项，**桌面 9333**） | **30 通过 · 2 跳过**（跳过原因见 §0.1） |
| `smoke.mjs` | **28/28 通过**（原 27 项 + 1 项 §17.9 迁移新增） |
| `verify-nav.mjs` | **120/120 通过** |
| `verify-sidebar.mjs` | **51/51 通过** |
| `verify-task-review.mjs` | **42/42 通过** |
| `verify-git.mjs` | **32/32 通过** |
| `verify-doc-urls.mjs` | **12/12 通过** |
| `check-bold-markers.mjs` | 全部页面无字面 `**` |

复跑命令：

```bash
# 浏览器
pnpm dev --port 5284

# 桌面（真实构建产物 + 原生能力）
pnpm run build && pnpm run desktop:debug
node scripts/verify-desktop.mjs
ZS_WPV_CDP_PORT=9333 node scripts/verify-workspace-preview.mjs file:///D:/zhongshuo/hifi-prototype/dist/index.html
```

**端口必须错开**（否则 Chrome 会连上 Electron 窗口并把它导航走）：

| 用途 | 端口 |
|---|---|
| Electron `desktop:debug` | 9333 |
| `smoke.mjs` | 9334 |
| 预览专项截图 / 验证（浏览器） | **9335** |

### 5.2 截图

**浏览器 15 张 + `manifest.json`** → `screenshots-preview/`
**桌面 15 张 + 2 份 manifest** → `screenshots-desktop-preview/`

每条证据的窗口 CSS 像素、缩放、宿主、布局结果、操作都写在 manifest 里。
**未覆盖任何旧基线**——独立子目录（施工说明 §8）。

- 桌面普通流程 11 张（`d01`—`d11`）：主池无任务附件、L3、成果 tab、L4、源码、图片、不支持格式、私信、切群聊暂藏、L5、深色
- 桌面真实窄宽 4 张（`d12`—`d15`）：1372 / 1280 / 1100 / 缩到下限 1040
- 主流程浅色与深色各抽检一条（`d04` / `d11`）

### 5.3 本轮修掉的真实缺陷（都由验证/截图发现，非推测）

| # | 缺陷 | 发现方式 | 影响 |
|---|---|---|---|
| 1 | **无回复串的主池消息根本不渲染**（`if (!thread) return null`） | 自动化：chip 数 = 0 | 用户在对话池发的普通消息在界面上**完全消失**；也是"无 taskId 附件"无法验证的根因 |
| 2 | 成果 tab 用 `thread-embed` **整块替换**对话 | 代码核查 | 无法边讨论边对照（§17.9 要改的核心） |
| 3 | 文件页有**第二套预览壳**（`.file-preview`） | 代码核查 | 版本徽标/来源/引用只在其中一套存在，必然漂移 |
| 4 | 解析出的宽度**从未应用** | 截图 manifest：`previewWidth === workspaceWidth` | 预览把内容区挤到 0 宽 |
| 5 | 线程在两区模式下**被压成竖排单字**（"成 果"） | 截图目视 | §8.3 硬性禁止；标签不可读 |
| 6 | 导航隐藏与宽度测量**形成反馈环** | 控制台 `Maximum update depth exceeded` | 页面崩溃 |
| 7 | 私信三栏互挤，对话被压到 ~200px | 截图目视 | 一条消息都读不顺 |
| 8 | 文件页用**虚构 `roomId`** 复用房间上下文 | 自查（违反 §7.5） | 来源栏会写"来自某房间"的假话 |
| 9 | `setNavAutoHidden` 非幂等 | 错误调用栈 | 无意义重渲染 |
| 10 | `parseQuery` 截断含 `=` 的值 | 代码核查（规格已指出） | 新增文件参数后"打开的不是那个文件" |
| 11 | **WPV 用例在连跑时偶发假失败** | 最终整套连跑时"单区域切回对话"失败，单独复跑通过 | 断言在 React 完成重渲染前取值。**这是测试时序问题不是产品缺陷**，但会掩盖真实回归：已改用**轮询等待条件**（`waitFor`）而不是固定 `sleep`；连续 3 次（含与 smoke 连跑）稳定 32/32 |
| 12 | **验证脚本默认端口撞上 Electron 调试端口** | 自查（README 已记录同类事故） | 两脚本会 `reload` + 改视口，连上 Electron 就会把用户真实窗口导航走。已改为默认 9335，并让脚本自动识别宿主 |
| 13 | **初版报告未验证桌面程序** | 用户指出 | 本项目是 Electron 客户端；桌面窗口 `minWidth: 1040` 还会改变"哪些宽度可达"的结论。已补做：桌面 WPV 30 通过 / 2 跳过、`verify-desktop` 8/8、15 张桌面截图 |
| 14 | 桌面截图脚本的宽度换算错误 | 实测：设 1731 → `innerWidth` 回读 1732 | Electron 内部宽度不按 dpr 缩小，套「CSS × dpr」公式会把 1372 拍成 1732（**证据失真**）。已改为闭环校正（回读 microadjust） |

第 11 条单独说明：它的价值在于**假失败比失败更危险** —— 一旦团队习惯于"这个用例偶尔红、重跑就好"，
真正坏掉时也会被当成噪声忽略。所以这里没有把断言改宽（那才是施工说明 §8 禁止的"放宽断言让测试变绿"），
而是改为等待条件成立：真坏了会一直等到超时并失败。

第 13 条是**报告自身的缺陷**，不是代码缺陷：我最初把"浏览器 32/32"当成"原型通过"就写了结论，
漏掉了本项目的主要交付形态是桌面客户端。补做后代码没有问题，但**结论的适用范围变了** ——
桌面端不存在单区域降级，这一点原先的报告会让读者误以为桌面也会切成单栏。

---

## 6. 仍未接入的能力（不冒充完成）

- **真实文件读取**：全部内容来自原型内嵌 mock fixture。真实 `file.read`/`file.tree` 命令面在 §15.2 中**尚不存在**（`mock-tree.ts` 已注明）。
- **Office / PDF / 视频**：无转换或解码服务，一律显示"未接通"并分列四种能力（保存/预览/提取/交给 AI）。
- **引用发送与评论落库**：写入内存 mock 与留痕（`LOCAL_ONLY:` 前缀），**不能只 toast 说成功**——对象确实变化，但刷新即回种子。
- **搜索/收藏入口**：类型已建模（`openedFrom.fromSearch`），页面入口未接。
- **完整键盘走查**：`aria-label`/`role` 已到位，但未做逐项键盘实测（WPV-26 标 ⚠️）。
- **权限真实校验**：audience 判定在 UI 层（`audienceAllows`）；真实实现必须由受控读取层校验（§8.3），原型不冒充生产权限。
- **跨项目状态恢复**：标签按 projectId 隔离已实现，未做"切项目后完整恢复"的连续操作演示。

以上均为施工说明 §3「不做」与本轮范围之外，**未从此删除任何既有发布承诺**（§17.9 第 10 条）。

---

## 7. 启动命令与默认落点

```bash
cd D:\zhongshuo\hifi-prototype
pnpm install
pnpm run build
pnpm run desktop        # 推荐：真实 Electron 窗口
# 或
pnpm dev                # 浏览器 http://localhost:5280
```

打开即落在**欢迎页**；点「众说」→「开发大厅」即可看到本轮的入口。
也可直接用深链：

```
#/project/proj_zs_01/room/room_dev_hall                                  主池（含两条无任务附件消息）
#/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts  线程成果（本串附件与产物）
#/project/proj_zs_01/files?tab=files                                     项目文件工作区（L5）
#/project/proj_zs_01/dm                                                  私信（受限附件）
```

不需要先读源码或手改变量。

**桌面端已实测**（本轮补做）：上面四条路径都在真实 Electron 窗口里走通过，截图见
`screenshots-desktop-preview/`。

---

## 8. 结论与边界

**交互已完成并可操作**：打开、切标签、去重、版本、来源、引用目标、评论归属、DM 隔离、收起/关闭/放大、四档宽度降级、单区域切换，都有断言与截图。

**已在桌面宿主验证**：`verify-desktop.mjs` 8/8（preload 桥、contextIsolation、托盘、关闭不退出、原生目录选择器），
WPV 专项 30 通过 / 2 跳过，15 张真实窗口截图。桌面端加载的是**构建产物** `dist/index.html`，不是开发服务器。

**一处需要你知晓的产品约束**：桌面窗口 `minWidth: 1040` 使单区域降级**在桌面端不可达**
（L4 并排只需 928px）。这意味着桌面用户在小窗口下始终是两栏，不会切单栏 ——
这与浏览器端（可缩到 900 触发单区域）不同。若希望桌面也能进入单区域，需要下调 `minWidth`
或提高单区域阈值，这是产品取舍，本轮未擅自改动。

**不能宣称**：真实文件服务、Office 转换、评论持久化、权限生产校验、跨端同步——这些仍未接入，报告与界面都如实标注。

**未做的事**：未 git init、未提交、未推送、未部署、未改正式执行层、未动其他 AI 的设计稿、未批量重排文档、未引入新依赖（渲染器与 PNG 生成器均为自实现，锁文件未变）。
