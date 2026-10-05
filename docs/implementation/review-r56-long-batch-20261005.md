# 第五十六轮复核与下一长批次（2026-10-05）

基线：源码 `ea2c998`，H4-v1 `bld_9505e0b4e980e83c`。本次只读复核产品源码与交付文件，探针、临时项目和 Electron profile 均在独立目录；未改用户包、server-data、RESULTS、证书或已有真实调用证据。未新增真实模型调用。

## 1. 已确认的进展及复核边界

- H4-v1 清单核对 **591/591**，独立探针运行前后均无文件哈希差异。
- 原 `memberQueueContractR56` **3/3 通过**；独立 hifi typecheck 通过。
- 用实际 H4-v1 UI bundle × 当前源码正式 daemon × FakeRuntimeAdapter × 独立内存库复跑页面探针，`audit-result-v4.json` 的原有 **22/22** 子项通过。该验证不是包内 daemon 启动器与 OS 停机的独立重验，不扩张它的覆盖声明。
- 增加实际 UI 反例后，已复现下列缺口。原 22 项通过不能替代这些未覆盖路径。后一次 `audit-result-v5.json` 原有 TA_artifacts 未通过（v2/pending 呈现断言为 false，其余 21 项通过），旧成功和失败都保留，不能挑成功报告称稳定。先查夹具的异步完成/交付注入时序与真实 DTO，再判断是否为产品缺陷。
- 当前提交的**主 typecheck 不通过**，详见 §5；不能继续沿用“双干净”的说法。

证据目录：`dist/desktop/review-r56-audit-20261005/`。索引 `audit-summary.json`；页面反例 `audit-result-v4.json`、`audit-result-v5.json`；恢复准入 `queue-retained-result.json`；清单 `package-identity.json`、`package-identity-after.json`。前三次页面审计因审计夹具/等待条件未满足而停止，结果原样保留；最终反例以 v4/v5 为准。

## 2. P1：恢复后同成员准入未继承保留保护

独立 probe 基于本轮正式队列测试夹具，经正式 message.submit 建立同成员的两个不同任务，第一项 fake turn 在途时 applyRecovery，明确将旧 turn 的持久保护设为 retained。随后 dispatch.resume{confirm:true}，构造新 worker 派发第二任务。

事实：

```text
旧 turn（前）：member=mA, status=UNKNOWN, protection_state=retained
确认继续：dispatch.resume {confirm:true}
新 worker：第二任务 startTurn，任务 DONE，turn SUCCEEDED
旧 turn（后）：status=UNKNOWN, protection_state=retained
实际 startTurn 次数：2
```

源码关联：`DispatchWorker` 构造新 `DispatchAdmission`；成员串行仅查内存 held；dispatch.resume 仅开 gate；同任务 redispatch 拦截不覆盖同成员的另一任务。`admission.ts` 与 notStarted 对账合同明确 UNKNOWN/保护未解除须保留准入占用。因此“旧任务无法重派”不能证明跨重启同成员准入已安全闭环。R56 测试②当前把旧 UNKNOWN 未收口时另一任务成功派发当正例，恰好漏了这层。

**修复要求**：依据持久在途/UNKNOWN/retained 事实恢复或核验准入占位；confirm 只能确认调度，不得被当成退出证明。覆盖无租约 retained、notStarted 后 FAILED/refunded 但仍 retained，及既有 global/project/provider/member 限额。允许不冲突工作按既有额度继续，不增并行、不清库、不改预算或伪造 released。保护解除须经过正式服务端证据链，释放后排队项恰一次继续。

**补证要求**：文件库关闭重开或独立进程重启、新 worker；未对账/keepUnknown/notStarted-retained/正式释放四类，先证明同成员零新增 startTurn，再证明正式解除后恰一次。明确本次独立反例是 fresh-worker/恢复库状态模拟，并未声称已做真实 OS 崩溃重启；下一批要补后一种覆盖。纠正 continuation/capability map 对“跨重启保护已核清”的结论，保留原报告。

