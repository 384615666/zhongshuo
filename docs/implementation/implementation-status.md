# 众说正式工程 · 施工总账

> 本文件是跨会话施工进度唯一真源之一（与 requirements-traceability / continuation 配套）。
> 状态取值：`NOT_STARTED / IN_PROGRESS / IMPLEMENTED / VERIFIED / BLOCKED / DEFERRED_BY_USER`。
> `IMPLEMENTED ≠ VERIFIED`；`BLOCKED` 必须写具体外部条件；`DEFERRED_BY_USER` 引用用户明确决定。

- 施工分支：`codex/full-implementation`（总任务书 §3.3：各包在同一施工分支形成检查点）
- 依据：[施工总任务书 v1.1](../dev-briefs/full-implementation-brief-glm5.3.md) · [主设计 v1.23](../zhongshuo-development-design-v1.md) · [开工契约 v1.23](../development-baseline-v1.23.md) · [分批表 v1.23](../development-delivery-matrix-v1.23.md)
- 当前阶段：**M0（单成员真实工作闭环）**；DEV-01—05/17/21-M0 已实现（见 reports/）
- 最近更新：2026-10-01 第二十九轮（**PDF 解析迁入可终止子进程执行边界**（parseWorker/parsePool：墙钟截止 30s+SIGTERM→SIGKILL 收拢确认/并发 1+队列 4/内存 320MB/输出预算；受控故障证明 parseBoundary 6/6——同步阻塞隔离/worker 退出分类/dispose 杀净；旧 Promise.race 计时器竞态消除）；**上传幂等三层+缓存 schema v2**（commandId 回执预查→同会话去重→跨会话缓存复用——解析池计数证明不重复解析；预算口径变化=缓存作废；解析期间归档事务内重检——pdfCacheIdempotency 4/4）；**托管存储实身份**（realpath junction/symlink 检出+受控句柄读取——storeLinks 3/3）；**真实中文样本**（Identity-H+ToUnicode——旧 latin1 冒充废弃）+CMap（随包 cmaps 依赖可证）+扫描件+加密（R2/RC4）——realFormatDocuments 6/6；**视觉页面渲染**（zsres:// 特权协议+渲染器 canvas+构造性翻页指纹）；**图片能力门**（IMAGE_INPUT_UNVERIFIED：未确认拒发/确认注入未发送说明/record_only 不设门）+WebP VP8/VP8L 头+decode() 如实；**Office 四类**（DOCX mammoth 白名单净化/XLSX 值缓存+公式无值自查/CSV 编码规则/PPTX 页序文字+zip 护栏——officeAttachments 9/9）+**表格范围注入**（迁移 036 range_spec——默认有界窗口）；attach-preview 视图全局化。本地 **755/755**；ATT 页面会话 30/30）
- 上一轮·二十七（通知验收入口启动器闭环：纯 ASCII 启动器+隔离环境 cmd 顶层内置（chcp 65001 含中文批处理字节错位）+backgroundThrottling:false+干净环境实测+OS 吐司视觉取证；附件四通道+完整性+草稿键控+代码附件+基础评论；看板映射修正+动作行+Files 集合+历史停止代次三层修复（迁移 032 快照）；冻结三连 94/94×3（bld_1d32c99c591d4061）；本地 715/715）
- 上一轮·二十六（提醒准确归属：迁移 030 完整身份键+归属解析+acquire 原子收敛——ownership 4/4；通知修复（locate/notifyMuted/五相留痕）+r25 字段名回归修复；通知人工验收入口首版（启动器含中文致 electron 未启动的缺陷本轮实证并修复）；搜索一致性 7/7；DEV-19 首包（boardView 3/3）；DEV-24 文本首包四能力（textAttachments 5/5）；冻结身份核对+三连 86/86×3（bld_fbf9a457a7117f96）；本地 698/698）**提醒准确归属**：迁移 030 dispatch_key+完整身份键 task:{id}:reminder:{rid}:{sat}+归属解析（键/源turn/预占——不再按 task 唯一推断）+acquire 原子收敛进 createRun 事务（组装失败/崩溃/重领不留幽灵 inflight）+无预算也入账——ownership 4/4 逐条归属断言；**通知修复**：服务端准确 locate（DM/任务串/讨论串区分）+notifyMuted 独立过滤+五相留痕；**连带修复 r25 字段名回归**（renderer 蛇形漏改→确认按钮静默失效+system 消息假阳性——REM 9/9 恢复）；**通知人工验收入口**：独立包（buildId/独立 appData/fake+guard 内置零配置）+开发机自测通过（项目恢复/两条通知 created+shown/去重/guard）——**Windows 送达/点击待用户人工复核**；**搜索一致性**：线程/任务统一过滤+本机时区（北京凌晨边界用例）7/7；**DEV-19 首包**：board.view+thread.collaborators+renderer 看板/协作视图（boardView 3/3+BOARD 会话——打开零运行）；**DEV-24 文本首包四能力**：保存副本（内容寻址 blobstore/迁移 031）/预览/提取正文/注入模型输入（ContextBundle.attachments——副本实际文本+hash/截断说明；textAttachments 5/5+ATT 会话）——文本首包≠DEV-24 完成；**冻结身份核对**：ZS_VDR_EXPECT_BUILD_ID 运行前拒错包——三连 86/86×3（bld_fbf9a457a7117f96 均带身份核对）。本地 **698/698**）
- 上一轮·二十四（E18 收口+验证器三缺陷修复（678 行语法错/伪造 fixture/窗口遮挡环境语义）+round-23 房间验收 manifestHash UI 回归修复；E18 同一次完整 17/17；DEV-23 正式合同版重做（任意分钟+DST 规则/原子触发/休眠从计划推导/预算 fail-closed/五命令 audience+幂等/system 正式执行+确认入口+turnInput 根作者扩展/管理面板/daemon.stop 先关调度器；迁移 027；本地 671/671+桌面基线 65/65 bld_b5b3227bc6b68ed1；零真实调用））
- 上一轮·二十三（**runtime executable 回归修复**：resolveMemberRuntime 穿透实际可执行路径+adapterFor 缓存键含路径+resolveClaudeExecutable 显式路径不静默回落全局（shim 3/3 零真实调用）；**DEV-18 补齐**：thread.markRead（001 预埋表）+主池线程未读；deepLink 全分支 audience（他人 DM 任何形态不可达）；mine.pending 不泄露+blockedTasks 如实+actionable 区分；task.review manifestHash 三重绑定+audience；renderer 全程代次（A→B→A）/视口贴底标读（后台不标）/滚动保留/hashchange-popstate 统一导航/待办全量（dev18ReadPending 11/11）；**E18 页面验收**：段 1 7/7 四连过；段 2 4/6（13 项渲染+跨项目两项遗留登记）；**证据收口**：真实批次 journal 可追回（pid 级重启共享额度证明）+补充材料（不可追回如实注）+批次脚本清理前抓全量事实；冻结口径纠正 28/28；全量首跑失败真身=githubSandbox 顺序依赖已修；**DEV-23 首包**：026 增列+ReminderScheduler（唯一键/合并/重查/预算拒绝/服务端 UTC 化/假时钟 8/8）+命令面+entry 接线+DM⏰最小入口。**655/655**
- 上一轮·二十二（**C/A 间歇根因闭环**：早到点击静默丢失（CDP target≠页面可操作）+裸管道名 UI 连不上——修 disabled+__zsReady+waitInteractive+完整前缀；验证器重写：runId 留档不覆盖+ZS_VDR_FROZEN 冻结 SHA256 复用=同一产物三连全绿（29/29×3）；D 同步点真窗口（listen 前延迟/daemon 响应延迟+实发 commandId 回执核对/受控退出延迟+共存探活）；HARNESS 零调用自检 12/12；abort 认证后移除=关停不再强杀；DM 收口：resolveMemberRuntime 统一解析（+permissionMode）/observedSessionIds 身份冲突不冒充续接/settle 明确重试+重启收案+取消释放/generation 撞键修复；**真实批次 r20-dm 17/17 全过**（4 次 startTurn 全 succeeded、A2/A3 续接请求=上报、B 独立=身份+水位+输出、护栏 4≤8、双优雅退出）；**DEV-18 首包**（markRead commandId 幂等+未来水位拒绝+UPSERT+固定目标；mine.pending 权威汇总多交付不漏+绑 deliveryId/revision/manifestHash；deepLink.resolve 四形态真实归属）。**640/640**+冻结三连+HARNESS 12/12+批次演练 15/15；零真实调用除授权批次 4 次）
- 上一轮·十三（2026-09-29：受管桥完整化/恢复证据正式链/push 目的地绑定/早期打包——环境结论已于十四轮撤回，见 round-20260930-round14 注记；数字与细节见 round-20260929-round13-bridge-pack.md）
- 上一轮·九（**进程树保守判定**：probe 不再返回 exited——周期快照只产生「未观察到存活后代」观察、不构成完整退出证明，有子进程 runtime 自动解除路径关闭；历史身份追加式登记（迁移 014：pid+started_at 代次、从不删未确认身份）；盲区反例如实返回未完整确认；**迟到回执原子化**（迁移 015 作用域键 source_scope+turn+eventKey，回执与业务效果同事务、失败回滚可恢复；归属校验不认领；泵收口不释放写入租约）；**验收绑定交付版本**（deliveryId+revision 条件更新+冲突区分+同号重放幂等；返工说明注入后续派发输入）；**DEV-14 深化**（git.diff 正文只读/撤销续跑入口/设置持久化/常驻帮助面板）。502/502+uiE2e 19+2skip、lint 0、零真实调用。**恢复与修复链按能力分列（见 continuation）：有子进程解除路径=设计边界关闭；真实 CLI lateEvents=unsupported**。价值评分=用户决定暂缓（不放回待办））
- 上一轮·七（**OS 退出证据服务端化**：adapter 进程身份三模型（per-turn/shared/none）+runtime_process_registry 登记+recovery.probeProcess 服务端取证+reconcile 参数重写（调用方不能自报 alive=false；notStarted 人工分离 manualRiskAck——退款但租约保留）+Windows 查询错误分类修复；**逻辑输出修复限次**（迁移 010 UNIQUE(task,logical_output_id)：禁止修复套修复、被拒零副作用）；**预算统一授权账目**（逐 turn 处置事实单一真源，SUM 快照重复计反例锁定；budget_run_id 授权链校验+上限强制）；**文件清单回授权合同**（§13.4 项目源码默认可读/§6.3 命名排除/大小写归一/上限过滤后计数）；**恢复 UI 事实分层**（程序观测/人工说明/无法确认/保留保护+遗留租约行+renderer e2e 反例）。451/451+uiE2e 16/16+realCodex 4/4、lint 0、零真实调用。**价值评分=用户决定暂缓**（恢复与修复链稳定后集中安排一次；DEV-11 不开放；剩余 3 次保留）
- 上一轮（2026-09-28 第六轮·下：

