# R64 原型还原差异矩阵与施工记录（2026-10-06）

基线`78e3ed7`（R63 收口）；目标=按已批准 hifi-prototype 还原正式界面（review-r63-prototype-parity §5）。
本文件是 R64 的**差异矩阵**（逐页：原型行为 / 当前行为 / 后端能力 / 偏差 / 修复动作 / 状态标记）与施工日志。
状态标记：`已还原` / `真实能力限制` / `用户批准例外` / `待修`。

## 0. 端口架构决策（R64 定）

1. **AppState 视图模型 = 唯一边界**：正式 store 已是 `HifiState = AppState + HifiExtension` 且 selectors.ts 与原型同源同形。做法=原型页面组件原样移植，数据在 loader 层水合进 AppState 字段；mock actions 换成正式命令适配层（`data/actions-formal.ts`）。正式产品不 import 任何 `hifi-prototype/` 模块、不带 seeds/mock-tree。
2. **保留的正式合同（不回退）**：未知信封/出站账本/幂等、草稿持久化+保全锁定、settleOutbound 统一清算、audience/图片能力门、收藏切换、文件引用卡+独立摘录、返工两步走、停止三重绑定、阅读门、Compose 异步回执。Composer 用正式版（1400 行，含上述合同）。
3. **布局规则原样拷贝**：lib/layout.ts（resolveLayout/SIDEBAR_WIDTH）、lib/threadNav.ts（三视图+详情分组+旧深链兼容）、lib/panels.ts 如原型字节移植。
4. **预览合并**：原型 PreviewPane 壳（标签行/工具行/来源行/正文/引用流程/收起放大）+ 正式渲染体（preview/PreviewPane.tsx 的 Text/Image/Pdf/Office 组件按 attachmentId 异步装载）。资源登记表 s.resources 由正式适配层写入（真实 attachmentId/hash/revision/audience——来自服务端回执，不伪造）；openWorktreeNode 换真实项目文件读取。
5. **能力缺口呈现**：后端没有的能力在原型位置显示禁用原因（`真实能力限制`），不用工程说明面板替代整页。

## 1. 差异矩阵

### A. 壳（App.tsx：侧栏/项目树/标题栏/路由）
| 项 | 原型 | 日常v1 | 后端能力 | 修复动作 | 状态 |
|---|---|---|---|---|---|
| 侧栏项目树（可见项目/展开/置顶/房间行+任务状态标记） | ProjectTree + navPrefs 持久化 | 简化导航列表 | project.open 单项目；无多项目注册表 | 单项目如实显示一棵树；多项目=真实能力限制（导航偏好持久化保留，扩展位禁用说明） | 已还原(单项目范围) |
| 标题栏 | TitleBar（窗口控制/主题/连接） | 已有 r55 正式版（断连/重连） | 保持 | 原型布局+正式连接态 | 已还原 |
| 顶部状态条/房间 tabs | Room 内 thread-tabs（对话池/任务看板/文件） | 无 | room.pool/tasks | Room.tsx 移植 | 已还原 |
| 命令面板 | CommandPalette | 已有正式版 | 保持 | 保留正式版 | 已还原 |
| 启动恢复面板 | StartupRecovery modal | RecoveryPanel 常驻 | 正式恢复合同 r56-58 | 原型位置+正式事实 | 已还原 |
| 欢迎页/打开项目 | WelcomePage/OpenFolderModal | 简化欢迎 | pickFolder+project.open | 原型布局+正式装载 | 已还原 |

### B. 房间与回复串（Room.tsx 3040 行 → 正式 RoomPage 146+ThreadPage 647）
| 项 | 原型 | 日常v1 | 后端能力 | 修复动作 | 状态 |
|---|---|---|---|---|---|
| 宽窗打开回复串 | 主池+context-thread 并列（L2），收起回主池；各自草稿 | `/thread/:id` 整页跳转 | thread.get/history 已有 | Room.tsx 移植+loader 水合 threads/messages/tasks | 已还原 |
| 主池卡片 | root-card（任务号/主状态+下一步/正文/回复预览2条/附件/整卡可点/⋯ 关注静音复制链接） | 简化卡（无预览/无次级菜单） | room.pool（+taskTitle 投影补齐） | 移植 RootCard；关注/静音=真实能力限制（后端无 thread_subscriptions 命令→按 room.pool muted/followed 只读显示） | 已还原(关注静音只读=真实能力限制) |
| 线程面板 | 回复/成果(附件)/详情三视图+详情分组chip；首条未读分隔线；新消息pill；引用/更正插入 | ThreadPage 整页+自绘标签 | thread.* 已有 | 移植 ThreadPanel；actions 换正式（标读门/停止/验收/返工沿正式合同） | 已还原 |
| 线程详情分组 | 任务概况/参与成员/活动与进展/运行/交付验收/研讨 | 部分有（交付/返工） | task.get/pendingDelivery/reworkPending | 概况+成员=真实数据；活动=过程说明(如有)；运行详情=真实能力限制(activeRun 仅 id/status)；研讨=真实能力限制 | 已还原(分组按能力出现) |
| 房间任务看板 | ROOM_GROUPS 分组卡 | 无（看板在别页简版） | room.pool taskStatus | RoomTasks 用主池卡数据 | 已还原 |
| 房间文件 tab | 本房间附件/成果/改动集汇总 | 无 | 线程附件摘要 | 汇总线程附件（真实）；改动集=真实能力限制 | 已还原 |
| 房间设置/成员/归档 | RoomSettings 抽屉 | 无 | room.update/archive 无后端命令 | 表单显示+保存=真实能力限制（保存按钮禁用+说明）；成员名单只读显示 | 已还原(编辑=真实能力限制) |
| 窄窗/分隔条/单区域 | useNarrow/useThreadWidth/resolveLayout/单区域切换 | 无 | - | 原样移植 | 已还原 |
| L3/L4 预览并排 | previewSide/宽度对调/主池被挤掉出口 | 固定浮层 | - | 移植+正式渲染体 | 已还原 |
| Composer | 原型 Composer | 正式 Composer（合同全） | - | 用正式 Composer（外观类名同原型壳） | 已还原(用户批准例外：合同增强) |

