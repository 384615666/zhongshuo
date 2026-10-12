# R78独立复核：持续运行详情不更新；R79长批次建议

日期2026-10-12；HEAD `cbc6d15`，v17 clean BUILD `bld_d314a9678136efa5`、runtime源码`fddc8f8`。

## 已确认的进展与检查范围

独立清单大小/SHA256核593/593一致。R78相关8文件18/18通过：taskDetails/taskProjection/roomCreationScope/workflowFixture/memberRuntimeBatch及3个浏览器投影测试；主+hifi类型检查0错。未独立重跑963全量或42对视觉图，已核读R78源码/发布/视觉的对应报告，不把其声明改称独立全部复验。

用户此前图片发送预览已通过，保持结论；零新增真实模型调用授权选择继续有效，不追加Codex认证。旧包/用户数据/草稿/未知账本保持。

## P1：同一RUNNING期间工具活动与用量不刷新

新`useTaskDetails`只在projectId/taskId/task.revision/selectedRunId/runStatus/手动refreshKey变化时发task.details。工具事件、用量、轮次内部状态在任务revision和runStatus不变时可继续增加；主池/thread的5秒刷新并不会改变这些hook依赖，也没有详情定时读取或事件失效机制。

独立两次复现，冻结v17 renderer、匹配Electron隐藏窗口/独立profile、正式message.submit→DispatchWorker→FakeRuntimeAdapter、独立内存数据库。fake第二个任务自然产生：

- 2.5秒后tool.started（LIVE_PROGRESS_MARKER）。
- 再6秒tool.completed与usage.updated。
- 再15秒维持RUNNING，随后自然交付。

正常结果未手工INSERT/UPDATE；无注入生产延迟或真实调用。打开真实房间线程运行详情，250ms采样跨三个5秒周期。

第一次`dist/desktop/review-r78-v17-audit-20261012/ui-result.json`：

- taskStatus ACTIVE/taskRevision1/runId不变/runStatus RUNNING。
- 工具事件0→1→2，用量记录0→1，正式库确实已有事实。
- 17.5秒内task.details仅1次，界面始终无工具活动/无用量记录。
- pass=false、completed=true、real_calls0；探针退出0仅表示执行完成。

第二次`manual-control/ui-result.json`同样自动更新失败。额外正对照：仍RUNNING时点正式“刷新详情”，立即toolVisible=true、usageVisible=true、detailsCalls2。这排除了服务端没保存或渲染器不支持显示，证明缺自动失效/读取。

## R79优先修复

可见详情在同一运行持续执行期间按有界机制更新（既有刷新节奏或事件失效均可），不用task.revision/status代替活动更新标记。隐藏/接管/卸载后暂停或作废；同目标在途合并，慢回执不形成并发队列，返回可见时补读。用户选中的历史run、滚动、展开用量、预览和草稿不因更新复位。

失败保留已确认快照且标清更新时间/错误；成功权威空集合与未读取分开。任务完成/返工/新run及跨项目迟到响应仍采用最新作用域/意图，不自动派发。

至少证明：status/revision不变的RUNNING跨3周期新工具/用量可见；慢读、失败、恢复、反序、隐藏/返回/卸载；选历史run时新run出现不改选；预算与用量的质量/累计语义不混淆。

## 长批次扩展范围（相关检查，未预断言故障）

1. 查同类任务详情/成员/活动/成果/看板的数据失效路径；DM failedTasks已有5秒读，不能误报其无轮询。发现独立反例再修。
2. 测量task.details读取成本：当前为最近20个run逐项读取turn/usage/events，且仅选中run展开详细内容。先测实际调用数、延迟、payload/内存，再按需减少展开前工作或分项分页；不能加无界缓存、去掉复核或把截断冒充完整。
3. 有界历史的可达性：运行20、事件120、交付50等上限如实；需要继续阅读的历史给真实分页/加载入口或明确既有定位通道；跨页去重、稳定游标、项目/任务/run/audience同一身份，不一次全量拉取。永久夹具可合成有界大数据，正常任务闭环仍由worker产生。
4. 持续日常交互：运行中切页面、读失败后恢复、结束交付、返工/验收、停止、重开；只读更新不改变业务按钮快照/草稿/预览位置/未知账本，不新增恢复自动动作。
5. 新界面信息整理：预算不要只给原JSON，活动不要只给内部event key；用真实字段提供可读摘要，技术身份折叠。reported/estimated/unknown及记录次数不等于总花费，不能发明或重复累计。
6. 交接文档修订：`continuation.md`当前仍称R75/v13是“唯一权威快照”，R78当前矩阵已更新但新对话按旧头部会倒退。保留旧段为历史，补本轮真实当前入口/BUILD/能力/边界/用户已通过项。

保持M0边界和既有延期；不放开AUTO/DELIBERATE、并行写入、工具权限，不做Android/安装器/签名/自动更新/价值评价。迁移001–048冻结，读投影优先无需迁移。工程零真实调用；用户原数据、样本、profile和凭据不改写/不提交。

有实际修复后集中v18，最终启动器验证持续任务更新与完整成功/失败/重开路线，所有证据绑定同一BUILD并保留失败。用户只需继承v17正常使用反馈，不造长任务/故障；下一次增量手测保持约5分钟。