## 工作包状态

| 包 | 交付重点 | 状态 | 代码位置 | 验收 | 证据/备注 |
|---|---|---|---|---|---|
| DEV-01 | 类型/schema、目标判别、路由、来源/权限/预算合同、MCP 预留 | **VERIFIED**（G0 范围） | `src/contracts/` `src/domain/` | G0 | [reports/dev-01-result.md](reports/dev-01-result.md) |
| DEV-02 | SQLite migration/事务、组合约束、回执、outbox、重启读取 | **VERIFIED**（存储侧） | `src/persistence/` | G1（存储侧子集） | [reports/dev-02-result.md](reports/dev-02-result.md) |
| DEV-03 | 可脚本化 fake adapter（六类 fixture） | **VERIFIED** | `src/adapter/fake/` + `src/contracts/runtime.ts` | — | [reports/dev-03-result.md](reports/dev-03-result.md) |
| DEV-04 | 目录打开/去重/重定位、物理锁域、基线清单 | **VERIFIED**（修复轮后） | `src/daemon/` | RT-07/09（存储侧） | [reports/dev-04-result.md](reports/dev-04-result.md)+勘误：RT-07 真过期阻塞已修复（原用例假阳性）；parallel_writers 入口已禁用（ADR-I19） |
| DEV-05 | daemon 单实例锁、派发 worker、停止代次、恢复基础、命名管道 IPC | **VERIFIED**（修复轮后） | `src/daemon/` | G1 核心 | [reports/dev-05-result.md](reports/dev-05-result.md)+勘误：独立截止计时/会话竞态复查/派发门禁/重领对账/模式门禁/验收策略/锁原子化/IPC 全部补齐；**真实进程边界随 DEV-06 验证，不提前声称**；**REC-LIFE-1（第十二轮）已实施**：koffi Job Object 受管生命周期（jobManager+bridge+迁移 019+releaseProtection 证据分支；managedLifecycle 9/9 本地真实进程；真实 CLI 实战与打包可加载性待补证/DEV-15） |
| DEV-17 | 线程关联与隔离（目标绑定、会话隔离、事件归属、上下文过滤接入派发路径） | **VERIFIED**（任务级；阶段级随 DEV-08/09） | `src/domain/isolation/` + worker 接线 | G1/G3 前置 | [reports/dev-17-result.md](reports/dev-17-result.md)+勘误：过滤白名单强化（指令/摘要/文件均验归属）、ContextBundle 已在派发路径组装落库、同成员双任务隔离用例 |
| DEV-06 | 真实 runtime（Codex App Server）、能力/权限检测 | **VERIFIED（G2 适用范围）**：C1/层 A、计划档两路径（declined/sandbox-denial 证据绑定）、确认档 allow+deny、steer 正常+服务端拒、resume 续接+不放宽、interrupt、usageTokens | `src/adapter/codex/` | G2（Codex 单 runtime；structuredFinal 真实输出随 G3） | [reports/round-20260927-fix4-dev6finish-dev07backbone.md](reports/round-20260927-fix4-dev6finish-dev07backbone.md)（勘误链完整） |
| DEV-07 | 正式 UI 接入（Electron+IPC+renderer） | **VERIFIED（G3 范围）**：CDP 真点击用户链路 11/11（发送/DONE/线程回复/跟进不新建根任务/草稿独立/仅记录/去重/IME/重载恢复/UI 停止/崩溃恢复门禁）+ 真实 codex UI 一轮（1 turn）；打包随包 Node 属 DEV-15 | `src/ui/` + `src/daemon/` + `src/contracts/daemonIpc.ts` | G3 ✓ | [reports/round-20260927-fix6-ui-e2e-g3-closeout.md](reports/round-20260927-fix6-ui-e2e-g3-closeout.md) |
| DEV-08 | 独立分析与互评（冻结名单、阶段过滤、报告校验） | **真实已验证（一组，29/29 审计）**：IND 隔离/CR 三元组/屏障经真实模型闭环（round-20260928）+fake 集成 | `src/daemon/deliberationRunner.ts` + `src/domain/deliberation/` | G4（价值闸门未做） | [reports/round-20260928-m1-closeout.md](reports/round-20260928-m1-closeout.md) |
| DEV-09 | 分歧与整合（争议、轮次预算、确认矩阵） | **无争议分支真实已验证**（SYN/RAT/共识矩阵 29/29）；讨论轮/checkpoint/缺席/迟到=受控用例已验、真实补证按需另排 | `src/daemon/deliberationRunner.ts` + `src/persistence/stores/deliberation.ts` | G4（价值闸门未做） | 同上 |
| DEV-10 | 第二 runtime（Claude Code）、跨 runtime 互评 | **IN_PROGRESS（真实认证：turn1 全链+受控中断均通过）**：deepseek-flash 实测可用；interrupt 按证据 supported（进程证据后停/无孤儿/不复活）；resume/restrict*/isolation=unverified（逐项按证据）；只读档正式机制组合（--permission-prompts none+--disallowedTools+--bare 等）；E4 调度解耦实装（detached+成员互斥）；剩余=resumeSession 真实续接+restrict* 拒写对照（B6） | `src/adapter/claude/cliAdapter.ts`、`src/daemon/memberRuntime.ts`、`src/daemon/dispatchWorker.ts` | G2/G4 | M2 | [round-20260928-dev10-interrupt-e4.md](reports/round-20260928-dev10-interrupt-e4.md) |
| DEV-11 | 自动分工（计划校验、子任务 DAG、交接、有限返工） | NOT_STARTED | `src/domain/` | G4 | M2 |
| DEV-12 | 修改与 diff（单写者、前后基线、审查版本、非破坏撤销） | **IMPLEMENTED（本地验证；第五轮四项修复后加固：扫描完整性（失败不静默+进入前物理核验+空目录合法）、撤销三态与最近祖先 realpath 重核、崩溃窗口三向恢复判定（补记不重执行/不误判冲突/failed 可续跑）、PhysicalWriteRootRegistry 统一写入占位（B6 接线点）；审查版本 UI 归 DEV-13/14）**：三态前像（present/absent/unknown——unknown 不推导）+内容寻址存储（双端 hash 核对+大小上限提前呈现）+Git 基线（HEAD+porcelain+未提交内容前像，不 stash/reset）+非 Git 整目录扫描（截断如实）+非破坏撤销（逐步重验当前==after、冲突不覆盖、单文件临时+rename、多文件逐步持久化可恢复续跑）+正式命令 changeset.captureBaseline/finalize/undo/get+单写者租约检查；反例 9/9+前像单元 6/6（临时 fixture 含临时 Git 仓库） | `src/daemon/preimage.ts`、`src/daemon/changeset.ts`、migrations/007 | RT-07/08（租约侧）/10 | [round-20260928-admission-exit-hardening.md](reports/round-20260928-admission-exit-hardening.md)；RT-08 派发侧完整用例待 B6 写档接线 |
| DEV-13 | 恢复与故障测试（不确定窗口、进程核对、成果一致性） | **IN_PROGRESS（第九轮保守判定+迟到回执原子）**：adapter 进程身份三模型+runtime_process_registry 登记+recovery.probeProcess 服务端取证+reconcile 服务端证据（probe 结果释放矩阵/probeId 引用校验/notStarted 人工分离=退款但租约保留）+Windows 错误分类+恢复面事实分层 UI（遗留租约行；人工声明不解除物理保护）+崩溃-重启 renderer e2e 反例；**真实 CLI 崩溃现场样本未跑**（零调用纪律）；剩余=成果一致性专项+DEV-05 supervisor 衔接（registry/probes 表已就绪） | `src/daemon/`（processCheck/processRegistry/commands/dispatchWorker） | G1/RT | M3；报告 round-20260929-process-evidence-repair-budget.md |
| DEV-14 | 三模式完整 UI、任务/成果/确认/诊断、设置、教程帮助 | **IN_PROGRESS（第十二轮 Git 执行对象收口）**：第十/十一轮读协议+写闭环+RT-24 主体+验收开关/正式闭环；第十二轮①提交绑定显式 refs/heads（同 OID 竞态反例+updatedRef 结果记录）②push 推不可变 OID refspec+目的地三重绑定（远端地址确认/严格旧头 force-with-lease/快进）+输出脱敏+不确定三态重试；pull 合入固化 OID；③commit.undo 弃 reset --mixed→ref 级 CAS 软回退（索引/工作区零接触+A/B 无损 fixture+重叠/merge 拒+崩溃重试）④hooks/gpgsign 检测阻塞；真实 GitHub 沙盒仓（授权新建）5/5 全经众说正式命令；剩余=设置页其余真实项、merge 多父 diff 视图 | `src/ui/` + `gitStatus.ts`、`gitWrite.ts` + commands + 迁移 016-018 | G5（进行中） | M3；报告 round-20260929-round12-git-binding-rec-life1-github.md |
| DEV-15 | Windows 安装/卸载/托盘/升级迁移 | **IN_PROGRESS（第十四轮：桌面便携产物已交付）**：①daemon.cjs 产物+verify-pack **17/17**（假通过修复：严格退出码/nmOverride/负例 SQLite 佐证；**bundle 内受管全链**——受管真实进程 turn DONE/task.stop→CANCELLED/截止 UNKNOWN→reconcile/probe/releaseProtection/daemon.shutdown→退出 0/无遗留；负例=移除 koffi 拒绝启动）；②**桌面便携产物** dist/desktop/众说-便携-win-x64（Electron 壳+随包 node.exe——daemon 不依赖开发 PATH；受管默认开=缺失明确失败 exit 1；优雅停机走 daemon.shutdown；中文+空格安装目录 verify-desktop **6/6**：首启/正常退出/重复启动/负例/无残留）；剩余=安装器/代码签名/自动更新/独立 Windows 机验证（本地可复核脚本已备） | scripts/pack-daemon.mjs+verify-pack.mjs+pack-desktop.mjs+verify-desktop.mjs | G5（进行中） | M3；报告 round-20260930-round14-envfix-jobid-pack-desktop.md |
| DEV-16 | 发布验收（集成、兼容矩阵、性能、G5 结论） | NOT_STARTED | — | G5 | 依赖 DEV-10—15、17—19、21—25 与适用 G0—G4 |
| DEV-18 | 未读与导航（水位、关注、搜索、收藏、深链、待我处理） | **VERIFIED（第二十五轮收口）**——覆盖范围注明：本地/命令层=dev18ReadPending 11/11+dev18FollowSearch 6/6（中文/过滤分页/同名跨项目/他人 DM/失效收藏/重启保持）；**页面层**=E18 同一次完整 17/17+FS 会话 10/10（搜索定位/收藏幂等/关注静音聚合）；真实 runtime=阅读与偏好零调用（E18/FS real_calls=0）。实现：markRead 三域（房间/线程/DM；幂等+未来水位+固定目标+代次防护）；mine.pending 权威汇总（reviewTasks/dmUnread/threadUnread/blockedTasks/reminderAwaits/followedThreads——muted 排除）；deepLink 四形态 audience；**关注/静音**（thread_subscriptions=人的阅读订阅与 thread_agent_followers 执行名单分列；零运行零预算；重启保持）；**搜索**（search.query 消息/线程锚/任务标题+附件随消息文件名（正文提取未实施如实）；范围/作者/日期/会话过滤+确定性分页；他人 DM 零泄露）；**收藏**（saved_refs 消息/链接/任务/交付；幂等；取消不删原内容；missing/forbidden 如实；跳转复用深链）。**剩余**：Activity 流/消息操作全集/惰性表情按交付矩阵归属未做项（不只剩三个名称就宣布全包） | `src/ui/`+`src/daemon/commands.ts` | RT-26/TH | M3 |
| DEV-19 | 房间协作视图（看板、Files 集合、附件、搜索） | **PARTIAL（二十六轮首包+二十七轮动作/Files）**：board.view 映射按任务/run 状态机（DONE=已完成列/停止代次不作停止证明/exitUnconfirmed=INTERRUPTED+turn UNKNOWN 事实）+看板动作行（task.stop/task.review 闭包钉死目标）+files.view 四类分列（项目文件/托管附件 audience+私信标注/Agent 草稿/交付深链）+thread.collaborators 四列——boardFormalStates 5/5 正式链六形态；剩余：跨项目汇总拖拽视图（不做状态直改） | `src/ui/` | TH/WPV | M3 |
| DEV-20 | 完整权限加固（ADR-14 后置项） | NOT_STARTED（后续） | — | RT-20 | 首版原生限制不后置（DEV-06/10/14 承担） |
| DEV-21 | 提示词/输出合同（M0 DIRECT → M3 DM/提醒/跟进） | **M0 段 VERIFIED**（fake+存储级；PP-01/12 随 DEV-06） | `src/contracts/prompts.ts` + `src/daemon/turnInput.ts` | PP-02/03/04/05 子集 | [reports/dev-21-m0-and-closure2-result.md](reports/dev-21-m0-and-closure2-result.md)：standing v0.1.1/turn v0.1.2/TaskComplete v1；根消息+历史正文真实注入；hash 一致；组装失败不派发 |
| DEV-22 | DM 持久化与实际执行（串行、暂停、权限、附件） | **VERIFIED（fake/本地协议+页面）**：串行队列+输入水位+停止/归档/恢复+验收+附件（DEV-24 通道已通——attachmentChannels）；真实续接 r20-dm 17/17 已补证 | `src/daemon/` | DM-BASE-01—08 | M3；契约已在 DEV-01 落 |
| DEV-23 | 提醒（一次/循环、occurrence 唯一、错过合并、通知） | **VERIFIED（第二十五轮正式合同版）**——覆盖范围注明：本地/fake=scheduler 20+boundary 8+formalChain 4（任意分钟/DST 规则/原子触发/崩溃窗口/独立连接并发/修复与追加不绕额度/争格恰一）；**页面**=REM 会话 9/9（到点待确认→确认执行→面板历史→通知权限+去重）；**真实 runtime**=r25-rem 批次（deepseek-flash 恰 2 次 startTurn 全 succeeded、模型双向一致、台账 settled×2——real-batches/r25-rem-result.md）；**通知**=桌面系统通知代码+页面验权限/去重（送达与点击定位真机人工面待复核）。实现：**调用台账 reminder_calls**（预算=模型调用数——修复/追加/重派在 worker 建 turn 前 acquireReminderTurnSlot 统一检查+持久预占；UNKNOWN/失败保守计数重启不清零；turn 前取消 released；max_triggers 触发上限分列）；命令事务（confirm/update/snooze 状态事务内重读核对+重放先命中回执；网关领域错透传保错误码；cancel 放宽 done+awaiting 并结算待确认项）；目标授权链（threadId/taskId 绑定=跟进既有任务不建新根+`task:{id}:reminder:` 键；owner 房间成员/冻结名单/DM 对端；停止代次按绑定快照——历史停止不永久禁止）；桌面通知（去重/点击定位/失败退页内不改授权）；**二十七轮验收入口闭环**：纯 ASCII 启动器（chcp 65001 含中文批处理行字节错位缺陷修复）+隔离环境 cmd 顶层内置+seed 停机如实化+backgroundThrottling:false（通知时延 2m11s→1s/14s）——干净环境实测全过+OS 层吐司显示视觉取证；**Windows 送达/点击人工复核已通过（2026-10-01 回填全符+工程只读核对一致+顺带确认执行链×2、real_calls=0——归档 evidence/notify-manual-acceptance-20261001.md；范围仅该 build 与该机）** | `src/daemon/reminderScheduler.ts`+`reminderDispatch.ts`+`reminderTemplate.ts`+`commands.ts`+`dispatchWorker.ts` | REM/FOLLOW | Web Push 等远程通知单列 |
| DEV-24 | 七类附件、评论、导出、共享预览 | **七类全落（二十九轮收口）**：文本/代码/图片/PDF/DOCX/XLSX+CSV/PPTX 四能力分列；**解析边界**=独立子进程（截止/取消/并发/内存/输出预算+受控故障证明 parseBoundary 6/6）；**完整性**=实根+realpath 实身份（junction/symlink——storeLinks 3/3）+受控句柄+sha256+字节截断；**幂等三层**=回执预查/同会话去重/跨会话缓存复用（缓存 schema v2 预算口径绑定——pdfCacheIdempotency 4/4）；**图片门禁**=IMAGE_INPUT_UNVERIFIED（确认后注入未发送说明）；**PDF 视觉渲染**=zsres+canvas（服务端零像素解码）；**表格范围注入**=range_spec 有界窗口（迁移 036）；评论=文本/代码首批（版本绑定+标旧）；预览面板视图全局化。剩余：Markdown 安全预览、共享预览完善（搜索/引用锚）、导出、图片/PDF/Office 评论锚点（分批归属）、OCR（未实现——新增服务先方案后询问） | `src/daemon/parseWorker.ts`+`parsePool.ts`+`parseContracts.ts`+`attachments.ts`+`commands.ts`+`turnInput.ts`+`src/ui/renderer/` | WPV-01—36 | M3 |
| DEV-25 | 本机/LAN 浏览器、配对/吊销、HTTPS/WSS | NOT_STARTED | `src/daemon/` | RT-21/LAN-01—08 | M3 |