### C. 共享预览（PreviewPane 987 → 正式 602 固定浮层）
| 项 | 原型 | 日常v1 | 修复动作 | 状态 |
|---|---|---|---|---|
| 多标签/激活/中键关/已打开列表/同名消歧 | 有 | 无单目标 | 原型壳移植 | 已还原 |
| 工具行（阅读方式/换行/图片缩放/引用到 X/⋯） | 有 | 窄宽展开/引用/摘录 | 原型壳+正式引用卡/摘录动作（r61 合同保留） | 已还原 |
| 来源行（origin+openedFrom+audience） | 有 | idLine | 原型行+真实身份 | 已还原 |
| 正文渲染 | mock content | 正式 pdfjs/pptx/docx | 原型壳内嵌正式渲染组件（异步装载） | 已还原 |
| 收起/重开/放大/单区域 | 有 | 无 | 原样移植 | 已还原 |
| 引用选区 | 有 | 无 | 选区→摘录队列（正式 r61 通道） | 已还原 |

### D. 文件与 Git（pages-misc FilesGitPage → 正式 FilesPage 380 简化）
| 项 | 原型 | 日常v1 | 后端能力 | 修复动作 | 状态 |
|---|---|---|---|---|---|
| 目录树/改动集列表+右侧共享预览/详情 | mock-tree+fg-pane-list/detail | 根一层文件芯片+四组信息面板 | **新增 `project.files` 只读投影**（daemon：安全根内列目录，含 size/mtime/dir，深度受限） | 原型布局+真实树 | 已还原 |
| 项目选择/文件-Git 切换/仓库摘要条 | 有 | 无 | 单项目+isGit | 单项目如实；切换记忆保留 | 已还原(单项目) |
| 窄窗返回列表 | useNarrowPane | 无 | - | 原样移植 | 已还原 |
| 文件预览来源 | 共享 PreviewPane | 浮层 | project.file.read | 树节点→真实读取→预览（文本/图片/PDF/Office 走 attachment 通道或文件读取） | 已还原(工作区文件=真实读取投影) |
| Git 状态/暂存/提交/推送 | GitPage 完整 | 仅历史+commitDiff | git.history/commitDiff 只读（R62）；status/stage/commit/push 无 | 历史+选父 diff=真实；状态/提交/推送=真实能力限制（原型位置禁用说明） | 已还原(读真实/写未接) |
| 文件页引用→选择讨论目标 | 原型「选择讨论位置」流程 | 直接进当前草稿 | 正式 audience 边界 | 目标选择器（房间/线程/私信列表来自真实数据）→ addFileRefToDraft（跨会话拒绝） | 已还原 |

### E. 设置（SettingsPage+7 分区 → 正式 196 纵向面板）
| 项 | 原型 | 日常v1 | 后端能力 | 修复动作 | 状态 |
|---|---|---|---|---|---|
| 七项导航+搜索+设置行+宽度折叠 | 有 | 无 | - | SettingsPage/SettingsRow 移植 | 已还原 |
| 通用（启动打开项目/语言…） | 有 | 无 | app.settings.get(ui.autoOpenProjectPath) | 启动项目=真实读写；其余=真实能力限制 | 已还原 |
| 外观（主题） | 有 | 无 | localStorage | 真实 | 已还原 |
| 通知 | 有 | 无 | 无后端 | 原型位置+禁用说明（模拟态不带入） | 已还原(真实能力限制) |
| AI 工具（runtime） | 有 | 成员页绑定 | runtime.status/member.setRuntime（r63） | r63 绑定表单放原型层级 | 已还原 |
| 连接与设备 | 有 | 无 | app.identity/CA 只读 | 本机身份真实显示；配对/吊销=真实能力限制 | 已还原 |
| 数据与存储 | 有 | 草稿面板 | 数据根/快照健康（r63） | 原型层级+r63 面板 | 已还原 |
| 帮助与关于 | 有 | 无 | BUILD 身份 | 真实版本信息 | 已还原 |
| 项目设置（独立页） | ProjectSettingsPage | 设置页内嵌段 | 无后端写 | 原型布局+只读展示+能力限制 | 已还原(真实能力限制) |

