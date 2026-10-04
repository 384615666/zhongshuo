# 第50轮复核与第51轮H2开工（2026-10-04）

基线`eecf0e2`。本次未修改产品代码、原型、交付包、演练库、v6或用户结果。运行一次交付包的可选自检bat（只读，实际输出usage、退出1）；其余为只读文件/账本核对及PowerShell纯字符串匹配对照。新证据在独立`dist/desktop/review-r50/`。

## 1. H1主要业务链已有可信进展，H2可以开工

- 当前v2实际BUILD为`bld_f152ca66662dc4ab`，应用591/591对自身清单一致；同最终r50测试副本的591文件逐字节一致，filesDifferFromFinalTestCopy为空。
- 最终r50三份报告同BUILD/清单身份，正式停机记录均requestDelivered=true、exited=true、exitCode=0、daemonStopResult.complete=true/forced=false。窗口关闭路径这次已改window.close。
- 只读最终测试副本库，三轮DM测试输入task_id都与对应agent回复task_id一致；三条仅记录消息沿conversation_threads查root_task_id均NULL。房间派发关联及成员mentions在报告与账本中存在。
- **纠正本方第49轮复核口径**：房间根消息messages.task_id本就可NULL，任务关系沿conversation_threads.anchor_message_id→root_task_id；不能仅凭根消息NULL反推没有派发。旧文保留历史，当前纠正在此登记。

因此不再把H1整体搁置。用户可用当前v2做普通体验T1/T2/T3/T5：T2明确@→Guide A，T3新建+Guide B空闲DM，不借旧恢复演练会话；T4未触发记NOT_RUN，不人为断互联网。工程继续独立收剩余取证，用户不承担故障注入与进程对账。

本次未重新跑完整三连或854全量；前轮独立11/11及类型门结果不冒充本轮重新运行。下面的证据缺口不连带否定已查明的本轮任务回复/正式daemon停机事实。

## 2. 严格三连仍有少量不能扩大声明的项（工程并行收尾）

1. `procsOfCopy()`仍把Windows路径反斜杠加倍，PowerShell -like中反斜杠不作转义。纯字符串对照：正常根路径匹配true，加倍模式false。三份报告**关窗前已有CDP活窗口时procsBeforeClose=0**，关后0无法证明零残留。报告说“ASCII copyRoot前缀”与提交源码仍查中文copyDir不符；stdout空/JSON解析错还被当空列表。修成PID/真实路径身份追踪，活实例对照必须先查到进程；查询失败=未确认，不返回0。将捕获的本轮exe/node/parse/runtime子树在退出后逐一核对。
2. 三轮batExit均`still-running`但pass仍true。启动器有pause可作为人工交互设计，但不能记录“启动器已退出”；测试应从启动时订阅退出、已退出用exitCode判断，妥善给pause输入并有界收拢本轮cmd/seed，明确哪些进程生命周期属于测试。
3. 负对照只给neg.observed='fail'并写“必然超时”，没有执行waitFor。直接用同一断言函数实际跑不可能条件并捕获预期超时、次数/时长；不以结构等价推断冒充实跑。
4. 重启历史仍`cdp.eval(true)`白给。run2/3显式定位上一轮唯一message/task，核持久身份与正文；当前新建DM的2条消息不等于旧历史恢复。
5. 房间记录零任务需查thread.root_task_id而不是messages.task_id；记录零run不足以排除新outbox待执行。本次实际库正例无任务，但验证器该分支仍要补正式关联。DM UI也按对应reply.messageId核可见，不能只数两个DOM。

旧三连原始档不改写，补证用新runId；不必为测试代码修订不断交新应用包。旧危险`verify-hifi-package.cjs`仍保留全机taskkill/交付目录清库，需停用入口或加硬拒绝/隔离，不让下一轮误用；历史源码可保留但不能继续是默认可运行验收入口。

## 3. 当前用户包与报告“零接触”不一致，先明确版本

第49轮独立记录v2为`bld_5f1b092fed6e6240`，现目录已为`bld_f152ca66662dc4ab`，且同r50副本完整字节一致。不能再说整个v2零接触；如实际是先更新候选再开始保留，应明确时间线与哪些目录保留，不从元数据变化推断用户数据库必被改动。

当前v2 `run-self-check.bat`仍调用旧`seed/self-check.cjs --pkg`；本次实际运行输出`usage: node self-check.cjs --appdata <dir>`，退出1。源码新h1-self-check已写好但未同步用户包；README/短测模板也还是旧说明。不能说源码模板更新已随当前包生效。用户现在不要运行这个可选自检；给独立H1说明补充，在下一个必要候选统一修，或明确经过校验的材料更新方案。不擅自覆盖用户可能已回填的模板。

从当前版本起稳定保留应用、server-data、RESULTS。后续H2/打包必须可选输出独立目录，不能固定out=hifi-h1-win-v2原位拷贝新app。

## 4. H2映射修正后在第51轮直接编码

H2总体方向正确，复用原型布局/PreviewPane、既有正式附件与预览能力，不重新选引擎/解析器。不过映射不能当“props同构”直接搬：

- 正式深链族是`#task=`/`#delivery=`/`#msg=`/`#dm=`，原型路由是斜杠路由；映射里的`#/task=`不能直接送deepLink.resolve。做一个规范化入口，刷新/前进后退/跨项目与旧界面接管都保留实体身份，只有当前界面处理导航。
- thread.history实际返回items/rootAttachments，没有根消息正文/线程实体；task.get返回task/activeRun/pendingDelivery，其中pendingDelivery字段为id/revision/manifest_hash，不是DeliveryPanel的完整模型。建立真实DTO适配，必要的只读缺字段可向已有合同兼容扩展，不猜字段/时间/作者/版本。
- 原型经减负后的单行导航与“详情”分组保持，任务详情在既有位置，不另造两套页签。尚未接通项可禁用/定向旧界面，不能把“范围裁剪”自动当原型偏差免验理由。
- 第51轮先落可操作回复串：主池卡片→正确原消息/线程→回复不另建根任务；历史记录串仍默认仅记录、不唤醒；任务状态/停止/验收返工绑定正确run/代次与delivery三重身份；关闭视图不停止执行。readGate按线程独立水位及当前导航代次/前台焦点/贴底，不复用DM的conversationSeq。
- 同轮接附件信封与预览的正式适配骨架，按格式实际限制区分文本256KB、图片8MB、PDF/Office等，不把20MiB统一当所有格式上限。upload回执绑发起项目/会话/草稿键，实际refs/ranges/imageAck进不可变信封，成功只清已发资源，失败保留。排队附件按消息输入水位进下一轮。
- 共享预览沿现有实根/hash/revision/audience校验、异步代次、Abort/dispose、Shadow DOM/净化/外链禁止。视觉预览与模型输入如实分列，图片能力门继续保留；不复制一套未接真实服务的原型resources/actions当正式实现。

第52轮目标为H2独立候选（回复串+附件芯片→共享预览+草稿），R51至少交真实页面链和同窗截图，不只交盘点文档。默认新界面验证主池根附件/线程附件/DM附件，覆盖发送和切会话竞态；已有能力复用，未接项按类型明确登记。用户体验反馈如有实际失败优先收，但不等H1完美或Android回填才编码H2。

继续A+Word、B不集成不下载、零新增真实模型调用。H1/v6与历史结果稳定保留；价值评价、DEV-11、并行写入不开放，G5不连带宣布。
