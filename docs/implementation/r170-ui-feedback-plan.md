# R170 十一项界面反馈施工单（本轮唯一协调文档）

用户 2026-11-03 给出 11 条反馈。工作目录：`D:/zhongshuo-public`（公开源码克隆）。
先读 `AGENTS.md`、本文件；不要改 daemon 数据事实、不要重放/伪造任务。

## 0. 硬性约定

- **不新增 daemon 命令、不改任务/对话真实状态。** 本轮全部是界面与主进程桌面能力。
- **不要运行 `pnpm build:ui`**（本机 pnpm 的 deps 自检会失败）。构建命令是
  `node scripts/build-ui.mjs`。**同一时间只允许一个构建**：构建与截图由 Lead 统一执行，
  队员只做源码修改 + 类型检查 + 定向测试，然后报告，由 Lead 构建并把截图反馈回来。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`（全仓，只读，可并行）。
- 定向测试：`node node_modules/vitest/vitest.mjs run tests/<file>`（只读，可并行）。
- 样式：新增样式写自己的 `src/ui/hifi/styles/r170-<name>.css`（Lead 已加入
  `scripts/build-ui.mjs` 的合并清单）。跨页面的共享样式改动只改自己那份 CSS，
  **不要改 `components.css` / `base.css` / `tokens.css`**（多人并行会冲突）。
- 界面中文、面向普通用户；不写工程术语（“口径/边界/契约/摘录/快照/身份”等）。
- 保留既有 `data-zs-*` 选择器（验收脚本依赖）。
- 每个队员完成时：给出改动文件清单、类型检查结果、定向测试结果、遗留风险。

## 1. 分工与文件所有权

| 工作流 | 负责人 | 写范围（只动这些） | 内容 |
| --- | --- | --- | --- |
| A 成员管理 | teammate `members` | `src/ui/hifi/MembersPage.tsx`、`src/ui/hifi/styles/r170-members.css` | 第 2 项 |
| B 任务看板 | teammate `board` | `src/ui/hifi/pages/TasksBoard.tsx`、`src/ui/hifi/lib/boardHidden.ts`、`src/ui/hifi/styles/r170-board.css` | 第 3、4 项 |
| C 设置页 | teammate `settings` | `src/ui/hifi/pages/SettingsPage.tsx`、`src/ui/hifi/styles/r170-settings.css`、`tests/browser/settingsSinglePageR157.test.ts` 等设置相关测试 | 第 5 项 |
| D 预览/文件/通知/打开方式 | Lead | `src/ui/hifi/preview/PreviewPane.tsx`、`src/ui/hifi/components/MessageChangedFiles.tsx`、`src/ui/hifi/pages/pages-misc.tsx`、`src/ui/hifi/lib/localOpen.ts`、`src/ui/localOpeners.ts`、`src/ui/main.ts`、`src/ui/preload.ts`、`src/ui/hifi/styles/r170-preview.css`、相关测试 | 第 1、6、7、8、9、10、11 项 |

## 2. 各项具体做法

### 2. 成员管理：左项目卡片 + 右 AI 列表（members）
- 页面骨架改成两栏：`.members-split` > `aside.members-projects`（宽约 240px，固定不缩）
  + `section.members-content`（flex:1，min-width:0）。
- 左栏：标题「项目」+ 每个项目一张卡片（项目名、`N 个房间`、目录失效/已归档状态、
  当前项目高亮）。点击卡片 = 切项目（`switchFocusProject` + `navigate(/project/<id>/members)`）。
  项目列表来自 store `projects`（过滤 `removedAt==null`），房间数来自 store `rooms`
  按 `projectId` 计数；**成员数不要伪造**（只有当前项目成员已装载）。
- 右栏从上到下：当前项目标题行（项目名 + N 名成员）与操作（扫描本机 AI / 刷新 / 添加 AI）、
  搜索与状态筛选、成员卡列表（沿用现有卡片内容，可改 grid 为 1 列或 2 列更紧凑）、
  模板面板、房间名单。
- 原来的“项目”下拉去掉（移到左栏）。保留 `data-zs-members`、`data-zs-member-card`、
  `data-zs-member-bind`、`data-zs-member-search`。
- ≤980px：左栏变横向可滚动项目条（不占满一屏高度），右栏在下。

### 3/4. 任务看板卡片重排 + 删除/清空（board）
- 卡片重做（`.board-card`）：
  - 第一行：`#编号` + 状态标签（保持 TaskStatusTag / run 状态 / 待验收 / 退出未确认）。
  - 第二行：标题（最多两行，`font-weight:650`）。
  - 第三行：小字灰色元信息——房间名；`scope=all` 时再带项目名；有 `statusReason` 时
    单行截断。
  - 右上角一个“从看板移除”小按钮（× 图标，hover 可见/键盘可达，`aria-label`）。
  - 整卡可点打开线程；视觉用既有 token（圆角/边框/悬停阴影），不留大片空白。
