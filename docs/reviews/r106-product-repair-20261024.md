# R106 产品修复与验证记录

状态：技术验收通过，等待用户实测反馈。2026-10-24；当前指挥会话为 `01a16d02-2621-7330-afbe-b2d116627da4`。最终包为 `dist/desktop/desktop-daily-win-v49-r106-final-20261024`，构建 `bld_49b786e55f9b69ef`。

## 原始现场与保留

运行入口原为 V47 / `bld_f06a8e1bb00c03cb`，沿用 V44 的 `server-data`。只读在线备份、完整任务/运行/调用/事件/消息/发件箱证据位于 `dist/review-r106-product-20261024/initial/`；升级前再次快照在 `pre-upgrade/`，正常退出旧应用后完整数据根冷备份在 `pre-upgrade/server-data-cold/`。

两次在线数据库备份 SHA-256 均为 `f9f3e3e123b9e8d938dc960c03bde52138ddb45d1d1b23e7a75b8bcbe90c5bca`，完整性检查均为 `ok`。需求文档 25,556 字节，SHA-256 `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2`。升级前没有活动运行或在途/UNKNOWN turn，没有停止、重放或篡改原任务。

## 已核实原因

房间 #4：`task_645995ee-1124-421e-921a-1df002510959`，运行 `run_3bd033dd-d2a5-41c5-bbb7-38e059531abb`。Codex 的独立分析有明确 `run.stepFailed`，发生在创建 turn 前，原因为“有效执行配置已变化；未沿用旧会话”，其 agent_turn 和 real_calls 均为零。私信“你好”任务 `task_80cdd749-571b-4b59-b375-3c44ea84a90e` 同样在上下文准备阶段受阻，零 run/turn/real_calls。因此不是上游模型已经接到请求后沉默。

冻结 runtime 的八个分量与 resolver 一致，原配置指纹已失配。源码和受控测试证明：旧 Codex 指纹哈希整份配置，无关工作区 trust 元数据也会改变指纹；CLI 初始化也可能写入信任元数据。但旧授权只保留整体哈希，没有足以唯一归因的旧配置分项前像，所以原失败当时究竟是哪一项变化仍未唯一证明，不能把“无关 trust 新增”写成唯一已证原因。房间屏障随后把“一份有效初稿”当作可整合条件，让 Claude 完成独立分析、整合、确认、修订整合、再次确认共五次调用。原运行最终为 PARTIAL / 任务 BLOCKED，现有文档已落地，不把这个历史结果改成成功。

跨项目同名默认房间：room ID 含项目归属，名称没有发生 ID 碰撞。旧打开链先切 activeProjectId，再异步刷新投影，旧 URL 的 ProjectAlign 会在此窗口把项目抢回。房间点击缺少 project.open 已有的打开目标占位，是主要竞态原因。另修正导航完成后异步 navigation.set 的持久化时序。

## 修复范围

- 只移除房间标题前的装饰图标，消息编号和 Markdown 不变。
- 有回复串的主池正文按实际排版约五行折叠，中文窄栏通过 ResizeObserver 检查真实溢出；可见“进入对话串查看全文与回复”。长交付辅助摘要另限三行，完整文本保留在 title/原串/详情。原文、附件、复制、引用和原有定位入口保留。
- Codex 新配置指纹明确为 v2。仅忽略可核实不属于当前 cwd 或祖先的 trust-only 块；执行模型、渠道、权限、MCP、未知字段及相关环境继续参与。历史无版本或显式 v1 授权用原始字节算法精确比较，不更新旧快照；未知版本拒绝。
- 新输入在冻结前只初始化 Codex thread 元数据，零 startTurn。准备前后核对配置、环境、项目物理身份、成员与授权；仅允许全局配置中归属于当前 cwd/已核实 Git 根的首次 trusted 块追加。真实配置变化、既有 trust 改变、项目配置变化或不能证明的重写均拒绝提交并保留输入。helper 返回窗口内已核验状态的 proof，调用方不能在 await 后另读配置充当基线；每次返回立即核验，并在事务开始和落库前复核，变化回滚提交。
- 初始化、关闭、清理均有界；metadata adapter 要求实际进程关闭证据，不能把发送 kill 信号当作关闭成功。既有业务 adapter 的默认生命周期语义保留。
- 多人名单只剩一份有效独立初稿且另一成员在模型前明确失败时，停在 INDEPENDENT，保留初稿和文件；不让一人继续整合/自我确认。优先于预算兜底，既有 E4 实际截止缺席策略保持。
- 失败成员单独查询持久化事实，不被另一成员大量工具事件挤出最近 120 条窗口。房间详情明确显示失败原因与未调用模型；只能在原串明确补交缺失成员工作。
- 0-run BLOCKED 私信只在有持久化派发前失败事件时显示未派发原因与“按当前配置重新提交”。沿用正式 task.redispatch 和 UNKNOWN/在途/保护守卫；显式重新提交也先准备配置，旧消息与 scope 保留。每个新恢复意图有独立 unstarted UUID 键；再次准备失败仍能由新明确意图重试，同 commandId 回放复用原回执，任务级 pending 检查防止双派。

