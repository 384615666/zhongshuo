# R83 六项体验修复与 v22 工程候选

2026-10-14。工作区 `D:\zhongshuo`，分支 `codex/full-implementation`，基线 `0e0257c`。冻结运行源码 **7af617e68697e549cab16bf96d427a67c7429a79**，clean BUILD **bld_06a536e62475c22f**。后续提交只补 QA/记录，不冒充新的构建源码。

实际候选入口：`D:\zhongshuo\dist\desktop\desktop-daily-win-v22-rc6\start-desktop.bat`。旧 v22 及各阶段包原地保留；首次 v22 失败，不能误开作最新候选。最终副本证据根：`dist/desktop/review-r83-v22-rc6-20261014`。

**主要六项业务路径通过；完整放行总门仍为 false。** `corePass=true` 与 `pass=false` 分开记录：原生标题栏拖动没有取得可靠位移证据，不宣布首版全部通过。用户验收尚未发生。没有账号/余额阻断，剩余门是 Windows 原生移动验证。

## 六项根因、实现与同 BUILD 验收

| 反馈 | 已确认原因及修复 | 最终实证 |
|---|---|---|
| 项目菜单卡死 | 自绘浮层在 drag 标题栏内，遮罩/关闭链与共享 Menu 分离。改共享 body portal、no-drag、外点排除触发入口、Esc/导航/其他浮层关闭及焦点恢复；观察器有界收拢。 | 实际 BAT，无边框窗口，原生鼠标搜索/外点、Esc、重复入口、选择项目、导航离开，随后原生输入未发送草稿；最大化/还原均通过。不是以 element.click 代证。拖动另列未验证。 |
| 默认完整权限、自动图片 | 原权限信封 false/空根、Claude 固定禁写工具、Codex 未映射沙箱以及历史图片认证门。新真实任务默认原生完整权限：Claude bypassPermissions，Codex danger-full-access / dangerFullAccess；显式 plan 与旧任务快照不提权。配置/模型/权限/effort/cwd 共源并派发前复查，图片实际字节自动输入。 | Claude/glm-5.3-flash 真正创建 math.mjs、math.test.mjs、README.md，Bash 执行测试；项目外自有合成目录 outside.txt 写入/读回。正文带图蓝底黄圆、DM 图片-only 绿底红三角均识别；PNG 实际解码 320×200。额外一次显式 plan 请求未创建 readonly-check.txt。旧“当前只读”误导提示也已修。 |
| 思考等级 | 保存/模板/adapter 未连通。Claude 从本机 --help 提取真实 low/medium/high/xhigh/max，Codex 正式 model/list 读取当前模型支持值；保存校验、运行快照、续接和模板独立快照共源。 | 原生 CLI 实际 high 参数；UI medium→high 保存回读，模板新成员独立、重开仍 high。本机 Codex 元数据与协议回放通过，未调用 Codex 模型。渠道没有回报有效思考强度，标 requested-not-provider-certified，不能推断 GLM 实际执行了 high。 |
| 房间重复入口 | 两个菜单入口及头部名单都落同一通用抽屉。菜单只留“房间设置”；头部名单直接打开并焦点定位成员分区。 | 正式房间菜单仅“房间设置/归档房间”；头部快捷实际 activeElement 为成员区域，未开通用菜单。保留旧入口反例。 |
| 输入控件对齐 | 重复 spacer、SVG/line-height 与嵌套运行设置尺寸不一致。共享 Composer 统一 30×30、居中、SVG block，覆盖嵌套按钮。 | 房间/线程/DM，1440×960、900×800、1280×800 DPR1.5，可见附件/@/设置几何与真实截图均检查。旧 24×22 偏心失败保留，不以附件按钮通过代其他按钮通过。 |
| 完整对话与可读回复 | 回复列表漏读真实 anchor；adapter 把控制 JSON 当消息，worker/UI直接展示；提示词把简单输入扩成审计。原始根消息单次展示，agent 正式控制与 text 分层，message.protocol 只读高级入口保留原件，用户 JSON 不误过滤。 | “你好/123/测试”短回复，无内部 schema/resultKey/hash，无假交付；根消息作者、正文、时间完整。正文带图、DM 图片-only与任务 v1/v2可读回答、预览、验收及重开通过。实际 Claude 写/Bash 与 Codex normalized commandExecution/fileChange 都按真实活动保留工作交付。 |

## 真实工程闭环及相邻修复

