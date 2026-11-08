# R205 设置页去小字文案 + 去草稿设置

用户 2026-11-08 反馈：去掉设置页里的小字文案（示例：「外观、通知、AI、数据与帮助都在这一页；改动会即时保存并回读确认。」「主题、头像和名字；只在本机生效。」），并去掉草稿的几个设置。

## 诊断与范围

- 设置页（`SettingsPage.tsx`）有两级说明文字：
  - 页头 `.page-sub`：位于「设置」标题下方的一整句说明；
  - 每个分区的 `.settings-section-sub`：由 `SectionShell sub` 渲染的「一句说明」（5 个分区各一条）。
  这两类正是用户截图中标注的「小字文案」。
- 设置行内部的 hint（如「浅色、深色随时切换」「关闭后……」）是每个选项的功能解释，不属于装饰性说明，保留。
- 草稿相关 UI 集中在数据分区的「草稿」组：`草稿保存`（状态标签）、`data-zs-draft-recovery-note`（恢复提示）、`重试 / 清理`（重试保存 + 清理本地草稿 + 确认弹窗）。「清理存储」清理的是变更前像/过期回执正文，不是草稿，保留并移入「数据位置与备份」。

## 修复

- `SectionShell` 删除 `sub` 参数与 `<p class="settings-section-sub">`，5 个调用点删除 sub 文案。
- 删除页头 `.page-sub` 行（保留标题、搜索、分区 chips）。
- 删除「草稿」分组：草稿状态行、草稿恢复提示、重试/清理行、清理本地草稿确认 Modal；删除 `draftPersist`、`clearPersistedSnapshot`、`retryDraftPersistence`、`Modal`/`Tag` 等不再使用的引用。
- 「清理存储」行移入「数据位置与备份」分组，逻辑不变。
- 设置搜索索引：删除「草稿保存与重试」「清理本地草稿」，新增「清理存储」。
- 草稿保存/恢复在后端与 store 中不变，输入、发送、崩溃恢复行为不受影响；本版只改设置页展示。

## 验证

- 新增 `scripts/capture-r205-settings-copy.cjs`（隔离 Electron + 假运行时，**13/13**）：
  - 页头/分区小字元素数量为 0；
  - 六条示例文案全部不再出现；
  - 五个分区标题仍在；
  - 数据分组不含「草稿」，无草稿保存/重试/清理行；
  - 「清理存储」保留，数据位置与备份、归档与项目分组仍在。
  截图：`dist/r205-ui/r205-v1/01-settings-top-1324.png`（顶部：标题后直接是 chips 与外观卡片）、`02-settings-data-1324.png`（数据与存储：数据位置/备份/恢复/清理存储，无草稿组）。
- `tests/browser/settingsSinglePageR157.test.ts` 14 项通过（改为无小字、无草稿设置、清理存储保留、搜索索引合同）。
- 回归：`capture-r204` 41/41、`capture-r203` 7/7、`capture-r201` 21/21、`capture-r193` 25/25、`capture-r195` 41/41、`capture-r197` 23/23；已跟踪全量见交付记录。
- hifi tsc 0；未在本机安装/升级/卸载，未操作用户数据，未调用真实模型。

## 交付

- 版本 `0.1.3-beta.50`（numericVersion `0.1.3.50`），程序提交 PENDING_COMMIT。
- 干净 worktree `dist/r205-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `PENDING_BUILD1`（clean、PENDING_FILES1 文件 MANIFEST）、安装器 BUILD `PENDING_BUILD2`（安装镜像 PENDING_FILES2 文件 MANIFEST；payload-audit `runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.50-x64.exe` **PENDING_BYTES 字节**，SHA256 `PENDING_SHA`，未签名；PENDING_PUSH。

## 已知边界

- 只删除页头与分区级说明文字；设置行 hint 保留（功能解释）。
- 草稿设置入口删除后，用户不能再从设置页查看草稿保存状态或手动清理草稿；草稿自动保存/恢复仍按原逻辑运行。若以后需要"清理草稿"入口，应单独设计（例如放到输入框或数据恢复流程），本版按用户要求不保留。
- 「清理存储」不是草稿设置，故保留并归入数据位置与备份分组。
