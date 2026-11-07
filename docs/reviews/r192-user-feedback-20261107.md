# R192 用户四项界面反馈（2026-11-07）

## 用户反馈

用户基于已安装 beta.36 反馈四项：

1. 发送的消息应该支持预览图查看。截图中的图片消息只显示「image.png / 图片 · v1 · 5 KB / 打开」，左侧是一个黑色圆点——实际是 `Icon` 没有 `image` 字形时的回退圆点，图片内容完全不可见。
2. 收藏应该支持搜索功能，可以不用那么多检索功能，一个按文字匹配的就行。
3. 头像在对话串和私信中的大小偏小，用户测得约 35×35 像素，希望放大到 50×50 像素。
4. 隐藏设置页「数据与存储」中标记的「最近一次数据操作」和「从旧版本导入草稿」两项功能。

## 实现

### 1. 消息图片预览（Lead）

- 新增 `src/ui/hifi/components/AttachmentThumb.tsx`：图片附件复用正式 `attachment.previewImage` 命令（audience、实根与 sha256 原件核对均在 daemon）按需加载真实图片，`IntersectionObserver` 进入视口附近才请求，模块内最多缓存 8 张；失败/解码错误回退到新增的 `image` 线条图标，不显示破图。
- `MessageChangedFiles.tsx`：图片附件卡改为大预览布局（预览图在上、文件名/元信息与打开按钮在下），点击预览图调用共享预览；普通文档仍用文件图标，不发起图片请求。
- `GeneratedFiles.tsx`、`ThreadPage.tsx` 锚消息附件、`Room.tsx` 根消息附件：图片芯片显示真实小缩略图。
- `Icon.tsx` 增加 `image` 字形，消除此前「黑圆点」退化的根因。
- `components.css` 增加缩略图/图片卡样式，加载中与失败占位尺寸稳定。

### 2. 收藏文字搜索（Lead）

- `LibraryPage.tsx` 收藏页签新增共享 `SearchField`（`aria-label="搜索收藏"`，placeholder「搜收藏标题或链接…」）。
- 本地过滤函数 `savedItemMatchesText`：对标题、`ref`（消息/任务/交付/链接目标）与类型中文标签做大小写不敏感包含匹配；空关键词显示全部。
- 只在当前项目/全部项目范围已有的 `saved.list` 结果里过滤，不改变收藏数据、范围逻辑与链接收藏计数口径；无匹配时显示「没有匹配的收藏」。

### 3. 对话串/私信消息头像 50×50（Lead）

- `MessageView.tsx` 的消息头像 `Avatar` 尺寸由 22 改为 50；新增 `.avatar-50` 样式与 `Avatar` 类型。
- `MessageView` 同时服务回复串页、房间内回复串与私信消息列表，因此三处统一生效；私信左栏列表头像保持原尺寸，不受影响。
- 关闭「显示头像」时仍按原逻辑隐藏，不改变占位与成员色点回退。

### 4. 隐藏两项数据操作功能（Lead）

- `SettingsPage.tsx` 删除「最近一次数据操作」整行（含状态读取、错误显示与刷新按钮）和「从旧版本导入草稿」整行（含候选列表、重扫与逐项导入按钮），同时移除相关状态、导入调用与类型导入。
- 保留「备份全部数据」「使用已有数据或从备份恢复」「草稿保存」「重试 / 清理」「清理存储」「归档管理」「已移除的项目」。
- 旧草稿继承/候选登记的底层数据逻辑与 `draftPersist` 状态保留，只是不再在设置页提供入口；内部写日志不再引导用户前往已隐藏的入口。

## 验证

- `tests/unit`：68 文件 / **595 项通过**。
- `tests/browser`：70 文件 / **387 项通过**（含新增 `r192Feedback.test.ts` 5 项：图片预览标记与普通文档不请求、收藏文字匹配、设置两行不存在、消息头像 50px）。
- `tests/integration`：本地全量运行 249 文件（241 通过 / 2 跳过 / 6 失败）、2659 项（2600 通过 / 25 失败 / 18 预期失败 / 16 跳过）；25 项失败全部为既有本机未跟踪 R130/R180 混沌资产 20 项与 `coordinationManifestR154` 已知并发 5 项，与本轮 UI 改动无交集。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.hifi.json`：**0 错**。
- `node scripts/build-ui.mjs`：通过，仅既有 `import.meta` CJS 警告。
- `node scripts/capture-r192-ui.cjs --run=r192-review`：隔离数据 + 假运行时，**10/10 断言通过**；截图证据 `dist/r192-ui/r192-review/`：设置页无两行、对话串/私信图片显示真实缩略图、消息头像 width=50、收藏搜索只留命中项、清空后恢复 3 条。

### 独立复核（verify-r192）

- 独立复跑 `tsc`、70 个浏览器测试文件 387 项、`capture-r192-ui.cjs` 10/10，均通过；结论「有条件通过」，条件是旧 R68 历史脚本 `verify-daily-r68.cjs` 的 G2 仍等待已隐藏的旧导入面板。
- 已按复核意见补 `AttachmentThumb` 的 `img onError` 回退、`ThreadPage` 统一使用 `isImageAttachment`、清理已无 UI 的 `.settings-data-operation` 样式、更新内部草稿继承日志。
- 边界/风险：`verify-daily-r68.cjs` 属于 R68 历史一次性交互门，其 G2 依赖「从旧版本导入草稿」UI；本轮按用户要求隐藏该入口后该历史脚本不再适用，未纳入当前测试门禁。根消息卡片仅显示 20px 小缩略图（点击可打开共享预览），与消息内大图卡不同；旧 `MessageAttachments` 资源链路仍用文件图标。

## 交付

- 程序提交 `51ecad8`（含版本 `0.1.3-beta.37`）。
- 干净 worktree `dist/r192-source`（`51ecad8`，status 0，node_modules junction）构建：
  - 便携镜像 BUILD `bld_cbb914d94cdf0c5d`（clean，632 文件 MANIFEST 632/632 逐项 SHA256 复核通过）；
  - 安装器 BUILD `bld_78d6ed1b224c955e`；安装镜像 668 文件 MANIFEST 668/668 逐项 SHA256 复核通过，payload 审计 668 文件、privacyScanPassed=true、dataFilesIncluded=false。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.37-x64.exe`：**160,213,628 字节**，SHA256 `ef76f82c7be7988eade8209584255369e1eb5c86f001ff7d8a21bb4cef9095a4`，未签名；附 `.sha256` 与 `.release.json`。
- 未安装/升级/卸载、未启动安装版、未操作用户运行数据、零真实模型调用；未创建 GitHub Release。

## 边界

- 未修改 daemon 命令合同、schema 61、权限/audience 与数据；图片缩略图只调用既有只读命令。
- 设置页只隐藏入口，不删除已有数据、草稿或旧目录；备份/恢复/清理能力保留。
- 头像尺寸只作用于消息渲染；私信列表、成员管理等其它头像尺寸不变。
