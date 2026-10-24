# multi-agent-collaboration 与众说：源码比较

日期：2026-10-24。按用户要求，由新统筹本人阅读，未交给编码会话或子代理。

阅读版本：[Gambler134201/multi-agent-collaboration](https://github.com/Gambler134201/multi-agent-collaboration)，固定提交 [`4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf`](https://github.com/Gambler134201/multi-agent-collaboration/tree/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf)。源码只读副本位于 `D:/zhongshuo/dist/research-r106-multi-agent-collaboration-20261024/source`。没有运行它的安装脚本、服务、测试或模型，没有修改本机宿主或账户配置。下面的对方能力为源码与文档核对，不是本机实测。

众说的比较依据是 R105/V47 与本地正式 `src/` 实现。根 README 仍有早期原型描述，本次没有将其当作当前产品能力。

## 判断

它主要把现有主脑聊天接到外部执行端：主脑理解需求、派发和验收，执行端做具体调查、编辑和自测。众说把项目、房间、私信、成员交接和多阶段讨论放进自己的桌面应用与 daemon。两者有共同的任务账、身份隔离和结果验收原则，但承担的交互与调度范围不同。

对众说最有价值的是：把执行情况讲清楚、在请求回执丢失时查回原请求、在等待时减少无效模型调用，以及按实际能力解释候选模型。建议保留众说现有结构，优先吸收这些具体做法。

## 主要区别

| 维度 | 对方当前实现 | 众说当前实现及含义 |
| --- | --- | --- |
| 用户入口 | 浏览器工作台、Codex MCP、DSH 主脑插件；主脑经固定工具派发和验收 | Electron 内的多项目房间、对话串、私信、看板与文件入口；应用自己维护完整交互状态 |
| 组织方式 | 主脑—执行端任务链、退回整改、阶段/目标记录；主脑最终判断质量 | DIRECT/AUTO 与显式多阶段研讨；还有同伴 review/ask/reply、串内接续和父子任务整合 |
| 同时执行 | `panel_server.py:70` 明确为 `ThreadPoolExecutor(max_workers=1)`，当前公共队列串行 | `admission.ts` 有全局/项目/渠道/成员准入，worker 可分离消费多个在途回合；相同物理目录写入仍互斥。多成员协作不等于允许同目录并发写 |
| 执行端 | 代码包含 Pi、DSH、WorkBuddy、ZCode；主脑与执行端分别适配 | 正式适配器是 Codex app-server、Claude CLI，另有工程 Fake；DeepSeek 等是渠道所用模型，不是新增运行时 |
| 记录位置 | 任务文件与项目自己的 `.model-desk/records.db`，宿主/owner/聊天绑定 | 数据根 SQLite 中的多项目记录、事件、outbox、回执、run/turn、版本交付与写租约 |
| 结果确认 | 执行完成、自测和主脑独立验收分开；可保留执行器失败及主脑接手后通过 | 已有正式交付/版本/hash/可选验收以及失败历史保留；R105 的旧步骤接续结清属于相近原则 |
| 已知范围 | 当前文档明确队列串行；休眠、宿主退出、重启及跨工作区的唤醒不保证；不同执行端验证范围分别记录 | 本轮反馈说明房间/DM响应和导航仍有缺陷，正在 R106 按真实现场处理；现有契约和测试不能替代这次用户反例验收 |

来源：[当前执行端文档](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/EXECUTION_ENDPOINTS.md)、[队列与执行控制器](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/panel_server.py#L70)、[主脑 MCP](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/brain_mcp_server.py)。众说依据：`src/daemon/admission.ts`、`dispatchWorker.ts`、`deliberationRunner.ts`、`coordination.ts`、`src/persistence/commandGateway.ts`。

注意版本差异：仓库首页主要介绍 Pi/DSH/WorkBuddy，但 2026-10-24 更新与当前代码还加入了 ZCode。通用主脑早期文档的“九个工具”也是历史描述；当前 `brain_mcp_server.py` 的工具集合已经扩展。本次按固定提交的实现核对。

## 建议借鉴的具体做法

### 1. 将执行诊断压缩成用户看得懂的状态

它将准备、执行、自测、会话关闭、成果核对、结果记录等实际边界统一投影到 `execution_result`，明确区分未知、未要求、未运行和已失败，保留首个具体问题。相同投影供工作台、主脑工具和交付包读取，减少不同界面各自猜测。

众说已经有 `readExecutionBlocker`、成员最近活动、恢复等待与详情记录，值得做的是将同一事实前移到房间/私信的可见位置。例如“Codex 正在等待某任务释放”“已启动，最近一次活动在某时”“Claude 已完成，仍等另一位”，并提供打开对应任务/正常停止的入口。只有故障证据才显示故障，单凭长时间没有文字不能认定未执行或自动重跑。

源码：[execution_result.py](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/execution_result.py)、[共用展示组件](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/panel/execution-result.js)。

### 2. 在请求结果未知时，明确支持“查原请求”

它先持久登记请求，按责任归属和 request_id 去重，异常后提供只读 `brain_request_status`。返回请求已登记、找回原任务、未知等状态，同时明确查询不会派发或授权重发。写回执失败也不会误报为业务从未执行。

众说已经有 command receipts、payload hash、outbox 和 UNKNOWN 保护，底层原则相近。可取之处是产品出口：让用户或上层在“发送后没反应”时找回原任务和真实状态，避免换一个编号再次提交。若以后增加外部 MCP，更适合复用现有命令/身份体系来提供这个窄查询。

源码：[brain_requests.py](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/brain_requests.py)、[请求可靠性说明](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/REQUEST_RELIABILITY.md)。

### 3. 等待由本地程序负责，完成后通知一次

它的 `completion_wait.py` 由本地监听器读取任务记录，主脑结束当前回合，任务结束后向绑定的原聊天尝试通知。持久发送标记限制重复投递；发送结果不明确时不自动再发。这减少的是主脑为等待而反复发起回合的用量，本地仍在轮询记录，也不能保证固定节省比例。

众说已经有常驻 daemon，适合复用自己的事件和持久通知机制。可以吸收绑定原任务/原对话、完成或需处理时才通知、通知回执与任务成功分开的做法；不需要为了同一目的再增加一个宿主私有桥接进程。对方明确保留宿主退出/休眠/重启后的限制，不能据此承诺我们的跨重启通知已解决。

源码：[completion_wait.py](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/completion_wait.py)。

### 4. 给出模型选择理由，并区分能力声明和实测

它的路由保留候选与排除原因，考虑任务复杂度、上下文、明确预算、用户启用范围等；价格/任务偏好声明与实际能力测量分开。原生账户费用未知时不会写成零。其子代理能力证据还绑定执行器、模型、版本、渠道和预设，配置变了就失效。

众说已有三态 capability、身份快照、用量账与精确版本证据，可以借鉴候选解释和按执行端归组的设置体验。模型名称相同不代表不同适配器具备相同协议/能力；本轮实际 DeepSeek 子代理启动成功，也说明应同时记录工具声明和真实回执。自动切换模型会改变用户明确选择，若将来引入路由应以显式的自动分配意图为边界。

源码：[model_router.py](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/model_router.py)、[model_capabilities.py](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/.local-worker/model_capabilities.py)。

### 5. 项目架构地图可作为后续独立功能

它提供只读文件/符号地图，以及绑定源码 hash 的中文架构说明。打开地图不调用模型，说明关系与真实代码引用分开。当前自动依赖关系主要来自 Python AST，JS/TS/PowerShell 尚没有同等依赖解析，不能直接当成我们的 TypeScript 仓库自动分析能力。

这适合以后用于“让普通用户看懂项目”，优先级排在当前响应、协作收口与跨项目导航之后。本轮研究不扩为实现该功能。

来源：[项目地图](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/PROJECT_MAP.md)、[架构讲解格式](https://github.com/Gambler134201/multi-agent-collaboration/blob/4e73c4c84ee4b46e7f5f4b3b235e0e6ee53a1fcf/docs/PROJECT_ARCHITECTURE.md)。

## 与本轮施工的关系

R106 当前只实施用户指定的四项产品修复，开源研究单独交付。首要借鉴点是把“谁在执行、谁在等待、等什么、已有成果是什么”明确展示，并让未知请求可查回；其余执行端接入、外部主脑 MCP 和架构地图作为后续可讨论方向。本次没有把它的通知机制、串行队列或限制策略直接移植进众说。
