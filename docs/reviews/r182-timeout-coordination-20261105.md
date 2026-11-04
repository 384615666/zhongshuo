# R182 房间超时与协调成员停住

日期：2026-11-05。代码预留版本：0.1.3-beta.28；本轮按用户最新指示仅提交代码。

## 现场事实（只读）

安装版beta.27的日志显示多个读取命令超过15000ms，并在之后收到已无等待者的响应。新连接room.list约238ms，room.pool约4701–6093ms。单条完整执行状态读取约6893ms；摘要includeActions=false约24ms。测量定位到taskClosure.scopedOutbox：对整个outbox逐行执行任务归属相关的EXISTS，再对每个后代重复。每次完整状态读取该类SQL多次各约500ms，阻塞daemon事件循环和同连接队列。

用户所指的协调成员已完成最近的规划回复，但当前协作已blocked；DeepSeek Harness子成员turn失败，持久事件为OUTPUT_INVALID / 没有完成握手。最终整合步骤OPEN，未创建run；没有活动Claude进程。源码状态投影正确返回FAILED并引用子成员原因，截图的准备执行内容是迟迟未刷新的历史状态。现场没有足够证据区分原次启动缓慢与组件启动异常，不将其说成已恢复。

## 修改

- scopedOutbox先物化当前任务的turn和派发身份，复用集合查询；保留turn_id、turn.dispatch_key、两种thread reply identity、conversation reply、repair、resume/redispatch事件与automatic recovery归属。文字前缀仍用完整键语法和字面ID核验，避免冒号/通配符邻近任务误归属。租约、UNKNOWN、实际进程退出守卫未放宽。
- Harness执行等待ready与元数据查询共用有界30秒启动期限。官方插件等待完整appReady才发ready，原10秒执行期限早于已有30秒配置窗口。期限内接受慢启动；真正超时报启动等待未完成并终止子进程，不再把沉默当作协议格式错误，不发送未ready的execute，不自动重试。旧插件指引更新为当前安装目录runtime-tools/deepseek-harness/setup.cmd。
- IPC读取超时维持15000ms，未绕过写命令FIFO，未修改原任务和用户运行数据。

## 验证

- 定向11文件231项通过：执行状态成本、taskClosure、R168摘要、Harness、R169继续、R140恢复、R86/R92/R154协作、R132串状态和R99阻断。
- 新增12子任务、4800相关历史事件、8000无关outbox的读取预算测试，同时核验任意键的正式归属租约仍拦截，无关租约不串入；模拟成员失败+整合未派发验证FAILED及无活动准备卡。
- 使用实际隔离子进程等ready超过10秒成功；自定短期限无ready确认失败与退出，不出现turn.started。
- 本轮修改文件eslint通过。主工作区根tsc另有其他UI改动引入的DOM范围问题和未跟踪R130/R180夹具错误；仅本轮已提交源码的隔离快照中，根tsc和hifi tsc均0错误。
- 完整已跟踪套件在程序提交bf131ad6bc22bf8f10df0a2e2990b140c2bfaa4f的隔离快照运行：366文件通过、2文件跳过；3282项通过、3项预期失败、16项跳过，0非预期失败；耗时420.16秒。报告在ignored的dist/r182-timeout/isolated-tests.json。没有把另一位AI正在修改的前端和旧未跟踪夹具纳入此结论。
- 修复源码只读当前数据库：完整执行状态84/57/55ms；room.list51/25/16ms、room.pool104/94/81ms、thread.get3/2/3ms。原安装版尚未升级，这不是已安装程序的修复后实测。

## 交付边界与用户最新指示

用户在编译期间明确改为「直接提交代码，等另一位AI修复前端后一起打包」。遵照最新指示，本轮交付为代码提交，后续合并前端改动后再统一生成正式安装包。

该指示到达前，本轮独立源码快照的安装器编译已完成，但未安装、未发布、未开展安装验收。该中间产物不包含另一位AI正在进行的前端修复，已从常规dist/installers移到ignored的dist/r182-timeout/intermediate-installer，避免误当最终更新。未另做便携版交付或独立验收，未重启现有众说、调用真实模型或代用户继续原任务。