### F. 其余页面（本批列差异不重写）
| 页 | 原型 | 正式 | 状态 |
|---|---|---|---|
| DM | Dm.tsx 902（三列/预览集成） | DmPage 469（结构接近但简化） | 待修（下批；DM 主链路已可用） |
| 全局看板/活动/收藏/搜索 | pages-task/secondary | Board/Activity/Library 简化版 | 待修（下批） |
| 归档页 | ArchivePage | 无 | 待修（依赖项目归档后端=未接） |
| 成员页 | pages-misc MembersPage | r63 MembersPage（绑定表单） | 已还原（r63 表单放原型卡片结构——用户批准路径） |
| 任务详情/研讨/运行页 | pages-task | 线程详情分组内嵌 | 已还原(线程内嵌形态=原型 §8 定案) |

## 2. 施工日志（分小提交，全部完成）

- [x] 差异矩阵基线（本文件）
- [x] lib 移植（layout/threadNav/panels/navPrefs/actions-nav）+ actions-preview 正式化（引用=r61 引用卡/摘录独立/评论=源会话仅记录真实提交/工作区资源登记）
- [x] loader 水合（threads/messages/tasks/readStates/subscriptions/taskDeliveries/runs ← roomPool/thread 快照）+ room.pool 补 taskTitle；selectors 未装载线程按卡片兜底
- [x] Room.tsx 原样移植（宽窗 L2 并列/房间三页签/线程三视图+详情分组/次级菜单/窄窗/分隔条/L3L4；正式链=出站账本/停止三重绑定/验收返工/关注静音/收藏/表情/导出/room.create；未接命令禁用说明）。**修：装载 effect 移回 early-return 前（重开即崩溃反例）**
- [x] PreviewPane 合并（原型壳+正式渲染体+legacy 单目标桥接；工作区文件=project.file.read）
- [x] daemon project.files.list 只读投影 + FilesGitPage 真实目录懒装载 + GitPage 全真接线（status/branch/history/commitDiff 选父/stage/stageTask/unstage/commit/commitPreview/undo/push/pull/checkout/branch.create/conflict.*）
- [x] Settings 七分区（壳=原型导航+搜索+SettingsRow；真实=启动项目回读/主题/runtime 绑定+派发防护/数据根+草稿快照+清理/远程监听/诊断）。**修：SettingsRuntime selector 稳定引用（useSyncExternalStore 契约）**
- [x] App 壳移植（原型侧栏三段式+路由表 /project/:id/room/:id?thread=；boot 三态/接管/深链/恢复面板保留；旧路由归一；.app 带 data-zs-boot）
- [x] 交互门 verify-parity-r64.cjs **ok=true**（房间页签/L2 并列/双输入区/详情分组/线程菜单/收起/真实树 4 条目/工作区预览装载/真实 git 历史/七导航/runtime 分区；real_calls=0、优雅退出、零残留）
- [x] 视觉门 dist/desktop/visual-gate-r64/（原型×正式成对 7 场景 + manifest 记录视口/DPR/主题与边界说明）
- [x] desktop-daily-win-v2 = bld_33e7c538c32dfa09（commit 4218a360，dirty=false，清单 591/591）——verify-desktop-daily 全绿（欢迎无 seed/绑定表单/提示消失/仅记录+草稿重开/realCalls=0）
- [x] 全量回归 894/894 + 主/hifi 双类型门 0 错

### F 节修订（Git 矩阵升级）
矩阵 D 节初稿把 Git 状态/提交/推送标为「真实能力限制」——实际 daemon 命令面完整（gitWrite 全链），本批已全真接线并经交互门验证（真实 git 历史 + fixture 提交可见）。状态=**已还原（读+写全真；ahead/behind 与 upstream 跟踪、remotes 列表投影未装载——状态条如实显示「没有上游分支/没有配置远端」）**。

## 3. 验收门

- 交互门：同入口同操作同可见结果（区域/路由/焦点/滚动/选中/草稿+真实命令/DB）。
- 视觉门：原型 vs 正式成对整窗截图（同尺寸/DPR/主题/状态/内容密度），最少场景=主池/宽窗回复串/详情成果/共享预览/文件树选择与窄窗返回/Git diff/设置导航与配置行。
- 零真实模型调用；旧包/用户数据/RESULTS/CA 不动；A+Word 不变、B 不集成。