## 3. P1：新 DM 返工命令字段错误

`DmPage.submitReview` 发 changes_requested 时传 `reviewComment`，正式 task.review 的 strictObject 只接受 `note`。实际页面信封得到：

```text
VALIDATION_INVALID: Unrecognized key: "reviewComment"
```

这不是版本过期；合法意见也无法返工。当前探针 TDM 只测 accept，没测返工。线程既有 `submitTaskReview` 已正确传 note。

**要求**：共用正确的正式合同/提交适配器；实际 React 页面验证 DM 返工成功、note 入正式记录并进入后续返工输入、任务回 ACTIVE，新交付再次验收 DONE。错误类型要准确呈现，确定失败保留可修正的意见，不一律称“交付可能更新”并丢文本。不得新增模型调用；使用真实 daemon/fake worker。

## 4. P1：DM 操作框跨会话误提交

独立页面证据中的 A、B 是不同正式 DM、不同 task/delivery/hash，**revision 都为 1**。

1. A 打开验收框 → 切 B（头部已显示 AUDIT-DM-B） → 页面仍有“确认验收” → 点击实际提交 A 三重身份。服务端合法接受，**A DONE，B REVIEW**。服务端无法知道用户当前在看 B；冻结三重身份本身不能解决跨会话 UI 作废。
2. A 打开重命名并填 AUDIT-NEW-TITLE-FOR-A → 切 B → 输入框还在 → 保存使用当前 B 的 conversationId/revision。实际 **B 被改名，A 名称不变**。
3. A 的返工意见也会继续显示在 B；暂被 §3 错字段阻断，修字段后必须同步修目标归属，不能单改字段。

根因：`reviewBox`/`renaming`/`renameText` 没有随 activeId 作废，review 渲染只比 revision，不比 task/delivery/hash/会话。改稿后当前代码还可能只显示作废提示，却不给关闭入口。

**要求**：打开编辑框时捕获项目+会话+操作目标快照；跨项目/会话明确作废、零提交；同会话交付更新按完整身份判定，作废框随时可关闭重开；提交时再查当前归属。重命名不能提交时重新读取另一个 active。检查线程同类操作框及迟到回执/忙态/刷新归属；保留本来正确的发送草稿按键隔离。

**页面补证**：accept/rework 各测“相同 revision 不同 delivery”的 A→B 反例；重命名 A→B；同会话更版/交付消失；迟到回执回到其它目标。以 command 零发出和两侧 DB 不变验证作废，不只测弹框消失。

## 5. 构建门与命令面板事实修正

### 主 typecheck 当前失败

实际运行 `.\node_modules\.bin\tsc.cmd --noEmit`，退出码 1：

```text
tests/integration/memberQueueContractR56.test.ts(106,23): TS2532
tests/integration/memberQueueContractR56.test.ts(147,12): TS18048
tests/integration/memberQueueContractR56.test.ts(148,12): TS2532
tests/integration/memberQueueContractR56.test.ts(169,12): TS2532
```

均为数组索引结果可能 undefined。独立 hifi typecheck 退出码 0，队列测试3/3不等于主类型门通过。按事实检查/收窄类型修正，不排除测试或关闭 strict/noUncheckedIndexedAccess。最终报告必须绑定实际待提交/构建状态运行主与 hifi 两门；若项目 check 包含 lint，也明确实际结果。

### Ctrl+K 任务状态读错 DTO

实际候选 UI 三张任务项显示 `任务 · undefined`；board.view 返回的是 taskStatus（REVIEW）/runStatus，而 Palette 自声明了不存在的 status。映射正式 DTO，用户状态友好呈现。不能靠自写响应接口让 typecheck 自证合同正确。

