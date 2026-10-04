# 第45/46轮复核与第47轮首包收口（2026-10-04）

基线`8bcfafa`；第45轮为`144b9ac`。本次不修改产品源码、原型、v6、用户数据/结果或证书。独立探针在`dist/desktop/review-r46/`，使用内存daemon或隔离隐藏窗口，零worker/真实模型调用。

## 1. 保留新界面主线，首包仍以R48为目标

11件批准组件/类型/selector/样式与原型逐字节一致，确有复用；但原型的同步mock操作不能直接充当正式发送合同。“原样复用”指保留已批准的视觉与交互，不是冻结会导致丢草稿、虚假权限、无效点击的代码。允许在正式侧增适配props/异步回执/能力判定，原型参照工程保持不动。

不等Android或所有剩余功能才交H1；R47修核心命令、异步发送与新旧接管，R48交用户可运行首包。暂未换装能力仍需可达且有准确入口，不能以换装造成原有发送/停止/预览功能消失或误导。

## 2. 第45轮修复有独立证据

独立跑`legacyProtectionUpgrade.test.ts`与`dmReviewContract.test.ts`：2文件9/9通过。045已正确用Object.hasOwn区分缺字段/损坏probe；DM返工在打开意见框时捕获目标，并拒绝跨会话确认。没有重跑全部852项，不扩大本次验证范围。

用户v6四项已经收案，Android指南已使用v6实际CA/地址和确定性后台标记；现有v6继续供用户验收，H1不覆盖它。

## 3. [P1] 第46轮“真实链路”仍被正式合同拒绝

探针`hifi-contract-probe.mjs`用esbuild直接打包当前产品loader/store，window.zs转发真实`dispatchDaemonCommand`，内存数据库；正式project.open创建独立fixture后读正式响应，未启动worker。原始结果`hifi-contract-result.json`。

- `openProjectByPath`传`{rootPath}`；正式project.open要求`{path}`，返回VALIDATION_INVALID。
- `sendRoomRoot`的target缺`roomId`，默认派发与record_only都会返回VALIDATION_INVALID；相同内存环境按正式完整target的记录发送成功，排除fixture不可用。
- `refreshRooms`不填房间`memberIds`；Composer按room.memberIds生成@候选，因此实际项目2名agent而候选数0。应通过`member.list({projectId,roomId})`获取真实房间名单，不能把全部项目agent当所有房间成员。
- mentionIds里的`all`被映成`{kind:'member',memberId:'all'}`，正式合同需要`{kind:'all'}`。此项是实际发出信封证据；当前请求先被缺roomId拦，未声称已到后端路由反例。

verify-hifi-shell的传输桩无条件接受project.open和message.submit，只断言method/target.kind，故3/3无法发现这些错误。报告应改为“组件控制流/信封冒烟”，不能说正式后台发送闭环已通过。

R47用打包UI→实际preload/正式daemon→独立fake数据库/worker补：开真实目录、房间指定1人派发、仅记录（消息存在且run/预算零新增）、DM派发/历史到达、成功重启后历史存在；回执/DB状态比对，不仅看信封存在。房间无@遇当前能力门应准确报错，不能按原型AUTO文案冒充已开放。

## 4. [P1] 发送失败丢草稿，发送身份未沿用

原样Composer的submit调用void onSend后立刻清正文/@/附件、换commandId，微任务即解锁。RoomPage/DmPage发异步Promise却不返回、catch吞错。loader并没有对应错误toast，注释“错误已呈现”不成立。

页面探针`hifi-ui-boundary-probe.cjs`读取当前dist/ui真实React/CSS，仅传输返回延迟900ms的CONTROLLED_FAILURE，独立userData隐藏窗口：发送尚在途200ms正文已空；失败后仍空、errorText=null。原始结果`hifi-ui-boundary-result.json`。没有真实网络或用户操作。

bridge又丢掉Composer.commandId，自己生成新的Date.now+seq；结果未知时重试可能生成新业务请求，既有幂等合同没有接上。

