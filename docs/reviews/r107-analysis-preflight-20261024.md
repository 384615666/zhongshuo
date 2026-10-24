# R107：原比较任务恢复与只读分析

2026-10-24。指挥会话 `01a16d02-2621-7330-afbe-b2d116627da4`；产品统合及唯一用户 UI 操作者为本编码会话。当前完成的是用户截图中原任务的实际比较，不是问候或新造同类任务。统筹已独立复核并确认技术验收通过，等待用户反馈；停止新增模型调用与功能。

## 最终包与原数据

- `dist/desktop/desktop-daily-win-v50-r107-analysis-20261024`，build `bld_64960bf21b281f99`。
- 595 项 payload 全部核对一致，daemon SHA-256 `e2bc23bc6aa2d04bcc0848c5bffc5269f8cbbc748235a1f6b9dcb60390816fda`。
- 沿用数据使用包内 `start-existing-data.vbs`，仍指向 `dist/desktop/desktop-daily-win-v44-r104-provenance-20261024/server-data`。普通 `start-desktop.vbs` 是独立数据入口。
- 升级前 activeTurns/pending 均空，原生关闭 V49 后完整冷备原数据根到 `dist/review-r107-preflight-20261024/pre-upgrade-data`，再正常打开 V50。没有强杀用户模型进程、迁移或覆盖原数据。

## 确定根因与改动

原项目 `prj_0a86f349-d2a3-488f-b74a-9c5f73827c1e` 的真实目录为 `D:/zhongshuo`。原任务 `task_993d7e3e-ad2c-4951-a24a-a7d1a760ce0c`、房间 #1、Claude 主持 AUTO。初始 0 run / 0 turn / 0 real_call。seq435 changeset 基线捕获 5007 文件且 truncated，旧 dist 桌面产物参与扫描；seq437 `task.contextAssemblyFailed` 明确 `write-baseline-incomplete`。不是 Codex 指纹错误，也不是模型调用失败。初始只读在线备份、脱敏事件和范围证据位于 `initial/`。

保持完整可写基线的拒绝条件；增加根房间消息的“本次仅分析”和原失败卡的“仅分析继续”。后者是对同一原消息/任务显式创建新的只读执行意图，保留 AUTO 与原成员配置，不改原任务旧 scope。Claude 实际采用 plan、Read/Glob/Grep/WebFetch/WebSearch、bare、strict MCP、禁用 slash，不接受额外启动参数或可写冲突。修复轮继续使用既有更严格的只读补交语义。

普通继续、同串跟进、AUTO 子任务/交接/整合继承最近只读意图，不能由旧 task full 快照或成员 bypass 默认提升。新执行按当前配置冻结，真实配置漂移仍拒绝旧快照；UNKNOWN、未结算调用、租约与停止代次守卫保留。新根普通可写规划与修改交付路径保留。

预派发失败用同一持久投影接入 room.pool、task.get 和 task.details，根卡、串与详情显示成员、具体原因、尚未启动/零真实调用及绑定版本的恢复入口。历史 failure、在途和 UNKNOWN 不会冒充 NOT_STARTED；不存在的运行详情不再作为此类故障的唯一去处。

## 实际原请求结果

通过 V50 原生窗口点击“仅分析继续”，没有直接改库状态，也未重建业务根。