普通用户输入不含 TaskComplete/resultKey/schema 工程指令。最终七次自然请求由正式 UI Composer/正式命令/正式 worker 发起，第八次为显式只读负例。模型自行生成文件、执行测试，工程 helper 只创建原始 synthetic original.txt 和离线生成两张图，没有代写成果。v1 原生 `node math.test.mjs` 5 用例通过；自然返工后 v2 增加数字字符串支持，11 用例通过，退出码0。原始 native session 字节 hash、两次工具输入/输出、文件 hash、交付版本和 accepted 状态可独立复核。

自然返工意见只保存意见，不启动；用户显式“执行返工”产生同任务新 run/v2，再按正式交付版本验收。真实启动器正常关窗、daemon退出、同 BAT 重开，v2实际源码、验收状态、完整会话、effort与模板保持。默认完整权限不代表改动集记录整个电脑：仍只追踪项目；single_writer/停止/退出未知保护保持。

真实路径发现并修复三项必要相邻问题：图片-only conversation 的未执行测量元数据被旧 OUTPUT_INVALID 校验拒绝；CLI 自动维护的 numStartups 等状态被有效配置 hash 误算导致返工拒绝；嵌套设置按钮漏统一尺寸。有效配置现在只剔除已确认非配置状态，实际 endpoint/MCP/权限/env/当前项目/未知键仍守卫失配及恢复；没有修改用户 CLI 配置去匹配证书。

## 验证、原失败及真实调用账

- 源码确定性门：146 文件/1027 测试、双类型检查、41变更文件增量 lint 无新增错误。外部 githubSandbox 的 schannel TLS SEC_E_ILLEGAL_MESSAGE 旧失败保留，单独排除，不能算通过。
- 同 BUILD 正式 Fake worker 工程闭环：房间 DIRECT 和 DM v1→意见→显式返工→v2→验收，停止/归档恢复/收藏定位/重开；零真实调用。UNKNOWN 丢回执/耐久草稿/重开/人工原号原参重放保持无重复。独立导航取消/交叉/ABA等11场景通过。
- 主池冷开不展开串即有附件；可见状态0/5.1/10.2/15.3秒，身份和数量一致。图像实际解码/原件 hash及既有阅读器不更换。3视口原型对照是结构层级核验；正式成员能力事实较原型密，合理换行/滚动。DPR1.5为仿真，不冒充实体屏认证。
- 发布本体与实际启动副本各593清单文件 size/SHA256匹配，BAT hash相同，BUILD clean/source一致；发布本体不带工程 DB/profile/fake。迁移001–050没有变更。
- 总门收集器 `scripts/collect-r83-final-gates.cjs`：任何必要门失败非零退出。当前唯一失败为 native titlebar movement verified；不会把“未验证”转为成功。

按八个自有数据根 real_calls 原 turnId 去重，**累计48次尝试：46 succeeded、1 failed、1 inflight/中断后未确认**，全部 Claude/glm-5.3-flash。最后同 BUILD 8/8成功。无真实 Codex 推理调用，model/list 不算调用。阶段3中断旧根不重开、不重发、不对账、不解除保护。原失败修复后的新目的/新独立根不能代记旧首次成功。

原失败仍保留：冻结v21原生菜单反例；首v22图片-only输出拒绝；rc2配置误失配；旧final嵌套按钮偏心；旧release成员捷径/权限文案；Codex normalized 工具的零模型交付反例。rc6关闭后连接探针90秒失败发生在任何新增请求前，原记录保留 `closeout-before-window-exited.json`；重新启动工程副本后的8次原身份成功仍单列。R75首次探针 --src 误传完整路径导致重复目录，失败保留，按脚本正式包名参数后的11项结果单列。

## 原生门剩余范围与交接

最终 BAT 标题栏原生 drag 测得 screenX/Y 728/151→728/151，没有位移；此前最小同版本 Electron 也无位移。菜单原生命中、原生最大化/还原均正常，但不能由此推定拖动成功，也没有证据把它归因于本软件。保留现有 Electron app-region drag，不为自动化失败写无依据全局拖动重构或自制 Windows 输入。需可靠的原生移动观察才可转全门通过。

另外未覆盖：Codex真实写入/识图、第三方有效思考强度、所有工具/所有渠道、实体HiDPI、长期OS行为。不是账号资源缺失，不自动换渠道。旧包、用户原根、凭据、草稿与未知账本保持；AUTO/DELIBERATE/并行/Android/安装器/签名/自动更新等延期保持。

只安排一次约10分钟自然确认：在空测试项目打开项目菜单搜索并关闭→配置已有成员的思考等级→普通提问/带图提问→要求创建小函数并运行测试→自然返工、显式执行→验收v2→重开查看原话与文件。窗口自然拖动属于同一路线观察，不另要求故障、竞态或历史格式清单。用户确认与原生移动未补证前，本记录仅是工程候选，不宣布首版放行。
