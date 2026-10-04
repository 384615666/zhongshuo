# 第49轮复核与第50轮收尾（2026-10-04）

基线`bbb6a2d`。当前H1 v2应用buildId=`bld_5f1b092fed6e6240`，包内元数据仍真实为b264a40+dirty。只读核对当前应用591/591清单一致，启动器/seed-client/PPT种子/README/结果模板均已随包。独立专项3文件11/11通过、exit0，无上轮未处理拒绝；未重跑全部854项。

用户可以先打开v2体验新侧栏、房间/私信阅读和输入；但本次原始三连不能认证报告所述“派发→本轮回复→优雅退出”的全链。**区别产品已改善与验证器仍假阳性**，不把工程补证都变成用户重测。建议R50在测试副本优先把H1证据收口，H2可先做边界/页面映射盘点，不让H1一直扩成全功能工程。

本次没有启动用户交付bat、修改包/数据库/v6或真实调用；候选页面探针为独立隐藏Electron profile+受控传输，账本只读better-sqlite3。脚本与原始结果在`dist/desktop/review-r49/`。

## 1. 确认改善：此前重试缺字段/换号已消除

用第48轮原探针复制到独立目录，改读v2实际renderer原字节，严格传输控制器校验完整目标：

- 同目标首次/重试commandId与params逐项一致，projectId/conversationId/roomId齐全，重试后没有VALIDATION_INVALID；
- A提交后、unknown回执前切B，再回A重试，原commandId保持且完整参数保持。

结果ui-envelope-result.json。这是实际候选React控制流+模拟传输证据；正式网关/worker对应专项另列，不把它冒充真实IPC全链。此前技术缺口可按该范围关闭。

## 2. [P1] 三连验证仍含强制PASS与旧回复假阳性

`scripts/verify-hifi-package.cjs`：

1. `facts.bannerAfterRetry = (...) === false || true` **恒true**，还不进入pass汇总。重试后只等输入文本存在于主池，这条消息可能在重试之前已由首次成功提交落库，不能证明重试ok/完整信封/恰一次。
2. 房间链路发送没有指定成员，所谓“房间派发”只判消息出现。只读当前证据库：`H1 链路样本 run1/2/3`均`task_id=null`，没有本轮房间任务身份可认证。
3. DM回复只匹配任何带“完成”的旧消息；种子恢复演练已有历史完成回复。`facts.agentReply`甚至未进入最终pass表达式。只读当前库三条`私信链路样本 runN`任务仍ACTIVE：run1有1个run/turn，run2/3为0个run/turn。现有记录不能证明三轮新消息均收到本轮成员回复。
4. 仅记录只判正文出现，未核回执intent/本条message.task_id=null/零新增outbox/run/预算。历史总体fake不等于该消息零派发。

证据ledger-readonly.json、dm-task-facts.json为只读快照，不能仅凭快照确定每个UI步骤的具体原因，但足以否定“这三条测试任务均已完成回复”这一扩大声明。

R50去掉恒true，用故障注入负对照证明验收可真失败。每轮唯一标记+commandId+messageId/taskId/runId/turnId追踪：房间明确选启用成员，实际task入队并执行；DM用**新建空闲会话**或先正式处理演练暂停/中断，不靠旧种子“完成”充当本轮回复。匹配当前输入水位/task/turn与回复ID，页面与库双方核对。重试必须核正式成功回执（replayed语义）及同号同参、本批消息恰1条；仅记录核该消息归属及前后事实。把全部要求纳入汇总，不漏关键子项。

这些主要是取证与fixture问题，先在副本查清再判产品bug；不要用更宽泛断言让包继续绿。

## 3. [P1] CDP断开不是正式关窗/优雅退出证据

验证器仍用Browser.close，只看调试端口无法访问就设gracefulExit=true。当前server-data缺少`desktop-shutdown.json`正式停机记录；历史已明确CDP Browser.close可能绕过before-close停止链。

residualElectron是全机electron.exe计数差值，仅相对减少一个即可落0，不包含daemon/node/parse/runtime子树，不能证明零残留。

验证器开头`taskkill /F /IM electron.exe /T`会杀全机同名实例（可能包括v6/其它应用）；又直接清交付包server-data。本次**没有执行这个验证器**，避免影响用户。测试改独立副本/独立appData，只按本轮受控PID+启动身份/产物根收拢，禁全机按映像名杀进程；不得在用户可能运行或回填的包根清数据。

正式关闭走window.close用户同型路径，核shutdown送达/退出确认/forced=false/实际exit及本轮树零残留；诊断强杀兜底算失败且留档，不冒充优雅。CMD启动器与seed子进程也有有界等待/收拢，seed完成/失败和CMD退出码列入事实。

## 4. 路径与冻结身份的口径

报告说run1经中文空格junction，但run1.json的launchDir为原`hifi-h1-win-v2`，脚本创建junction失败会回退。当前留档不证明该路径实跑，不把它写PASS。确实运行中文/空格副本或保存junction成功与实际解析根证据；失败如实单列。

每个运行报告记录实际BUILD/buildId与应用MANIFEST身份，执行前后核一致；当前runN没有这些字段，只有外围报告同产物声明。旧三个报告原样保留并更正覆盖范围，修订验证器新runId留档，不覆盖run1/2/3拼绿。

打包spawnSync(pack-desktop)的status目前未检查，旧staging存在时可能在打包失败后继续拷旧产物。先检查退出码再读取本次BUILD/清单，并避免目录覆盖留下多余旧文件；模板当前writeFileSync无条件覆盖，和“不覆盖用户回填”相悖，已有结果按保留规则处理。PPT种子来自旧v6 dist包，正式可复现脚本应使用入库样本或同次受控生成，不能依赖旧交付目录永远在场。

## 5. [P2] 可选自检脚本并非所称机械清单自检

run-self-check.bat传`--pkg`；随包self-check.cjs是旧远程结果导出脚本，要求`--appdata`，当前会直接usage+exit2。它还需要远程selfcheck报告，而H1启动器没有开放REMOTE_SELFCHECK。这不是README声称的“文件/清单检查”。

二选一：实现真正独立H1清单/依赖自检（无须远程启用/配对），或从H1说明和入口移除误用工具。用户现在不需执行该可选自检；普通本机断互联网也不等于IPC断连，T4无需人工制造故障，没触发应记NOT_RUN，不能PASS。模板扩PASS/FAIL/BLOCKED/NOT_RUN；T2明确点@指定启用成员、T3新建空闲DM，给实际点击步骤而非只列功能名。不把错用种子回话当用户操作问题。

## 6. 下一轮与用户

可以让用户先看原型界面并做普通体验反馈，不用重复旧Windows D1–D10/v6四项。当前不宣H1完整验收已通过；工程补证前，T3不应靠旧恢复演练任务、T4不要求用户断网。若用户尚未操作，不催他们替工程补竞态。

R50在独立副本修验证器/fixture/自检与打包边界，先争取**同一现有应用产物**取得严格三连（如发现产品实缺再集中修+必要新候选），无需为测试脚本/文案反复重建CA或让用户重跑。通过后H2主线：回复串、原消息/交付定位、附件草稿与预览，复用已认证格式能力与正式合同，不再重选组件/实现解析器。现有v2一旦用户开始测试就保持稳定，源码/测试工作独立进行。

继续A+Word、B不集成不下载、零新增真实模型调用；v6/Android/旧证据原地保留；价值评价/DEV-11/并行写入约定不变，G5未宣布。