## 统一准入/退出状态机/harness/工具审计（2026-09-28 第四轮）

详见 [reports/round-20260928-admission-shutdown-tools.md](reports/round-20260928-admission-shutdown-tools.md)。统一派发准入（global/project/provider/member+writeRoot 接入口、启动窗口占位、UNKNOWN 保留占用、预算并发不混用；7 组反例+修三缺陷含 DIRECT 截止中断误判 CANCELLED→UNKNOWN）；退出状态机（incomplete 不关库不释放锁、force 路径=杀+abort UNKNOWN 收尾后关库、退出码 0/3；本地反例全过）；real-delib stop 操作闭环（正式 task.stop 绑定代次→观察至可解释终态、taskkill 仅崩溃注入）；thread.toolCalls 命令+renderer 线程尾只读区块（domain_events 真源、隔离去重、集成 4/4）；DEV-12 前像捕获/diff 纯函数起步（临时 fixture）。

## DEV-10 受控中断认证 + 能力修正 + E4 解耦实装（2026-09-28 第三轮）

详见 [reports/round-20260928-dev10-interrupt-e4.md](reports/round-20260928-dev10-interrupt-e4.md)。受控中断真实认证通过（预算 1/1：进程证据后 2ms 停止、CANCELLED 全链、无交付/孤儿/复活、重启不复活；usage=0 如实）；能力声明逐项按证据修正（interrupt→supported，resume/restrict*/isolation→unverified；单一真源+probe/命令同步）；--allowedTools=预授权非总白名单取证+只读档正式机制组合+tool 事件落库审计（模型自述核对依据）；中断/收拢实装（停止/退出分离、INTERRUPTED、迟到 result 不交付、disposeAll 汇总、本地进程 fixture 6 用例）；E4 调度解耦实装（detached 消费器+成员互斥+租约续期+awaitInFlightTurns，假时钟 4 用例；修复 lateRecorded 误判与 SYN 在途预算误判两缺陷，detached 预算 20/20 与 inline 一致）。370/370、e2e fake 13/13、lint 0。

