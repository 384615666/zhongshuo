# R86 协作现状与实施记录

基线：`60f36ebd6ed67acfc6c517406bd735d4e08255fa`，`codex/full-implementation`，审计开始工作树 clean。当前交付 v24-rc2 的单成员验收不能代表多人协作已完成。

## 已确认的缺口

- `dispatchWorker.ts` 的 AUTO 路由直接 BLOCKED；正式入口未提供自动分工执行。
- `entry.ts` 的 DELIBERATE 仅显式环境变量 1 开启。已有持久化 roster、预算、阶段、outbox 与独立互评合同，但不能直接视为桌面协作完成。
- `dispatchDeliberationStep` 仍使用 `policy-analyze`，没有 DIRECT 的输出 schema、图片字节与配置复查。只读角色可以保留，必须实际执行并说明。
- `publishFinalReport` 的固定交付 revision=1、空 manifest hash 不满足当前返工/版本验收合同。
- communicationContract 的 mentionEnabled 固定 false；提示里的 request_participant 不等于正式跨成员派发。
- tasks.parent_task_id、task_dependencies 和现有 task/run/turn、写租约可复用；没有实际 AUTO 计划生产与依赖推进。
- AUTO frozenMemberIds 仅协调者，不能作为模型自主扩员的可信名单；须另存用户本轮房间启用成员范围与配置快照。

## 实施方向

房间一次发送由协调者规划，正式校验有界 DAG，创建有身份的子任务；子任务复用 DIRECT adapter、上下文、原件、changeset、租约、停止与交付。依赖交接绑定真实交付版本和文件事实；协调者最终整合，由用户验收指定版本。普通问答可直接回答，DM 保留一对一。多人研讨保留独立分析、互评、分歧和整合，但更新正式 adapter 输入和版本发布。

父子聚合调用上限，预留整合；只读规划/评审与实际写入角色分开，共享目录仍 single_writer。父停止、UNKNOWN、配置变更与迟到回执必须阻止后续错误派发。工作全部在独立合成根；不操作用户正在使用的数据根。

产品问题已由审阅会话向用户询问：默认自动协调并支持手动指定，以及是否要求不同实际模型共同验收。当前按推荐方案进行可逆实施，答案到达后同步调整。

## 阶段记录

- 新增计划白名单、DAG、步骤数量和聚合预算合同；5 项单元正负例通过，真实调用 0。这只是合同阶段，不是协作产品验收。
- 审阅方另跑现有研讨 7 文件 49 项通过；属于已有工程合同，不代表真实双渠道协作。

尚未完成：正式调度与界面、隔离负例、双渠道真实闭环、第二任务类型、最终冻结包。历史业务价值评分仍未进行；不会用工程通过替代用户价值评价。