## 验证与限制

最终完整回归为 **231 个测试文件、1933 项全部通过**，使用 `--maxWorkers=4`，明确排除禁止运行的 `tests/integration/githubSandbox.test.ts`。配置准备 30 项、metadata 确认关闭 3 项、旧 Codex scope 兼容 18 项，以及单稿阻断、二次 0-run 恢复、UNKNOWN 保护和导航持久化的用例均已覆盖。双类型和主要变更文件 lint 已通过；commands.ts / Room.tsx 分别有 10 / 12 项历史 lint，与此前基线一致，不能宣称全仓 lint 全绿。

首轮并发全量发现旧提示措辞回归、导航用例超时和三个系统相关失败。措辞已恢复；两个 Git 用例与 protectionRelease 独立复跑 18/18 通过。中间单进程运行跨越了显式 v1 用例施工窗口，两个新增用例读取了更早源码，日志保留；最终固定源码全量结果见 `dist/review-r106-product-20261024/full-suite-receipt-final.log`。

原生 Windows UI 使用 computer-use 技能，最终新票为 `screenshots/verified-*`：01/02 私信未派发与真实回复，04 长正文/辅助摘要窄栏，05 原运行失败原因，06/07 两个其他项目同名房间，09 Codex 本人直接房间回复，10 原两人独立研讨输入偏好恢复。对应图已逐张以 view_image 打开；统筹独立复核了 01/02/04/06/07/09。每票包含实际 route、build、截图/tree 哈希。旧 04–12 标签文件因保存闭包捕获旧状态而误标，完整保留且不作为对应场景证明，见 `evidence-errata.json`；verified-08 的重开抓图受窗口遮挡影响，同样不用于技术验收。B/C 的正式导航偏好分别在数据库 revision 47/48 落地。重开仍优先用户已有 `ui.autoOpenProjectPath` 指定的默认项目 A，没有改动该设置。

真实调用总共新增 **5 次：4 成功、1 输出合同失败后同运行有限格式补交成功**。Codex 均为 `newapi/deepseek-flash` / `high`，Claude 为 `deepseek-flash` / 未指定 effort，未改成员配置。

- 原 DM `task_80cdd749-571b-4b59-b375-3c44ea84a90e` 经正式“按当前配置重新提交”完成，run `run_14974575-3bbe-4c90-9ce5-e16c0a5d8f39`，Codex 本人可见“你好！有什么可以帮你的？”。旧 write_scope 原始字符串逐字节不变，前后 SHA-256 均 `90d198a99fc157ccc93438aad439ef1275f0c223029dde38229d791ce0721927`。
- 双成员新根 `task_0d669626-32e9-41b9-9025-12f163745cce` / `run_f4789dd4-d546-4fd8-95a1-43438ec12632` DONE/SUCCEEDED。Codex 首次 `turn.outputInvalid` 原因为短答与 claims 合同不符，fx 补交成功。R104 短交流合并策略只发布主持者 Claude 的合并回复；该票证明 Codex 真实参与和任务收口，不证明每席各有一条可见消息。
- 随后只 @Codex 的最小新根 `task_b35adcf9-0638-401c-a915-39956237b075` / `run_772a9589-9fa4-4046-818b-068efd69d2a5` / `turn_702e828f-5484-4a35-a3e1-8bde8664a331` 一次成功，Codex 本人可见 `R106_CODEX_ROOM_OK，已收到`。没有继续旧业务或读写文件。

最终 `activeTurns=[]`、未释放租约 0、业务工具活动 0；原 #4 仍 BLOCKED 且原 5 调用未变，需求文档 25,556 字节/SHA-256 `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2` 保持。记录在 `final-audit.json`，统筹也独立写入 `coordinator-final-state.json`。最终 SQLite 在线备份完整性 `ok`，另有正常退出后的完整数据根冷备份。

最终包 payload 595 项清单全部匹配，daemon SHA-256 `f56a44ae228c240b9f5c6820643324a09c8d2e90569793857bec1eb6b1a30501`；统筹独立结果见 `coordinator-manifest-v49.json`。沿用原数据请用包内 **start-existing-data.vbs**，指向原 V44 `server-data`；普通 start-desktop.vbs 属于本包独立数据入口。

Git 例外：本地 `138e99966cc1c7c21a9096cd96740b8318ca80f2` 由导航子代理 Avicenna 提交，仅含 loader.ts 与 R90 测试，没有 push；其后导航补丁及其他本轮代码保持 WIP。主会话未 commit/push，没有 reset/revert 或改历史。保留无关用户删除、未跟踪文件及 R104/R105 改动。没有手工改全局 CLI 配置、凭据、网关，没有安装或执行外部开源项目；开源比较由统筹另行完成。