- 原根 DONE / revision 6，查证子任务 `task_13e4eb65-ce75-4d9b-a7ee-4367d1959dc6` DONE。
- Claude 首轮读取本项目材料，Codex 经公开网页工具查证用户给出的仓库，Claude 最终整合；原串出现实际结论和六条可见回复。
- 完整文档 `zhongshuo-vs-multi-agent-collaboration-2026-10-24.md`，22,296 字节，SHA-256 `9b221d7ca3eb5ea6007b9e0efb3f7e06e641a3dffb3a2fa2f805625a9d7ef4c8`。受控 artifact `art_detail_534a6b6a60be902e_9b221d7ca3eb5ea6`，已逐字复制并核 hash 至同名证据文件。包含七维对照、优劣、选型及来源边界；最终正文明确 1933 测试数来自 R106 历史记录，未假称应用内本轮复跑。
- 真实新增 calls 20–23：3 成功、1 合同失败。Codex 查证已完成后抄错 Claude 长成员 ID，合法收件人守卫拒绝交接；保留原长答和失败事件。经本机认证命名管道的正式 `task.details` 核准后，手动提交一次 `task.redispatch(formatRepair=true,useCurrentExecutionSnapshot=true)`，绑定原 source run/turn、全文、hash、invalid 事件与 CAS。补交 turn `turn_7adb48f4-635d-4e3f-9f10-b73f97c9fd7d` 成功且 toolStarts=0，没有重跑查证。回执及信封见 `child-repair-*`。
- 四个实际 runtime session 都为 analysisOnly=true / fullAccess=false / modificationAuthorized=false，整合未升权。Claude 真实进程 flags 核对在 `real-cli-verified.json`。早期 `real-cli-restrictions.json` 是未归一引号且包含检查器自身的初步进程清单，不作为最终权限证据。

原生图 `screenshots/01-v50-original-preflight-cause`、`02-v50-original-analysis-running`、`03-v50-original-comparison-complete`、`04-v50-comparison-document-open` 均以显式 state 参数即时保存，含实际 route/build/image/tree hash，并逐张 view_image 检查。01 证明原失败原因与正式恢复入口；03/04 证明同包原任务完成、实质回复及完整文档打开。最终保留用户窗口和文档预览。

## 保全与验证

- 正式专项 9 文件 / 90 项通过；Composer 与 adapter 14 项通过。覆盖真实目录超过 5000 忽略文件仍拒绝可写、同 task 显式只读恢复、失败后无 flag 普通继续、同串继承、AUTO child/handoff、session identity、原 scope 保持、配置漂移/停止/UNKNOWN 及 R104 正常可写行为。
- 固定源码全量 237 文件 / 1964 项通过，排除禁止的 `tests/integration/githubSandbox.test.ts`；双 typecheck 通过。
- 变更 lint 的 commands 10、Room 12、store 8 共 30 项为既有项；store 8 已独立用 HEAD stdin 复现。其他本轮文件与测试定向 lint 通过。`git diff --check` 通过，日志保留既有 CRLF 提示。
- 模型窗口前后比较 2583 个 tracked + 非 ignored untracked 路径，含 4 个既有删除，差异为 0。ignored 的 app-managed dist 明确不属于这份业务源码清单；应用生成的报告在原数据根 blobstore 中。清单已核完后才恢复统筹文档与本报告写入。
- 原 task scope 原始字符串逐字节保持，前后 SHA-256 都是 `8c56a6a9b63fa261259f19b705cb4719d5a120f02442af96b7a8e0e707bb5ff1`；成员 profile/配置/settings revision/执行程序绑定 hash 一致。
- `final-audit.json`：activeTurns/pendingOutbox=[]、未释放租约 0、SQLite integrity=ok。在线一致备份 `final-state.sqlite` SHA-256 `6ce6e314999c5a399edf2608e9c6e90a7d031865e1f81e19b8e729cb271fb08a`；最终原生查看后另存 `final-ui-state.sqlite` 与 backup record。

本轮不宣称全自动无失败，也不宣称所有大工程写入已修：完整可写基线超限仍合法拒绝；本轮交接需一次正式手动只读补交。公开仓库最新提交时间/tag 未取得、CI 仅能说明未发现、INSTALL 与 package.json 插件版本不一致，应用交付中均保留限定。未安装或运行外部开源项目，没有修改全局 CLI/凭据/网关，未 commit/push；R104–R106 WIP、本地既有 `138e999` 及无关用户删除/未跟踪项保持。

统筹最终独立核验见 `dist/review-r107-preflight-20261024/coordinator-final-verification.json`：原 root_message_id、scope、成员绑定与 2583 路径逐项一致；文档与备份 hash 一致；activeOrUnknown=[]、租约0；595项包清单及全量237/1964核验通过。统筹已查看01和03实图并明确本轮技术验收通过。
