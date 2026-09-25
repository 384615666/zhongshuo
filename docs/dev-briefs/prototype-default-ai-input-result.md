# 原型施工报告：输入区默认交给 AI（prototype-default-ai-input）

> 日期：2026-09-25 · 工程：`D:\zhongshuo\hifi-prototype`
> 依据：用户确认的产品行为调整「取消任务/讨论常驻切换，普通发送默认与 AI 交流」
> 状态：**已实施并通过回归**；本报告如实区分"通过 / 失败 / 未验证 / 不适用"。
> 施工前快照：`D:\zhongshuo\archive\default-ai-input-pre-20260925\`（`src/`、`scripts/`、`electron/`、配置与 README 共 154 个文件 + `MANIFEST-pre.sha256.txt`）。
> 施工时工程**不是 Git 仓库**，所以以快照 + 哈希对账代替 `git status`。
> **2026-09-25 补记**：本工作区已在同日初始化 Git 仓库（根 = `D:\zhongshuo`，分支 `main`，初始提交 `84a2250`）——此后改动请直接走 Git，`archive/` 快照做法可退役（见 §9）。

## 1. 结论先说

- 输入区的「任务/讨论」常驻切换**已删除**（主池 / 任务串 / 私信都不再有）；**普通发送默认交给 AI**：主池发送＝创建新的根会话/任务（沿用默认协调者、@成员、@全体、多成员与 DIRECT/DELIBERATE 路由），任务串发送＝跟进当前任务，子任务定向跟进仍绑定原子任务目标。
- 「只想留字、不要回复」改为输入区 **⋯ 菜单里的一次性意图「仅记录，不请求回复」**：可取消、只对这一次生效、保存后自动恢复默认。
- **仅记录不派发**：不创建任务/运行、不调用模型、不计预算、不 steering；正文含 `@成员`/`@全体` 也不会唤醒 AI。证据是原型自己的**写入留痕**（新增的是 `LOCAL_ONLY:record.save`，没有对应的 `message.submit`）＋顶部「后台任务」计数不变。
- **历史记录串**（原"讨论串"，无 rootTaskId）是兼容例外：在其中回复**默认仍是"保存记录"**，不会因为删掉切换控件被静默唤醒；也不会被自动升级成 AI 任务。
- 「**调用模型 ≠ 授予执行权限**」这一条没有任何松动：四档权限、未验证档位禁用、预算与阶段屏障、运行中 steering/排队规则全部不变。

## 2. 施工前核对

| 项 | 结果 |
|---|---|
| AGENTS.md | 工程内与上级目录**均不存在**（全盘搜索无此文件），实际约束以 `hifi-prototype/README.md` 与 `docs/dev-briefs/*` 为准 |
| Git | `D:\zhongshuo` 与 `hifi-prototype` 都不是 Git 仓库 → 已做快照（见头注）+ 逐文件 SHA256 清册 |
| 与已有改动的关系 | 保留前几轮减负成果（顶部单行导航、无目标摘要栏、无另起任务按钮、预览去重等），未恢复任何已删除的常驻入口 |
| 相关文档 | `zhongshuo-development-design-v1.md`、`product-decisions-checklist.md`、`zhongshuo-workspace-preview-interaction-v1.md`、`dev-briefs/prototype-ui-declutter.md`、`zhongshuo-frontend-visual-implementation-v1.md` 全部按语义检索同步（见 §7） |

## 3. 数据契约与实现口径

### 3.1 意图模型（不重构任务引擎）

`InputIntent` 从 `'task' | 'discussion'` 改为 **`'ai' | 'record'`**（`src/data/types.ts`）：

- `'ai'`：走**既有**路径 —— 主池创建 RootMessage + Task + Thread（`submitMessage` 原有事务，任务号、reviewPolicy、预算推导、followers 全部不变）；线程内是既有跟进路径。
- `'record'`：复用旧的 discussion 非派发路径（无 `rootTaskId` 的记录串），消息带 `payload.recordOnly = true`。**没有新建笔记系统、没有改持久化契约、没有绕开预算与协作约束。**

`MessagePayload` 新增一个可选字段 `recordOnly?: boolean`：把"这条不是派发"写进数据（列表据此标「记录」，用例据此断言没有模型派发）。

### 3.2 仅记录的三条硬约束（都在代码里可查）

| 约束 | 实现位置 |
|---|---|
| 不创建运行、不计预算 | `submitMessage` 的 record 分支不触碰 `tasks`/`runs`/`budget`；留痕是 `LOCAL_ONLY:record.save`（不是 `message.submit`） |
| @ 了谁都不唤醒 | record 分支**不调用** `deriveRoute` 的路由结果、不写 followers/subscriptions；@ 只作为记录正文的一部分 |
| 不 steering、不停运行 | 线程内 record 分支不调 `steerSubtask`（Room 的定向只在 `sendAs === 'ai'` 时派发）；不改 attention/运行态 |

### 3.3 草稿：版本化迁移 + 刷新恢复

- `FullDraft.intent` 改为 **`sendAs: 'ai' | 'record'`**，并加 `v: 2` 与 `updatedAt`。
- **迁移规则**（`store.ts` 的 `migrateDraft`）：旧 `intent: 'discussion'` → `sendAs: 'record'`；旧 `task` → `'ai'`；其余字段（正文/@/附件/权限档位）原样保留。**迁移不会把旧讨论草稿变成一次 AI 发送。**
- **持久化**：草稿自本轮起落到 `localStorage`（键 `zhongshuo.drafts.v2`，24 小时后过期）。这是"刷新后尚未发送的『仅记录』草稿仍保持该意图"这条要求的实现方式 —— 此前草稿只在内存里，刷新即丢。
- 每个输入目标（主池 `room:<id>` / 线程 `thread:<id>` / 私信 `dm:<id>`）各有自己的草稿，切上下文不串线；"仅记录"是一次性意图，**保存成功后自动恢复**该上下文的默认（记录串回到保存记录、其它回到发送给 AI）；只切换意图不发送时不会复位。

### 3.4 文案

| 位置 | 文案 |
|---|---|
| 主池占位 | `发送消息，可 @ 指定成员…` |
| 任务串占位 | `跟进当前任务，可 @ 指定成员…` |
| 私信占位 | `给 X 发消息…`（沿用私信上下文，不变） |
| 仅记录态占位 | `保存记录 · 不会请求 AI 回复…` |
| 主按钮 | 交给 AI＝「发送」；仅记录/历史记录串＝「保存记录」 |
| ⋯ 菜单 | 交给 AI 时：本次方式 / 预算推导 / 权限档位 三段 + 菜单项「**仅记录，不请求回复**」；仅记录时：只留一句"本次为仅记录"的说明（不摆与本次无关的配置） |
| 仅记录标记 | 输入框上方 chip「仅记录 · 不请求回复」+ ✕（虚线边、中性色，与 @／附件的强调色区分） |
| 记录串标识 | 主池卡片上 `记录 · 无任务号`（原「讨论 · 无任务号」）；线程视图内不重复 |
| 记录串相关文案 | 「讨论信息」→「记录信息」（详情分组）；「讨论串没有任务、运行与验收」→「记录串…」，并把说明里**仍在指路"在输入区切到『任务』再发送"**的旧句改成"把要点引用或复制到普通输入里发送（本轮不做一键转换）"；「讨论串没有跟进名单」「这条讨论还没有携带附件」等同批改为「记录…」 |

**关于 placeholder 不再携带"方式"**：任务书建议的主池/任务串文案不含方式标签，因此「方式」（自动/共同研讨/直接）改为在 ⋯「本次运行设置 → 本次方式」与预算 chip 上可见（发送前仍可核对，未藏进菜单深处）。为此迁移了 3 条既有断言（smoke ×2、composer-clean ×1），改为读「本次方式」——**能力断言没有删除**。

## 4. 验证（任务书 §10 的 12 项）

### 4.1 新增专项：`scripts/verify-default-ai-input.mjs`（浏览器宿主，CDP 端口 9339）

`node scripts/verify-default-ai-input.mjs http://localhost:5284` → **39/39 通过**。逐项对应任务书要求：

| # | 任务书要求 | 本套件中的证据 |
|---|---|---|
| 1 | 主池普通发送走 AI 路由、只创建一个新根任务 | 根卡 +1、toast「任务 #15 已创建（AUTO）…」并进入该串、无残留分段 |
| 2 | 任务串普通发送仍跟进原任务 | 根卡数不变、消息落在原串、占位为「跟进当前任务…」 |
| 3 | @成员/@全体/多成员/私信路由正确 | @全体 → 预算 chip「最多 23 次」且发送后 toast「（DELIBERATE）」；私信占位与发送路径独立 |
| 4 | 仅记录不创建 run、不派发 | 顶部「后台任务」计数不变；留痕增量只有 `LOCAL_ONLY:record.save`，**没有 `message.submit`** |
| 5 | 仅记录正文含 @成员也不唤醒 | 同上（用例专门加了 @Claude 再保存，留痕写明"不唤醒/不计预算"） |
| 6 | 保存记录后恢复上下文默认 | 主池 chip 消失、按钮回到「发送」、权限档位重新可见 |
| 7 | 保存失败/切上下文/刷新恢复 | 刷新后正文与"仅记录"意图都在、按钮仍是「保存记录」；切到任务串无残留标记 |
| 8 | 旧 discussion 草稿迁移不自动调用模型 | 预置 v1 结构（`intent:'discussion'`）→ 载入即"仅记录"，且发送后留痕仍是 `record.save` |
| 9 | 记录里的附件仍可查看、audience 不扩大 | 记录串附件可开共享预览，来源仍是该房间 |
| 10 | IME / 双击 / 权限禁用 / 预算 / 运行中跟进不回归 | IME 组合态 Enter 不发送；同 tick 双击只创建 1 个任务；四档权限未验证档位仍禁用；「自动编辑」在仅记录期间**值不变**、取消后原值恢复 |
| 11 | 各上下文无残留常驻切换或无效占位 | 主池/任务串/记录串/私信/窄窗(900) 分段数均为 0、发送按钮完整可见、无横向溢出 |
| 12 | 不恢复已删除的常驻入口 | 顶部两行、另起任务、目标摘要栏都不存在；无残留分段 |

### 4.2 既有回归（在最终代码状态上复跑）

| 脚本 | 结果 | 宿主 |
|---|---|---|
| `verify-declutter.mjs` | **109/109 通过** | 浏览器 9336 |
| `smoke.mjs` | **28/28 通过**（迁移后多一条"仅记录不进派发路径"） | 浏览器 9334 |
| `verify-ux-round.mjs` | **16/16 通过** | 浏览器 9334 |
| `verify-dm-composer.mjs` | **29/29 通过** | 浏览器 9338 |
| `verify-visual.mjs` | **48 通过 / 0 失败 / 1 跳过**（+1 条"输入区不再有分段"） | 浏览器 9335 |
| `verify-visual-content.mjs` / `verify-workspace-preview.mjs` / `verify-quote.mjs` / `verify-four-fixes.mjs` | **19/0**、**33/0**、**8/0**、**10/0 通过** | 浏览器 9335 |
| `verify-round13/14`、`task-review`、`review-fixes` | **18/18**、**17/17**、**42/42**、**22/22 通过** | Electron 9333 |
| `verify-nav`、`sidebar`、`permission-modes` | **121/121**、**51/51**、**6/6 通过** | Electron 9333 |
| `verify-git`、`git-ops`、`member-create` | **32/32**、**16/16**、**21/21 通过** | Electron 9333 |
| `verify-composer-clean`、`progress-card`、`doc-urls`、`check-bold-markers` | **10/10**、**11/11**、**12/12**、**全通过** | Electron 9333 |
| `verify-desktop.mjs`（+ `verify-desktop.ps1`） | **8/8 通过**（系统对话框由 ps1 关闭） | Electron 9333 |

构建：`pnpm run build`（`tsc -b && vite build`）通过；`dist` 无源文件更新（产物即最终代码）。

> 上表是**在最后一次源码改动（记录串文案改名）之后**重跑的完整结果；文案改动涉及的套件（declutter / smoke / ux-round / default-ai-input / dm-composer 与全部 Electron 套件）都已逐项复跑，未出现因改名导致的失败。

### 4.3 用例迁移清单（**没有删除任何能力断言、没有放宽容差**）

| 脚本 | 迁移内容 |
|---|---|
| `smoke.mjs` | 「切到讨论」→「⋯ → 仅记录」；占位语义断言改文案；「讨论卡」→「记录卡」；**新增**"仅记录不进派发路径"（用留痕增量判定）；两条"方式预览"从 placeholder 迁到 ⋯「本次方式」 |
| `verify-declutter.mjs` | 记录串按钮「写入」→「保存记录」（语义：与"发给 AI"的「发送」区分） |
| `verify-composer-clean.mjs` | 主池占位从"发布新任务/模式"改为"发送消息 + @"；**新增**一条"本次方式仍在发送前可查（⋯ → 本次运行设置）" |
| `verify-visual.mjs` | §5.5"分段控件激活块不用渐变"从（已移除的）输入区分段迁到**图片预览的适应/原尺寸**；**新增**"输入区不再有常驻分段" |
| `verify-permission-modes.mjs` | 因草稿持久化会恢复上次档位，断言改回字面含义"点击禁用项**档位不变**"（不再隐含假设起始档位＝默认值） |
| `verify-dm-composer.mjs` | 房间输入区从"有两个分段按钮"改为"没有分段"，其余控件仍在 |

### 4.4 如实登记的问题与失败

| 事件 | 定性 | 处理 |
|---|---|---|
| `verify-declutter` 首轮 108/109（记录串按钮文案） | **预期内的语义变更** | 迁移断言（见上表），未放宽 |
| `verify-composer-clean` 首轮 8/9（占位文案） | **预期内的文案变更** | 迁移 + 补一条方式可见性断言 |
| `verify-permission-modes` 首轮 5/6（档位不是默认值） | **我引入的副作用**：草稿持久化会把上一次选过的档位带回来 | 断言改为"档位不变"（更贴合它自己的名字），并把它写进本报告 |
| `verify-visual` 首轮 1 失败（找不到 `.seg button.on`） | **我的迁移失误**：一度改用"单区域切换器"当替身，还顺手改了视口/导航，把后面布局断言的前提弄坏 | 改迁到**图片预览的适应/原尺寸**，验完关掉预览；现 48/0/1 |
| `verify-four-fixes` / `verify-workspace-preview` 曾各报 2 项失败 | **我并发跑测试抢同一个 9335 浏览器**导致（页面被另一个进程导航走） | 独占重跑：10/0、33/0 |
| `verify-default-ai-input` 首轮多处失败 | **脚本自身缺陷**：选择器拼接时多写的 `.trim()` 吃掉了空格（`.col-main.composer`）；冷启动 vite 未编译完就读状态 | 修脚本（等待就绪 + 正确拼接），`record thread` 用真实 id `thread_d1`；39/39 |

## 5. 截图证据（`screenshots-desktop/default-ai-input/`）

`node scripts/shot-default-ai-input.mjs`（桌面 Electron，1480×940 CSS @125%）：

| 文件 | 场景 |
|---|---|
| `d01-default-ai-send` | 普通发送：输入区只有回形针/@/⋯/权限档位/发送，**没有任务-讨论切换**；占位即"发送消息" |
| `d02-record-menu-entry` | ⋯ 菜单：本次方式/预算推导/权限档位 三段 + 最下面一项「仅记录，不请求回复」 |
| `d03-record-pending` | 选择后：「仅记录 · 不请求回复」可取消标记、主按钮「保存记录」、**权限档位已隐藏** |
| `d04-record-thread-default` | 历史记录串：默认就是「保存记录」+ 标记仍在（兼容例外） |

截图经视觉核对（逐张读像素）：**核心点全部通过，0 blocker**。核对提出的两条 warn 与两条 info 均为**有意设计**，如实记录在此：①「记录 · 无任务号」标识渲染在**主池卡片**上、线程视图内不重复（与减负的去重口径一致）；②记录串头部计数仍写「回复 N」（沿用既有单行导航的视图名，未改）；③「仅记录 · 不请求回复」/「保存记录」/「保存记录 · 不会请求 AI 回复…」三处措辞并存 —— 这正是任务书 §3/§4/§8 规定的分工（标记 / 按钮 / 占位）。

## 6. 未做 / 未验证 / 不适用

1. **未做**：不实现"把整条历史记录串自动转换成 AI 任务"（任务书明确本轮不做）；不做关键词猜测或自动分类；不新增全局设置页；不改任务隔离/路由/预算/阶段屏障/资源版本/私信 audience。
2. **未验证**：真实系统级 150% 缩放与触屏宿主（与前几轮相同，仍未跑）；`verify-visual.mjs` 的 1 项仍为脚本自身条件跳过（线程内没有人类发言样本）。
3. **不适用**：一次性诊断脚本里针对已移除的「任务/讨论」分段者（`compare-seg.mjs`、`inspect-seg-desktop.mjs`、`crop-buttons.mjs` 的 seg 部分、`crop-toolbar.mjs` 等）失去对象，本轮未跑、也不构成门槛。
4. **已知限制**：草稿持久化只存"输入目标 + 正文/@/附件/权限档位/意图"，不存"这条草稿对应的是新建还是跟进"之外的业务状态；若某个线程在刷新后不存在（原型刷新即回种子），该草稿不会被读到（键还在，24 小时后过期）。记录串里**不做**"把记录转成 AI 任务"的一键动作，需要时用现有附件/引用/复制能力在普通输入里显式发送。

## 7. 文档同步（按语义检索逐处落实，不只加新说明）

| 文档 | 同步内容 |
|---|---|
| `zhongshuo-development-design-v1.md` | 新增 **§0.22 v1.18**：明确列出被覆盖的旧规则（决策 21 的常驻切换、E6 的「任务/讨论」控件、"讨论只保存"作为默认档位）与覆盖后的口径，并写清"调用模型 ≠ 授予执行权限""仅记录不派发""历史兼容""共同研讨 ≠ 纯记录""草稿迁移与刷新恢复"；§4.2 的决策 21 与 E6 段落改写为现行口径（保留被取代的原文并注明） |
| `product-decisions-checklist.md` | 第 21 条加 2026-09-25 更新说明（覆盖界面口径，指向 §0.22） |
| `pre-development-checklist.md` | A3 加更新说明；E1 行改为「记录」消息可开回复串（已落地） |
| `zhongshuo-frontend-visual-implementation-v1.md` | §5.5 分段控件条目改为"`.seg` 只剩单区域切换器与图片缩放"；§5.6 收纳策略与发送按钮文案（记录串＝保存记录）、新增「仅记录」标记规格；selected 例外清单与 `.seg button.on` 说明同步 |
| `zhongshuo-workspace-preview-interaction-v1.md` | 线程「成果」、ASCII 布局图（新消息输入条）、"按既有产品决策保留"段、评论触发条件、根消息线程措辞全部同步 |
| `hifi-prototype/README.md` | 验证状态（新增 `verify-default-ai-input 39/39`，逐套件最新通过数）+ 新增「输入区默认交给 AI（2026-09-25）」一节 + 同步记录表两行 |
| 历史任务书 `dev-briefs/prototype-ui-declutter.md` | 未改写（历史文档）；其"输入区常驻意图切换"部分由本次任务书与设计报告 §0.22 显式取代 |

## 8. 复现命令

```bash
# 构建
pnpm run build

# 浏览器用例
npx vite --port 5284 --strictPort
node scripts/verify-default-ai-input.mjs http://localhost:5284   # 39/39
node scripts/verify-declutter.mjs        http://localhost:5284   # 109/109
node scripts/smoke.mjs                   http://localhost:5284   # 28/28

# 桌面宿主用例（Electron 调试端口 9333；本机 NODE_OPTIONS 需清空）
$env:NODE_OPTIONS=''; node_modules\.bin\electron.CMD . --remote-debugging-port=9333
node scripts/verify-round14.mjs
node scripts/verify-permission-modes.mjs

# 截图
node scripts/shot-default-ai-input.mjs
```

## 9. 补记：仓库初始化（2026-09-25）

本次施工的**开工快照仍按当时的无 Git 纪律保留**（`archive/default-ai-input-pre-20260925/` + SHA256 清册，用于对账）。施工结束后按用户要求初始化了 Git 仓库：

- 仓库根 = `D:\zhongshuo`（设计资料 + 原型同仓），分支 `main`，初始提交 `84a2250`「chore: 初始化仓库，导入当前工作区状态」（270 个文件）。
- 忽略规则见根 `.gitignore` 与 `hifi-prototype/.gitignore`：`node_modules/`、`dist/`、`*.log`、`archive/`、各截图目录与 `gui-test-screenshots/`、`.obsidian/`、`.qoder/`。
- **对新克隆的影响**：`dist/` 与 `node_modules/` 不入库，跑桌面宿主前需要 `pnpm install && pnpm run build`（本文 §8 的复现命令第一步就是构建）。
- 本报告的通过数不因有 Git 而改动；后续轮次的报告可以省去"施工前快照"一节，改为记录基线的 commit（本轮基线即 `84a2250`）。
