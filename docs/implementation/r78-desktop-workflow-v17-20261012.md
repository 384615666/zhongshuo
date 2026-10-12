# R78 桌面工作流与 v17 交付（2026-10-12）

R78 已集中交付 `D:\zhongshuo\dist\desktop\desktop-daily-win-v17`。启动 `start-desktop.bat`；旧 v16、数据、凭据、草稿与未知账本保留。构建来自 clean 源码 `fddc8f8fc32df639e9f2773b2c913efed1ae7922`，BUILD `bld_d314a9678136efa5`。后续提交只保存验证脚本/记录，不改变 runtime 源码或包文件。总验收 [r78-v17-delivery-20261012.json](r78-v17-delivery-20261012.json) 的23个必要判据均 true；并不代记用户验收或真实模型认证。

## 实际缺陷与修复

- **有限投影失真**：主池/线程把真实 DIRECT、自动交付与负责人丢失，有限 task.get 被合成 AUTO/PREPARE/零预算/空成果。现 room.pool/task.get 提供真实轻量事实及最新运行 id/status；完整 task.details 的项目/任务/run/audience、运行/turn/用量/工具/活动/交付/改动集/文件分别有界读取。无数据明示未知/未提供，不伪0；run 的可变 revision 不作创建排序。根锚消息没有 threadId 曾使同卡待验收却“尚无运行”，现传真实线程身份。
- **异步作用域错误**：看板闭包自比较使 A 迟到覆盖 B、冷读清房间筛选、失败清事实。现按作用域快照与代次，卸载作废、失败保留并就地显错、可见轮询且在途合并。Pending/Activity/Library、项目主页/设置和文件Git对应边界已修；活动头部无重叠会显游标断窗，不冒充完整。项目主页与标题栏以前用局部已装载数据伪0，现正式项目读取；标题栏 project.taskSummary 按 DM audience 过滤。
- **跨页实体与权限**：验收事件仅 task_id，旧活动流没有任务定位，还让 task-only DM 验收事件绕过受众过滤。现从 task/thread 绑定会话/项目，优先任务深链与同一 audience。房间/DM失败运行可显式继续，绑定 taskRevision/stopGeneration/sourceRunId/FAILED；原在途、UNKNOWN、未释放租约/保护、归档与外人 DM 均拒绝，不自动派发。
- **真实操作入口**：成员卡进入明确 project/member 的两列详情，配置模型/runtime（Codex也可输入真实模型ID）、启停、实际认证回读与返回。复用正式命令，绑定失败就地原因与输入保留；缺命令动作不做假开关。新设置页补接已有 remote.* 监听/配对/设备；项目属性与协作限制处理 A→B、ABA、关闭及写成功回读失败。建房新增事务/回执守卫拒绝跨项目成员、归档/移除与空白名。
- **Git读取失败**：三个子读失败曾清掉已确认历史/分支/远端且不报错。现 status 成功仍更新，子项失败保留各自旧事实和警示，成功权威空才清；乱序只应用最新读取，代次Map只留在途项。

成员配置读取性能已测：20个同有效配置成员旧独立读取，热421.7–483.0ms/冷644.5ms；请求内共享配置身份后热22.5–22.8ms/冷173.4ms。只在单次有界 member.runtimes 批次去重；下一请求、发送、worker、adapter启动前仍复查，不加全局TTL或无界缓存。

## 源码、业务与最终包验证

- 源码全量129文件 **963/963**，本地原测试集全部执行；双类型检查0错。最后43项合同回归通过，含图片字节、配置变化、主池附件、草稿与未知信封。修改源码与d87基线比较无新增lint，既有65项如实保留；新增交付脚本lint通过，不宣称全仓lint全绿。
- 独立持久夹具正式 `message.submit → outbox → DispatchWorker/FakeRuntimeAdapter`，room DIRECT 与 DM 自然两版交付、真实四个Markdown文件、返工意见记录→无自动执行→显式返工→同任务新交付→验收完成。仅记录、明确失败、停止、未知人工原号/原信封重放及改参拒绝分列。正常结果不直接改库；故障注入独立说明。
- 真实React/Electron永久读取门：三页15判据；看板5判据跨15.8s三个5s周期、反序/失败/冷筛选/卸载；标题栏6判据；Git2项真实bridge/store负例。此前项目取消/交叉打开/迟到失败/旧新弹窗10个隔离场景全部通过。
- **最终 v17 副本真实 BAT**：普通无helper首启/A↔B/关闭重开；错误nonce/无debug/错根exit9拒启；工程helper仅自有副本、正式packed startDaemon/worker自然完成room与DM两版本、成果文档hash与真实文件预览、待验收看板/待处理定位、搜索/收藏/验收活动定位同实体、旧v1验收拒、DM归档只读/恢复、运行中停止、最终重开。15步骤全部通过，四个UI会话console及未捕获异常0、real_calls0。来源、完整copy与R75第二真实启动器copy均593/593 hash/大小一致，BAT未改，独立pipe GUID不同。
- 最终包 **14场景×宽/窄/HiDPI=42对84图**，同浅色、缩放1、零横向溢出。实际审图与几何门分列，项目设置写入限制真实滚入可见区域；成员卡进入身份、启停、绑定防护失败输入保留、工程fake配置保存重开/返回/外项目成员拒，设置回环启停/一次性码重开消失、项目A→B属性保存重开均由实际UI验证。视觉来源固定最终BUILD和renderer哈希。原型模板、托盘等系统项缺正式能力的密度差异与菜单锚点/宽度差异保留，不宣称逐像素一致。

主要原始证据：`dist/desktop/review-r78-v17-launcher-final/result.json`；`dist/desktop/r75-launcher-check-1791805784717/result.json`；`dist/desktop/r75-completion-1791805806843/result.json`；`dist/r78-visual-pairs-20261012120103/manifest.json`；`dist/r78-v17-visual-review.json`。总JSON保存路径及SHA256，修复前/工程失败另见 [r78-v17-counterexamples-20261012.json](r78-v17-counterexamples-20261012.json)，失败原件未覆写。新 `collect-r78-release.mjs` 把必要失败判据计算进总pass，不能只以最后重试为首次成功。

## 剩余边界与外部依赖

本批零新增真实模型调用。图片发送/预览继承用户R77确认，没有要求重测；Fake流程不认证真实模型。Claude deepseek-flash 的已认证范围保持R77配置/CLI/渠道匹配条件；Codex `gpt-6-luna` 仍 unverified，旧120秒上游等待失败保留，本批没有再次startTurn或新增诊断调用。若以后要真实识图认证，须另行授权最少一次工程图调用，本次交付不依赖它。

成员改名/模板/思考強度/进程或会话重置、托盘/开机/聚合通知/MCP/备份、分析与修改分档时限尚无正式命令，界面显限制。AUTO/DELIBERATE、并行受管写、工具权限认证、Android/安装器/签名/自动更新/价值评价等既有延期不扩。迁移001–048冻结；没有自动重发、对账、解除保护或把用户样本/profile/凭据提交。报告声明的是本机工程验证，不覆盖全部真实渠道故障、操作系统/多机器或任意数据规模。

只需一次约5分钟自然确认：**打开常用项目 → 从成员卡查看配置 → 从看板打开一项已有任务 → 查看运行详情及成果文件 → 在待我处理或活动中定位同一任务 → 关窗重开**。无须重新测试图片或制造配置错配、竞态和恢复故障。