## DEV-10 真实认证轮：deepseek-flash + 启动安全 + 成员级生产接线（2026-09-28 深夜·二）

详见 [reports/round-20260928-dev10-real-auth.md](reports/round-20260928-dev10-real-auth.md)。渠道核对（http://192.0.2.10 代理、/v1/models 含裸 deepseek-flash、unrecognized_model=服务端透传且成功 turn 亦有该告警、`[1m]`=CLI 后缀语法被 adapter 拒绝）；启动路径安全（shell:false+原生 exe 解析+prompt 全文走 stdin+argv 固定+字符集校验+--verbose，特殊字符零额度反例）；resultKey 回放闭环（模拟器读 stdin 合同→DONE，错误 resultKey 反例）；成员级 runtime 生产接线（member.setRuntime/member.runtime 命令→绑定链→MemberRuntimeRegistry→worker adapterFor 两路径，未绑定回落默认、不可用 kind 如实抛错）；真实预算 2/2（1 次意外探活事故=settings env 优先于子进程 env+1 次 turn1 全链成功）；受控中断待批补 1 次。默认 360/360、lint 0。

## DEV-10 适配器实装 + dispatchWait 合同一致化（2026-09-28 深夜）

详见 [reports/round-20260928-dev10-adapter.md](reports/round-20260928-dev10-adapter.md)。Claude CLI adapter 实装（进程模型/--resume 续接/NDJSON 归一化/合成事件依据注明/能力三态/steer·审批拒绝）；零额度回放 8 用例+共用 worker 跨 runtime 成员绑定（fake+Claude 回放不串线、domain 无厂商分支）；dispatchWait 独立截止→unavailable（合同一致，与 absent 区分、可恢复、不重派旧键）；价值方案 v3（DIRECT 2/组+DELIB 9/组×3=33 待批，A 旧运行无确认选项）；E4 在途推进生产承载如实未完成（串行 drain 限制，M2 前置）。默认 353/353。