同时 `locateGo.catch` 与 board.view.catch 静默吞错；openExternalDeepLink 自身只抛错、不负责 toast，注释“全局 toast 呈现”不成立。任务聚合失败与定位被拒要有明确反馈，保持其它导航可用，不能默认为没有任务。

## 6. 下一长批次：首次使用入口与综合稳定性

在 §2–§5 收口后，继续完成以下无依赖工作，用户短测反馈可随时插队；不要完成一小项就停下来等下一轮提示。分小提交便于复核，不要求为了凑时长扩范围。

1. **无种子的首次启动**：当前 bootRemembered 在已成功读到空记忆时仍循环60秒，最后称启动失败；分清正常无项目/服务未就绪/断连/记忆路径失效。正常无项目立即给批准原型的欢迎/打开项目入口，服务未就绪按真实状态重试。记忆路径失效仍能选择其它目录。
2. **打开/切换项目始终可达**：当前项目已打开后侧栏项目按钮无处理器，打开文件夹按钮仅无项目时可见；提供按原型的常驻打开/切换入口，不靠手填启动设置再重启。跨项目的路由、草稿、待提交操作、迟到响应与水位归属一起验证。只用独立临时目录，不写用户实际项目或覆盖包内演练数据。
3. **日常流程**：DM 创建空闲会话→发送/排队→停止→确认继续→返工/新交付/验收→导出→归档恢复；线程关注/静音→离开后新增回复→待办定位→引用/附件→搜索旧消息；恢复 UI 四动作仍各守正式门。未完成/只读/未认证能力准确说明，原界面 Git 写与 runtime 绑定入口保留定向可达。
4. **原型与使用体验收尾**：保持 hifi-prototype 设计，不重画；工程 id/hash/英文状态/施工轮次放可展开诊断，普通流程显示用户能理解的状态，关键版本/归属和恢复保护原因仍清楚。小窗/缩放/键盘与焦点返回/断连重连/大历史与多次刷新/连续预览开关按实测发现修；记录性能与资源事实，不靠恒真或延长超时遮问题。
5. **验证器自身**：排查 TA_artifacts 的失败，夹具要等真实 worker 完成后再注入指定交付，不能事后 UPDATE 状态掩盖业务事实；扩验前述反例，负例实际运行，顶层 pass 纳入每个必需断言。源码页测、最终包测、用户手测分别记范围。

## 7. 一次候选交付与用户操作

- 旧 H4-v1/H3/H2/v6 和用户结果稳定保留；工程修复在源码/独立测试副本；必要时只交一个新的 H4-v2 或清晰命名的收尾候选，不原位重建旧目录。
- 构建完成后冻结同一个最终产物，三连首启/复用/重启留 runId、BUILD/清单前后哈希、真实启动器、优雅停机/PID归零/batExit、real_calls=0。若需验证旧数据升级与回退，在副本上证明，不清库或换 CA。
- 用户当前尚未回填 H4 新8项；不写用户 PASS。**先完成这些会误操作的修复，再给一次集中短测**，不用用户帮工程造跨会话竞态或 UNKNOWN。H3/旧H2通过项不反复要求。
- 短测前置要可执行：DM 明确“+Guide A 新建空闲会话”，避免种子暂停/忙碌链；关注未读需离开后产生新回复，已经标读的历史不应被写成必然出现；日期步骤区分“截止昨天”和“今天范围”，关闭放最后。给具体点击步骤、预期、恢复步骤与 NOT_RUN 条件，不要求 DevTools/SQL。
- Android 继续现有 v6 单独回填；A+Word 不变、B 不集成、零新增真实调用；价值评价/DEV-11/并行写入不重开，G5 不连带宣布。新付费资源/新增真实调用如确需另列具体用途与成本等待用户决定。

本批目标：从“入口已接上”推进到“操作不会错对象、恢复守卫不被重启绕过、无种子也能顺利打开项目”的可日用候选；不再靠增加页面或报告数量衡量完成。