正式适配必须await可判定的发送结果：确定失败保留目标键下正文/@/refs/意图并给行内错误；未知结果保留同一信封/同commandId重试；确认成功只清该信封实际内容（等待期继续编辑的内容保留），只在成功后复位一次性record；提交已成功但刷新失败应另记，不能当发送失败重发。覆盖A→B→A草稿、异步返回、双击/IME、网络丢响应重试、确定失败后修正新发、成功期间编辑。

附件尚未接H2可以暂禁用并指向原界面；目前按钮仍追加空name描述符、随后发送拒绝且Composer清正文，应在点击前如实阻断。权限/计划/完整访问/分工等原型选项不得可选却被loader忽略；按已认证有效能力呈现，未接时禁用并说明，保持原型样式而调整真实行为。

## 5. [P1/P2] 首启、迟到数据与阅读水位需继承既有合同

- `bootRemembered`只查一次，且吞错只写bootError（App未显示）；种子路径在窗口出现后写入时，旧首启空侧栏会复发。恢复已做过的有界等待/取消/重连机制并可见错误，不靠reload。
- `refreshMembers/Rooms/Dms`捕获请求时项目A，却在落结果时用prev.activeProjectId：探针延迟正式room.list响应、切到B后放行，A房间被赋projectId=B。加请求项目身份/装载代次门，切项目清晰保留/替换正确快照；A→B→A同样覆盖，不只按当前ID相等。
- 正式conversation.history返回snake_case。body/author/seq有兼容，`created_at`没有：探针原时间1600000000000被改为当前Date.now。这不能伪造时间，按实际字段映射，未知不编造。
- loadDmHistory在请求完成后直接可能markRead，没有前台、贴底、当前导航代次条件；后续加轮询时必须把原有阅读合同一起接入，不让后台读取清用户未读。读失败/空态分开，不能把旧快照清成“暂无”。
- H1目前没有周期/事件刷新，worker回复只能等重新进入才看到；这是已登记R47待办，适合统一订阅/刷新生命周期，不为每页重复起泵。

## 6. [P2] 原界面接管要定位入口与暂停后台

同一页面探针点击「任务看板」后legacyOn=true，但实际#board display=none、hidden=true、标题“主对话池”。原因takeLegacy只切body并记reason，没有按目标打开对应页面。设置/Files/待我处理等同理需检查。

接管携带project/room/conversation/task/资源目标，通过已有正式导航动作到正确面板，不能要求用户在旧界面再找一次。返回新界面清legacyActive、恢复原目标并刷新数据；暂停隐藏端轮询/取消在途装载，避免新泵加上后双轮询、后台markRead和项目漂移。现有legacyStart只延迟首次boot，启动后schedulePoll不会因返回而停止。

探针还确认legacy接管时hifi/app.css仍激活（全局sidebar/msg/button/body等选择器）。这只是样式仍在的事实，未逐项判全部旧界面样式损坏；R47做新旧边界隔离或确定的样式启停，并用实际默认hifi→legacy→hifi验证。nohifi专项7/7不能代表共存场景已验证。

动态import失败和React运行错误回退需可靠：main的try不能捕获异步render，error监听只匹配message含hifi也不足。增加明确ErrorBoundary/模块失败处理或启动握手门；数据错误可重试，不能静默留空，也不把普通可恢复读失败一律切旧界面。

## 7. 交付门与节奏

R47先完成上述H1必要条件与独立UI tsconfig（DOM/JSX/Bundler类型门；当前根typecheck排除hifi）。不用unknown-as-AppState或大量any/ts-nocheck掩盖正式模型缺字段；建立具体真实投影类型，继续复用批准组件。页间宽度/消息气泡按当前原型同窗口尺寸对照，保留实际截图，旧“未知成员”截图历史化。

R48交H1候选：默认新界面实际执行闭环+原界面定向接管、源码/打包身份、同冻结产物适用回归、真实启动器。--no-hifi只作旧界面对照，不能把只跑逃生口算默认新界面全绿。未换装区域列清单；操作入口不得假成功/无响应。H2/H3按已定顺序继续，首包不绑所有剩余功能。

不增加用户Windows重测或新资源/付费服务，不阻碍现有v6 Android。继续A+Word、B不集成不下载、零新增真实模型调用；旧证据及价值评价/DEV-11/并行写入约定不变。全套H1–H4轮次是施工估计，按交付证据更新，不冒充截止保证。