## M1 收口轮三：价值方案 v2 + E4 生产接线 + 建房 UI 链路 + DEV-10 启动（2026-09-28 晚）

- 价值方案 v2（m1-value-gate-proposal.md）：中性任务目标（协作流程不入共同正文）、逐行预算（A-DIRECT 3/A-DELIB 9/B/C 各 3+9，总新增 36；旧 A 运行标历史参考不复用）、评定者盲表述、合成 fixture=受控场景声明。**待批准，未调用模型**。
- E4 生产接线：approval.requested/input.requested→暂停起点（kv），续行事件结算 exec_paused_ms 并回 RUNNING——真实审批桥（fake waitApproval+respondApproval）集成验证：121ms 暂停窗正确累计、缺席判定扣除。dispatchWait 合同核对：排队超线只诊断不改成员状态（与"排队非成员责任"一致）；派发不可能（预算耗尽跳过）由屏障按 missing/缺席处理——既有收口语义覆盖。
- 审计 v3 四态（PASS/FAIL/NOT_APPLICABLE/NOT_VERIFIABLE）：历史运行 56 PASS/0 FAIL/2 N/A（清单机制晚于该运行，"历史版本缺此证据，无法验证"——不再计 FAIL 也不宣称通过）；派生证据记录（原始 WAL 三件 hash+重建工具+结论来源区分，evidence/m1-real-run-derived-db.md）。
- 建房用户链路 e2e（fake，13/13 之一）：建房→成员子集→切换→DELIB 发送→回复；两房主池/草稿（按房间键隔离）不串线。
- DEV-10：本机环境确认（零模型预算除 1 次探活）+ 契约核对成文；实施计划登记。
- 默认 344/344；UI e2e fake 13/13。