- 看板列表用两列（`.board-cards` grid，`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`），
  状态分组标题保留但更轻（小标题 + 计数）。
- 删除/清空是**仅隐藏看板卡片，不删除任务、不改任务状态**：
  - 新增 `src/ui/hifi/lib/boardHidden.ts`：localStorage 键 `zs.board.hidden.v1`，
    存 `{ v: 1, items: { [taskId]: at } }`，带上限（如 5000）与损坏数据兜底；
    导出 `hiddenTaskIds()`、`hideTask(id)`、`hiddenCount()`、`restoreAll()`、
    `subscribe(cb)`（`window.dispatchEvent(new CustomEvent('zs-board-hidden'))`）。
  - 单卡移除：卡片按钮 → `hideTask`，toast「已从看板移除（任务本身保留）」。
  - 每个项目分组标题右侧：「清空本项目」→ 第一次点击变「确认清空本项目？」（3 秒内再点执行），
    隐藏该项目当前所有卡片。筛选栏加「清空全部卡片」同样二次确认。
  - 筛选栏/页面显示「已隐藏 N 项」+「恢复」按钮（`restoreAll`），空态文案说明
    “移除只影响看板显示，任务仍可在原对话串打开”。
- 不要改 `board.view` 数据与任务状态；不要动现有过滤/刷新/5 秒轮询逻辑。

### 5. 设置页整理（settings）
- **删除**：`通用` 整段（含「启动时打开的项目」及其搜索索引项）；`通知` 段里的
  「对话串通知」整块；`AI 设置` 段里的「AI 成员的模型与权限」整块。
- 删除后分区顺序：`外观` → `通知`（只剩桌面通知总开关）→ `AI 设置`（调用预算 +
  同时运行的 AI）→ `数据与存储` → `帮助与关于`。
- 深链兼容：`?section=general` 落到页面顶部（或外观），别名表同步；搜索索引去掉被删项。
- 版面整理：
  - 顶部保留「设置」标题 + 搜索；新增一行分区锚点 chips（外观/通知/AI 设置/数据与存储/帮助与关于）
    点击平滑滚动到区段（滚动定位逻辑已有，可复用）。
  - 每段 = 一张卡片：段标题 + 一句说明（≤24 字）+ 行列表；行统一
    `.settings-row`（左标签 + 可选一行灰说明，右控件），行间距一致；去掉重复解释段落。
  - 正文最大宽 880px 居中；≤760px 行内容上下排。
- 更新受影响的测试（`tests/browser/settingsSinglePageR157.test.ts` 等），断言新分区集合与
  被删内容不再出现；保留 `data-settings-section`、`?section=` 行为。

### 1/6/7/8/9/10/11（Lead 自做）
- 1 通知图标：主进程 Electron Notification 显式带随包 .ico（`nativeImage`），保留 AUMID 注册。
- 6 预览「⋯」去掉「摘录到输入框」「评论此文件」。
- 7 预览路径行改为绝对路径（可复制）。
- 8 预览标签右键菜单：打开文件夹 / 按默认程序打开 / 关闭 / 关闭其他 / 关闭全部。
- 9 文件页顶部合并为一条 42px 行（与房间顶部一致）。
- 10「查看变更」用彩色行级 diff（绿新增/红删除）。
- 11 文件卡「打开」右侧加展开菜单：系统可用的编辑器（资源管理器/VS Code/IntelliJ IDEA/PyCharm）
  + 复制相对路径 / 复制绝对路径。

## 3. 验证

- Lead 构建 + 用 `scripts/capture-r170-ui.cjs` 截图核对后再交付。
- 全量回归由 Lead 在收口时跑（`node node_modules/vitest/vitest.mjs run`），基础失败项以
  `docs/implementation/continuation.md` 最近几轮记录为准（3 项预期失败 / 16 跳过）。
