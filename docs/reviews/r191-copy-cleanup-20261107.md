# R191 前端提示去英文与去括号说明（2026-11-07）

## 用户反馈

用户在成员管理停用协调者时看到提示：

> 操作失败：VALIDATION_INVALID: 协调者不可停用（房间 自动协作 路由依赖协调者——如需更换请先调整协调者）

要求：现在各种前端提示里都还有英文，把英文都去掉，括号里的说明也去掉。

确认口径：只清提示类文案；错误码、命令名、枚举值与技术英文去掉，Git/AI/PDF/Word 等产品名保留；提示里的所有括号及括号内容去掉。

## 实现

### 中央清洗（Lead）

- `src/contracts/userFacingText.ts` 重构：
  - 先保护文件路径、文件名、URL 与 `run_123` 类身份，避免误伤；
  - 去掉 Electron/传输层包装、开头的错误码（含 `VALIDATION_INVALID:`）、带下划线错误码、命令名（如 `project.lifecycle unarchive`）与参数赋值（如 `scope=project`、`throughMessageSeq=12`）；
  - 阶段、状态、技术词映射为中文（UNKNOWN→结果待确认、HEAD→当前提交、CLI→命令行、runtime→运行渠道、fake runtime→模拟渠道、tokens→词元、KB/MB→千字节/兆字节等）；
  - 递归去掉中英文括号及内容，最后清理多余标点、空白与占位符。
- `tests/unit/userFacingTextR119.test.ts` 按新口径重写，覆盖错误码、命令名、参数、技术英文、括号、路径保留与系统事件边界。

### hifi 界面（hifi-copy-a / hifi-copy-b）

- 去错误码前缀：`MembersPage`、`MemberDetailPage`、`RoomPage`、`AddMemberModal`、`MemberManagementForms`。
- 提示/错误条/空态/tooltip/placeholder 去括号，改写为无括号短句；保留「结果未知」「输入已保留」「原件保留」「保留上次内容」等安全信息。
- 技术英文中文化：渠道标签去「CLI」、权限档位全中文、思考等级与用量单位、Git HEAD/diff/stash/base/ours/theirs/origin、hooks、runtime、agent、LAN、MB/B 等。
- 导出格式菜单改为「导出 Markdown/HTML/DOCX 记录…」「Markdown/Word 聊天记录」。
- 扩展 `tests/browser/userCopyR119.test.ts`：覆盖全部 hifi `*.tsx/*.ts` 的 toast/error/title/placeholder/detail 等提示上下文，断言无括号、无错误码插值、无未允许的技术英文。

### 旧界面与契约层（legacy-copy）

- `src/ui/renderer/app.js`：约 230 处提示/状态/空态/tooltip/placeholder 去括号与英文；Activity/Files/Agent/Notification/CLI/fake/HEAD/stash/base/ours/theirs/LAN/ISO/IANA/UTC/HH:mm/SHA-256/CA/UTF-8/PPTX/B/KB/MB 等改中文。
- `src/ui/main.ts`：数据操作、启动/后台服务、打开/另存为等用户可见文案；新增显示层最小清洗 `userFacingDisplayText`（去错误码前缀与括号），控制台日志不动。
- `src/contracts/callBudget.ts`、`document.ts`、`localDataCopy.ts`、`daemonIpc.ts`：用户可见校验/连接错误文案去掉 `true/false`、`usedCalls`、`.md basename`、`MB`、`commandId`、`ms`、`abort` 等标识与括号。

## 验证

- `tests/unit`：68 文件 / **595 项通过**。
- `tests/browser`：69 文件 / **382 项通过**。
- `tests/integration`：跟踪测试 242 文件通过、**2605 项通过**；仅本机未跟踪的 R130/R180 混沌资产仍为既有失败（20 项，与本轮无关，基线同样失败）。
- `tsc --noEmit -p tsconfig.hifi.json`：**0 错**。
- 根 `tsc --noEmit`：仅既有 `localOpen.ts` DOM 错误（基线同样存在）。
- 改动源文件 ESLint：99 项（97 errors / 2 warnings），与基线 99 项一致，**0 新增**。
- `node scripts/build-ui.mjs`：通过（7.9 MB hifi 包）。
- 本地临时扫描（未入库）：提示候选与可见英文均 0 条；括号剩余均命中代码模板括号或内部审计串。长期守卫在 `tests/browser/userCopyR119.test.ts`。

## 定向修复的旧断言

`memberChannelsR136`、`userCopyR119`、`userFacingTextR119`、`taskDetailsDisplayR78`、`preDispatchFailureFactsR107`、`threadReadingAids`、`r91MessageCollaboration`、`r102RecoveryHumanCopy`、`composerCallBudgetDisplayR114`、`composerWriteHintR129`、`gitReadPartialR78`、`callBudgetSettingsR98`、`dmInterruptedNoRunR106`、`threadStatusR132`、`r98PanelAdaptiveReading`、`settingsReadQueueR186`、`hifiThreadRound51`、`hifiUploadDeepLinkRound52`、`rootAttachmentsR76`、`r153ProductNavigation` 等按新口径更新；未放宽安全类断言。

## 边界

- 未修改 daemon 命令合同、schema 61、错误码枚举与数据；错误码只从用户可见提示中移除。
- 未改 AI 提示词（`src/contracts/prompts.ts`）、用户/AI 消息正文、文件内容与工具输出。
- 产品名、文件路径/文件名、URL、模型名按口径保留。

## 交付

- 程序提交 `2753a2f`（含版本 `0.1.3-beta.36`）。
- 干净 worktree `dist/r191-source`（`2753a2f`，status 0，node_modules junction）构建：
  - 便携镜像 BUILD `bld_6c15553c55284cce`（`dirty=false`，668 文件；MANIFEST-SHA256 独立复核 **668/668 通过**）；
  - 安装器 BUILD `bld_6a177bed4abd1838`；payload 审计 668 文件、`privacyScanPassed=true`、`dataFilesIncluded=false`。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.36-x64.exe`：**160,206,843 字节**，SHA256 `2cc020e9f891e5059021598cd466a7d3850d09e0355edf6036cd63966312f73a`，未签名；附 `.sha256` 与 `.release.json`。
- 未安装/升级/卸载、未启动安装版、未操作用户运行数据、零真实模型调用；未创建 GitHub Release。