## M1 收口轮：真实研讨闭环 + 调度/E4/迟到/身份收口（2026-09-28）

详见 [reports/round-20260928-m1-closeout.md](reports/round-20260928-m1-closeout.md)。三次历史真实尝试完成 WAL 取证（两次=截止中断误判用户停止的缺陷、一次=CODEX_ERROR 正文未存档）；时钟注入/排队≠缺席/成员级缺席/迟到三分支/run 作用域派发键/确定性 RATIFY 收口全部零额度反例落地（331/331）；提交-观察分离 harness（scripts/real-delib.mjs）；**一组真实研讨完成**（7/9 预算精确、unanimous、29/29 逐项审计：隔离/三元组/冻结版本/矩阵共识/hash/预算账）；门禁改显式 opt-in。**价值闸门未做结论**。

## M1 第一轮：缺陷收口 + DELIBERATE 编排 + UI + 门禁开放（2026-09-27）

详见 [reports/round-20260927-m1-deliberation.md](reports/round-20260927-m1-deliberation.md)。四处缺陷（屏障冻结集合/三元组引用+run 范围 issueId/RATIFY 幂等+行数核对/成果发布协议）零额度反例收口（迁移 004/005）；DELIBERATE 全阶段持久化编排（确定性 dispatch_key 步骤、服务端输入隔离、E12 预算单一账、E4 假时钟缺席、停止作用于运行、一次格式修复）；研讨 UI（run.progress/report.get/@全体芯片/进度条/逐结论共识报告）；门禁按证据开放（entry 默认，worker 级默认关不变）。默认 323/323；UI e2e fake 12/12。**M1 价值闸门未做结论**（对比材料待预算）。

