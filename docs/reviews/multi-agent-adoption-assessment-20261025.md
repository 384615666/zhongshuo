# 开源项目功能吸纳评估与重复回复核查

日期：2026-10-25（Asia/Shanghai）。本次由统筹本人阅读源码，不委托编码会话或子代理研究开源项目。范围为问题核查与功能评估，未实施下表中的新功能。

比较基线：众说提交 [`47c7e596`](https://github.com/384615666/zhongshuo/commit/47c7e596d537b87a18ad2f8b217b218ae78f5a52)；对方提交 [`4e73c4c8`](https://github.com/Gambler134201/multi-agent-collaboration/tree/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf)。今日通过远端 HEAD 查询确认，对方仍为昨日阅读的同一版本；同时重新读取公开页面及本地只读源码副本。对方能力均是源码/文档核查，未运行其安装脚本、执行端、模型或测试。

## 一、截图中的 Codex 是否重复回复

**是，同一份调查内容的原答和补交版重复展示；两条并非逐字相同。**

从 R107 最终 UI 数据备份 `dist/review-r107-preflight-20261024/final-ui-state.sqlite` 只读核对，截图 #3 / #4 的来源如下：

| 回复 | 原回合 | 记录状态 | 正文 | 实际含义 |
| --- | --- | --- | --- | --- |
| #3，截图 19:59 | `turn_f748bff6-ece0-46af-9b1b-61b02e6aac41` | FAILED / stage_work | 9,970 字符，SHA-256 `f3ebc0c545e9b3fa389e562c1e6c09bd5958c22d89223c55634f475c7f4316b4` | 已做公开仓库调查并显示长答，随后交接对象 ID 未通过获准名单校验 |
| #4，截图 20:04 | `turn_7adb48f4-635d-4e3f-9f10-b73f97c9fd7d` | SUCCEEDED / format_repair | 8,315 字符，SHA-256 `0603de3a85dab0244218bbf378492f40696fb23c52506c29e6216aa5ab490e92` | 按原结果补交，改正交接并调整部分措辞；调查内容再次作为普通回复展示 |

`format_repair_workitems.frw_3aadeae3-e3b5-47b4-b69e-f34e47aa5a4d` 明确绑定上述 source_turn → consumed_turn，status=consumed。原 `turn.outputInvalid` 原因为“收件人不在本轮获准可用名单中”。原调查回合有 34 条 `tool.started`，补交回合为 **0**；补交没有重跑调查工具，但补交本身仍消耗了一次模型调用。

源码原因：[`dispatchWorker.ts`](../../src/daemon/dispatchWorker.ts) 的 `insertThreadReply` 用 turn 作为消息命名空间；精确正文去重只查询同一 turn。此次补交是新 turn，正文又有重排，因此原答、补交版都进入普通回复区。这是跨补交链的展示缺口，上一轮验收未覆盖，不能把它当成两次独立研究或正常的新答复。

建议行为：成功补交后，默认展示有效版；旧版折叠为“原答已补交，查看历史”，可核对失败原因、原文和来源。依靠明确的补交来源关系处理，不按模糊文本相似度删除消息；保留独立的真实调用/失败审计。补交失败时保留原成果并明确标注未完成。用户明确要求重做、正常追问、实质新版本与不同成员的独立意见仍正常展示。本轮没有修改源码或原数据来隐藏旧回复。

## 二、吸纳判断

优先把现有协作过程变得可理解、可追溯，再增加执行端和外部入口。众说已有 daemon、事件/outbox、命令回执、能力三态、调用预算和版本验收，适合扩展这些基础，避免另建一套平行调度与任务数据库。

P0：直接影响当前可用性；P1：随后完善的高价值功能；P2：后续扩展。工作量“小/中/大”是相对现有 TypeScript/Electron 工程的初步估算，包含正常异常路径与必要验证，不是对方作者的实测数据或确定工期。各项共享基础，不能直接相加。

| 编号 / 功能 | 对方已实现及边界 | 众说目前的基础与缺口 | 建议吸纳成什么 | 主要收益 | 优先级 / 工作量 |
| --- | --- | --- | --- | --- | --- |
| F1 执行状态与故障卡 | `execution_result` 共用投影，列出准备、执行、自测、关闭、成果核对和首个失败；没有证据的阶段标未知。[S1] | R106/R107 已有启动前失败、阻塞任务、成员活动、运行详情，信息仍分散；不是从零开发 | 房间/私信/串共用一张状态卡：谁在做、谁在等、等什么、上次真实活动、已有成果和对应处理入口 | 直接减少“它到底有没有收到/为什么另一位还在干”的困惑 | **P0 / 中** |
| F2 原请求找回 | `brain_request_status` 按原 request_id 和责任范围找回任务；查询不重派，not_found 不代表肯定没执行；只适用于正式 brain 请求通道。[S2] | 已有 commandId、payload hash、持久回执和 UNKNOWN 保护；需要易发现的用户出口 | 发消息后先保存请求引用；失联显示“查询本次发送”，找回原任务和状态，避免用户再建同一任务 | 防止重复派工、重复费用；降低“发不出去”的排障成本 | **P0 / 中** |
| F3 完成/需处理通知 | 本地 `completion_wait` 监听记录，向绑定的原聊天尝试通知；有持久发送标记，宿主退出/休眠后的唤醒不保证。[S3] | 已有常驻 daemon、实时事件、未读和待处理入口；不等同于已具备完整桌面通知 | 利用现有事件，完成或需要用户时显示一次应用/桌面通知，点击回原项目/原串；运行不变时保持安静 | 用户可以离开等待，不靠模型不断询问进度 | **P1 / 中** |
| F4 长工具输出外置、按需读全文 | `context_manager` 保存完整结果，给模型首尾预览、大小/行数和全文位置；记录字节变化，不假称精确 token 节省。[S4] | 已有受控附件、完整详情和有界输入；房间“五行折叠”只是视觉处理，不会自动缩短模型上下文 | 将可控的长工具结果转为受管 artifact，提供摘要、全文引用和按段取回；先核对两种 CLI 是否支持原生读取链路 | 降低长日志挤占上下文、重复传输和遗失关键信息的概率 | **P1 / 中至大** |
| F5 路由预览与候选理由 | `brain_route_preview` 不派发；路由器列出候选、排除原因、复杂度/容量/预算预测；原生账户未知费用不当作免费。[S5] | 已有成员选择、DIRECT/AUTO、运行时模型目录与准入；没有同等清晰的任务级候选解释 | 发送前可选“为什么交给这个成员”；先做解释/预览，再另行提供明确选择的经济/均衡/质量自动分配 | 让模型分配可理解，减少贵模型做简单工作和不合适模型被选中的情况 | **P1 / 中至大** |
| F6 能力说明与实测凭据 | 区分用户声明、策略、真实验证；证据绑定执行器、版本、模型、渠道、预设等身份，变化后不能沿用。[S6] | 已有 supported/unsupported/unverified、图像/工具能力和配置指纹，不应再建一套认证体系 | 成员页补上“可读图/可编辑/可续接”的证据来源、验证时间、适用版本与失效原因；按需做有提示的最小验证 | 减少“配置成功就以为可用”和配置变动后的误判 | **P1 / 小至中** |
| F7 按执行端归组配置与非推理预检 | Pi/DSH/WorkBuddy/ZCode 独立卡片和开关，模型连接归组；首次预检说明项目、绑定、可派发候选；开关开启不代表可运行。[S7] | 成员管理已有 Codex/Claude、执行程序检查、模型目录和高级权限，但配置入口仍以成员为主 | 设置中集中管理执行端安装/连接，成员引用它；新增成员时显示就绪原因，避免同一运行时被重复配置 | 降低首次配置和维护成本，清楚区分模型、渠道与执行程序 | **P1 / 中** |
| F8 按验收项展示独立证据 | 主脑派发 acceptance 条目，交付区分执行器自报、指定自测和逐条独立验收；主脑接手完成不算执行器独立成功。[S8] | 已有精确版本/hash、交付验收、返工和研讨互评；缺口是面向用户的逐项检查说明 | 在现有交付中加可选验收清单：每项结果、证据、检查者、适用版本；小问题/寒暄不强制生成清单 | 让“完成”与“已经核验正确”更容易区分，不只看一段总结 | **P1 / 中** |
| F9 费用预测与用量看板 | 路由含单价快照、预计输入/输出/次数与返工风险；已知单价时可做金额预算，原生账户未知则明确未知。[S5] | 已有调用预算、真实调用账和 usage 的 reported/estimated/unknown；不等同于统一账户余额或可靠金额硬上限 | 先汇总本任务/本项目/本日的已报与估计用量，显示价格来源；只有接口足以核对时再扩展金额预算 | 看清哪类任务消耗大，为以后自动分配提供依据 | **P2 / 中至大** |
| F10 可交互项目地图 | 文件/符号/关系与中文模块图；说明可附源码 hash。自动依赖解析主要是 Python AST；JS/TS 当前没有同等导入解析，图不是运行调用链。[S9] | 已有项目文件、Git、分析基线与文档；当前没有同等架构地图入口 | “文件与 Git”增加项目概览，先用 TS compiler API 解析本项目 TS/JS，再接中文职责说明与失效标记 | 帮用户看懂项目，也方便定位修改会影响哪里 | **P2 / 大** |
| F11 符号索引与上下文导航 | 受限文件索引、函数/类、hash、新鲜度检查；与上下文材料共同提供定位；没有承诺完整业务理解。[S4][S9] | 分析基线主要给文件清单/hash，输入装配有范围和截断；不能等同于符号/依赖索引 | 与 F10 共用索引，模型先查文件/符号，再按需读正文；显示未覆盖和过期范围，不默认全仓塞入 | 大工程定位更准确，减少重复扫描与无关上下文 | **P2 / 中至大** |
| F12 更多执行端 | 已有 Pi、DSH、WorkBuddy、ZCode 适配；WorkBuddy/ZCode 的原生账户与部分模型有作者实测，但覆盖版本/宿主有限，ZCode 依赖非公开桌面服务。[S10] | 正式适配器是 Codex app-server、Claude CLI；DeepSeek 是渠道模型，不是独立执行程序 | 先评估有稳定公开协议的 Pi/DSH；每次只接一种并验证停止、只读、输出、续接、用量。WorkBuddy/ZCode 单列维护风险 | 丰富账户/本地模型选择；价值取决于用户实际使用哪些执行端 | **P2 / 大** |
| F13 给外部 Agent 使用的众说接口 | 通用 brain MCP 提供预检、候选、派发、查状态、交付、验收/整改；项目和责任身份由可信启动上下文绑定。[S8] | 众说已有本地命令网关/身份/事务，未见同等对外主脑 MCP 产品入口 | 在现有网关外封装窄 MCP：外部 Agent 创建/查询众说任务，结果仍落原房间/串，不开放任意内部命令 | 让众说成为现有编码助手可调用的协作服务 | **P2 / 大** |

## 三、建议的落地顺序与验收点

| 顺序 | 具体范围 | 可检查的完成标准 |
| --- | --- | --- |
| 先处理当前重复展示 | 按补交链组织原答/有效版，不做全局相似度合并 | 同 turn 重放仍去重；跨补交只默认展示有效版；失败原文可查；补交失败不藏成果；正常追问和不同成员意见不被合并 |
| 第一组：可用性 F1/F2/F3 | 统一状态卡、发送引用找回、事件通知 | 0-run 失败、排队、在途、未知、成功各有真实原因；断线只查询不重复派发；通知点击返回原串，事件重放不重复弹出 |
| 第二组：上下文与选择 F4/F5/F6/F8 | 长输出按需读取、分配解释、能力凭据、验收清单 | 完整材料可找回；关键错误/退出码可见；预览零派发；手动指定不被自动换；声明和实测分开；验收绑定当次版本 |
| 第三组：配置与费用 F7/F9 | 复用已有 runtime 管理、调用账，补充连接归组与用量说明 | 配置修改不偷偷升级旧任务；未知费用保持未知；费用估计与提供方账单分开，不能靠显示估计值承诺硬限额 |
| 后续扩展 F10/F11/F12/F13 | 共用代码索引，逐一接执行端，再考虑外部入口 | 地图不声称完整调用链；不通过导航扩大写权限；新执行端完成取消/恢复/范围负例；外部查询/派发保持原项目与责任归属 |

F1/F2/F6/F8 主要补齐现有能力的出口与细节；F3/F4 是较明显的体验/效率增量；F10–F13 属于新能力和适配范围扩张。建议不在当前可用性缺口仍存在时同时开四类扩展。

## 四、无需照搬或暂不吸纳的部分

- **固定主脑 + 廉价执行器不必替换众说的对等协作。** 可以作为可选分配模式，但用户指定双成员独立分析时，保留真实独立判断。不能把“主脑模式”理解为所有任务一律多派一步。
- **串行总队列不搬。** 对方当前 `ThreadPoolExecutor(max_workers=1)`，并行仍未上线；众说已有多维准入和相同目录的写入互斥，应复用已有约束。
- **私有宿主桥接不整体搬。** 特别是 ZCode 非公开桌面服务，维护成本与版本依赖需要单独评估；不能把读取到模型列表当作任务执行已验证。
- **不重复开发已有的版本交付、失败保留、能力三态、次数预算、恢复保护。** 可借鉴表现和细节，仍以众说现有账本和来源关系为准。
- **离线 doctor、诊断包导出、全自动回放、验收后文件变动提醒不计作对方已有功能。** 对方执行结果文档明确把它们列为未包含范围。多模型并行、跨休眠/重启唤醒也不能当成熟能力来引入。

## 五、源码与现有实现依据

以下 S1–S10 均固定到本次实际读取提交；文档中的“已验证”是对方作者的记录，不能转述为我们在本机跑过。

- [S1 执行结果文档](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/EXECUTION_RESULTS.md)；[共用投影源码](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/execution_result.py)。
- [S2 请求可靠性](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/REQUEST_RELIABILITY.md)；[请求日志源码](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/brain_requests.py)。
- [S3 本地完成监听](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/completion_wait.py)。
- [S4 上下文索引与工具结果外置](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/context_manager.py)。
- [S5 路由、成本与候选排除](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/model_router.py)；[路由预览工具](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/brain_mcp_server.py)。
- [S6 能力声明与验证身份](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/model_capabilities.py)。
- [S7 执行端卡片](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/EXECUTION_ENDPOINTS.md)；[共用预检与宿主边界](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/CROSS_HOST_FEATURES.md)。
- [S8 主脑接口与独立验收](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/MAIN_BRAIN_CORE.md)；[当前工具定义](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/brain_mcp_server.py)。
- [S9 项目地图及覆盖限制](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/PROJECT_MAP.md)；[架构说明格式](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/PROJECT_ARCHITECTURE.md)。
- [S10 项目入口与当前支持边界](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/README.md)；[WorkBuddy](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/WORKBUDDY_EXECUTOR.md)；[ZCode](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/ZCODE_EXECUTOR.md)。

众说主要核对：`src/daemon/dispatchWorker.ts`、`preDispatchFailure.ts`、`taskDetails.ts`、`turnInput.ts`、`baseline.ts`、`runtimeCatalog.ts`、`admission.ts`、`src/persistence/commandGateway.ts`、`src/contracts/runtime.ts`、`budget.ts`、`src/ui/hifi/MembersPage.tsx`、`pages/SettingsPage.tsx`、`components/TaskDetailsFacts.tsx`。已有“reported/estimated/unknown”用量质量、调用预算与配置指纹，不能把本次建议写成底层完全缺失。

本轮仅新增评估文档与续工说明；未重跑或宣称新增产品测试通过，未调用业务模型，未修改原消息/数据库、成员设置、V50 包或运行中的 UI。