## 修复轮 6 + G3 收口（2026-09-27）

详见 [reports/round-20260927-fix6-ui-e2e-g3-closeout.md](reports/round-20260927-fix6-ui-e2e-g3-closeout.md)。证据口径修正（ZS_UI_DEMO=宿主内链路，非 UI 端到端；renderer app.js 此前从未成功执行——IIFE 修复）；R1-R5 renderer 全量接通（停止/恢复入口/room.pool+thread 目标/草稿去重 IME/重启恢复）；B1 管道 commandId 关联（超时迟到响应丢弃反例）；B2 生命周期收口（drain 收敛/重复 stop/关库后零写入）；CDP 驱动 UI e2e fake 11/11 + 真实 codex 1 turn（UIE2E-CODEX-6666）；同成员排队用例补齐；IPC 协议下沉 contracts/daemonIpc.ts（边界违规清零，ADR-I41/I42）。默认 276/276。**G3 收口，进入 M1。**

## 修复轮 4 + DEV-06 收口 + DEV-07 骨干（2026-09-27）

详见 [reports/round-20260927-fix4-dev6finish-dev07backbone.md](reports/round-20260927-fix4-dev6finish-dev07backbone.md)。B6 证据绑定共享验证器（declined/sandbox-denial 可辨识原因，7 负例）；锁未知身份一律 BUSY+代次校验接管（ADR-I34）；DEV-06 剩余认证 5/5（steer 正常+服务端拒/审批 allow/resume 不放宽/usageTokens/interrupt）；DEV-07 骨干落地（commands/entry/pipeClient + smoke：project.open→message.submit→worker→事件→重启门禁→resume 续跑）；顺带修复孤儿租约重排与 fake 会话 id 唯一。

## 修复轮 3（2026-09-27，用户复核三项后）

协议/锁/B6 收口（详见 [reports/dev-06-fixround3-result.md](reports/dev-06-fixround3-result.md)）：turn/started|completed 只认 turn.id（mock 去伪字段）+awaiting 按会话隔离+响应解析同步点注册映射（未知归属终态在 adapter 层不带内部 turnId、worker 层审计不终结当前轮）；锁身份写入窗口（半写入≠已死，mtime 宽限，onBeforeClaimIdentity 同步点无双持有）；B6 证据绑定（指定工具+toolCallId 配对+目标路径+resultRef 拒绝原因）。真实认证新增：steer 错误 ID 拒绝、resume 跨进程续接（暗号恢复）、审批桥 deny（read-only+on-request 触发 approval.requested→deny→无写入）。默认 260/260；e2e 7/7（gpt-6-luna）。

## 修复轮 2（2026-09-27，GPT 复核 7 项后）

外部复核的协议与边界缺陷全部整改（详见 [reports/dev-06-fixround2-result.md](reports/dev-06-fixround2-result.md)）：终态按 turn.status 映射、事件按 provider turn 归属（awaiting 机制）、进程代次+initialized 通知+resume 接线、worker 完成
路径接 TaskComplete schema（非法输出 OUTPUT_INVALID 零交付）、B6 断言收紧（工具活动证据+内容变化断言+额度排除）、能力自报收窄（仅 structuredEvents=supported）、单实例锁目录协议重写（mkdir claim 原子接管）。本地协议回放 mock（tests/fixtures/mockAppServer.mjs）8 用例覆盖终态各态/迟到/早到/审批/重建——**零模型额度**。真实 e2e（gpt-6-luna）：C1 文件回流+层 A+计划档直接编辑/shell 两路径 4/4 通过。

## 收口轮 2（2026-09-27，GPT 复核意见后）

单实例锁（创建中窗口不接管/二次读取/读回核对+受控窗口反例）、恢复门禁覆盖已提交未领取分支（RT-02 改门禁化）、interrupt 挂起宽限仍生效（限时发送+定时器清理）。详见 [reports/dev-21-m0-and-closure2-result.md](reports/dev-21-m0-and-closure2-result.md)。

## M0 核心修复轮（2026-09-27，外部只读审查后）

外部审查发现 8 项缺陷 + 2 项记录错误，全部修复（`tests/integration/m0Fixes.test.ts` 等新增反例；`pnpm check` 222/222）：

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 过期租约被绕过（acquire 只查 active）+ RT-07 测试假阳性（未真正过期） | acquire 检查全部未释放租约（active+expired）；测试先断言 expired 再验阻塞 |
| 2 | worker 超时依赖新事件到达（沉默 runtime 永不超时） | 独立截止计时 + 中断宽限；沉默→中断 CANCELLED、中断无响应→UNKNOWN 两用例 |
| 3 | 会话打开期间停止失效、之后仍启动 | openSession 后复查停止代次/终态→不 startTurn、取消收尾+审计；竞态用例（openSessionDelayMs 400ms 窗口内停止） |
| 4 | 恢复无执行约束（pending 会被直接领取）+ 重领与既有 turn 唯一键冲突 | 迁移 003 daemon_state + 派发门禁（applyRecovery 落 held、openDispatchGate 用户确认放行、worker 检查）；dispatch_key 已有 turn→failOutbox+reconcileRequired 审计（RT-03 语义） |
| 5 | 单实例锁 check-then-write 非原子 | O_EXCL 独占创建 + 陈旧锁原子 rename 接管；真实双进程竞态用例（恰好一个赢家） |
| 6 | 上下文过滤不足（directive/summary/file 无归属校验）+未接入派发路径 | 白名单化（allowedDirectives/Summaries/BaselineIds）+ 3 反例；worker 组装 ContextBundle（过滤+落库+真实输入文本）；同成员双任务 bundle 隔离用例 |
| 7 | replyAdded 事件 ID 与库内消息 ID 不一致 | 事件 payload 用实际 rowId；断言按事件可查到消息 |
| 8 | worker 不拒绝 AUTO/DELIBERATE、完成不按验收策略收尾 | 模式门禁（非 DIRECT→BLOCKED+审计）；user_review→REVIEW+pending 交付、auto_deliver→DONE+not_required |
| 记A | 总账 DEV-04/05/17 双记录、"下一步"指向已完成的 DEV-04 | 本文件整体重写 |
| 记B | parallel_writers 可经调用参数开启（违反延期基线） | 入口一律拒绝（ADR-I19），放行测试改为拒绝测试 |

修复过程中额外发现并修复 2 个新缺陷：worker 事件竞速丢弃 pending 的 iterator.next() 会吞事件（async iterator 禁止并发 next）；IPC 同 socket 并发处理导致响应乱序（改行 FIFO 串行）。

## FULL 阶段（v0.1 后）

| 包 | 完整交付目标 | 状态 | 阻塞/前置 |
|---|---|---|---|
| FULL-01 | 完整导航、频道设置/角色、成员资料、Activity/Saved/Search | NOT_STARTED | 多人身份子项接 FULL-05 |
| FULL-02 | 全部任务入口、认领/审阅、完整看板、DM 与附件 | NOT_STARTED | 私信仍一对一 |
| FULL-03 | 多格式预览、五类锚点评论、消息图片导出 | NOT_STARTED | 每类格式独立验收 |
| FULL-04 | 完整 runtime 目录/配置、Agent 详情、生命周期、诊断 | NOT_STARTED | 每个 runtime 单独认证 |
| FULL-05 | 账号/邀请、多人、多机、浏览器/PWA/移动 | NOT_STARTED | 先补 ADR-10 身份/部署/同步方案 |
| FULL-06 | 外部 Agent、设备授权、桥接与框架接入 | NOT_STARTED | 凭据与范围可验证 |
| FULL-07 | Connected Apps、OAuth/OIDC、市场、manifest | NOT_STARTED | 先稳定 installation/grant 合同 |
| FULL-08 | Agent Events、App Notifications、Service CLI | NOT_STARTED | 依 FULL-07 |
| FULL-09 | 联邦频道与跨空间同步 | NOT_STARTED | 依 FULL-05；先定联邦权限与撤权 |
| FULL-10 | 套餐权益/计费入口、账号数据、完整帮助 | NOT_STARTED | **BLOCKED（商业参数）**：真实商户/价格/收款账户需用户提供；配置模型、权益判断、数据请求、测试支付适配可先行 |
| FULL-11 | MCP 本体（12 工具、连接授权、审计） | NOT_STARTED | 依 M3 命令面 + DEV-25/RT-21；§31.1 五条预留条款已由 DEV-01 落地 |
| DEV-20 | 完整权限加固 | NOT_STARTED | 后续实施，按 runtime/平台逐项验证 |

## 明确延期项（授权范围外，不得擅自恢复）

- 多 Agent 并行写入增强（write_intent、写范围校验、跨任务变更请求、整合闸门）、按任务 worktree（主设计 §14.7，2026-09-26 延期）。当前仅 `single_writer`；`parallel_writers` 在租约入口被拒绝（ADR-I19），契约类型保留待后续批准。

## 阻塞登记

| 事项 | 影响范围 | 状态 |
|---|---|---|
| deepseek-flash 渠道在当前 ChatGPT 登录态不可用（400） | e2e 模型选择 | 已切换 gpt-6-luna（用户指定型号）通过；可用 ZS_E2E_MODEL 环境变量覆盖 |
| FULL-10 商业参数（定价/商户/法务）未提供 | FULL-10 生产集成 | 已登记；无依赖部分可先行，不阻塞其他包 |

## 下一步（按依赖）

1. **DEV-06**（真实 runtime，Codex App Server 专用 fixture 适配认证）：防线与输入合同已就绪（隔离/门禁/停止/恢复/预算/DEV-21-M0 信封）；先 probe 版本/能力，再 initialize→thread.start→turn.start 真实路径；B6/RT-23 档位认证未过前 UI 档位禁用；PP-01/PP-12 注入验证随本包联合完成。
2. **DEV-07**（Electron main/preload + 命名管道 IPC 接线 + hifi-prototype 交互复用接真实命令面）→ G3 演示。
