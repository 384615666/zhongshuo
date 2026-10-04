# 第47轮复核与第48轮H1首包交付要求（2026-10-04）

基线`0b8dacb`。本次不修改产品源码、原型、v6或用户数据/证据，只新增本文及独立`dist/desktop/review-r47/`探针。探针用独立隐藏Electron窗口/配置或受控命令响应；另有真实内存命令网关对照，无用户库、worker或真实模型调用。

## 1. 主体修复成立，R48继续交首包

独立跑hifiFirstPackage、legacyProtectionUpgrade、dmReviewContract：3文件10/10通过；独立`tsc --noEmit -p tsconfig.hifi.json`通过。未重跑全部853项。项目path、roomId、房间名单、all映射、created_at修复及发送服务拒绝保留正文方向正确，类型门已进入check。

注意分层：hifiFirstPackage是当前loader/store/bridge打包后直连正式dispatchDaemonCommand和fake worker，没有加载React页面、Electron正式preload、独立daemon进程或真实IPC管道；它是有效的前端数据层×业务链测试，但不能称完整“打包UI→正式preload→daemon”。6项页面支架仍为模拟传输冒烟，报告已部分纠正；R48应补最终产物默认hifi的完整链，不仅--no-hifi旧界面对照。

## 2. [P1] 结果未知需要固定完整信封，不只是命令号

当前Composer不知道pending envelope，只留commandIdRef。unknown后允许修改正文，再点发送会重新用当前body/mentions/intent/target组包，沿用旧号但改变参数。

`hifi-send-lifecycle-probe.cjs`加载当前实际dist/ui React/CSS，独立传输控制器模拟“服务已接收，回执丢失”：首次body=`原信封正文`，编辑后重试body=`原信封正文 + 等待期间的新正文`，两次commandId相同，页面出现IDEMPOTENCY_CONFLICT。受控服务只登记一份原提交；未声称真实daemon在此窗口执行了业务。

另以真实内存网关做独立对照`gateway-replay-probe.mjs`：同号原body提交成功→同号改body返回IDEMPOTENCY_CONFLICT→同号原body重放成功，messages=1、real_calls=0。结果分别在send-lifecycle-result.json与gateway-replay-result.json。

现有测试rejectNext发生在服务端收到之前，随后一直用相同正文；证明了相同请求幂等，但不覆盖真实危险窗口“提交已成功、回执未知、用户继续编辑”。

修复：建立按完整目标草稿键持有的不可变信封（commandId+原target/body/mentions/intent/refs），未知重试严格重发原信封；新编辑内容留作新草稿。区分重试旧信封与提交新草稿的动作/反馈，切走再回来也保留未知身份，不能draftKey effect直接换号后重发原内容。首次调用同步异常/Promise拒绝也按是否已取得明确业务回执分类，不把无证据的传输错当确定失败新号重发。

## 3. [P1] 迟到成功清错目标草稿

同一页面探针第二段：A房间发`共同前缀`，成功回执受控延迟1200ms；期间切到B并输入`共同前缀 + B的草稿`。回执到达时，B输入变成`+ B的草稿`；回A后A草稿仍是`共同前缀`。实际JSON保留前后值。

原因：RoomPage/DmPage切目标时复用Composer实例；异步clearSentContent调用当前组件的setBody，没绑发起时draftKey。按字符串前缀删字并不是目标归属。新commandId/发送锁/错误行也随当前组件指针共享，需一并按信封生命周期隔离。

修复：成功结算先定位发起目标键，只扣该信封对应内容；界面仍显示该键时才更新当前输入。不用“任何同前缀都可扣”代替编辑身份，等待期修改旧文本应保留，用户新写同样文本也不当然已发送。覆盖房间A→B→A、私信A→B→A及目标组件卸载后回执；未知信封与新草稿分列，记录意图也不影响另一目标。UI断言与真实fake业务状态分别核对，不只测loader。

## 4. [P2] 准入代次与标读仍只守住部分异步窗口

`hifi-loader-race-probe.mjs`直接打包当前产品loader/store、受控响应，未操作用户UI/daemon：

- `openProjectByPath`的loadGen在project.open响应之后才加。先请求A延迟、再请求B完成，B已成为当前项目；随后A响应把当前项目改回A。归属门保护了后续成员/房间请求，却没有保护打开项目本身。请求入口先分配代次，任何await后重查；用户较新的选择胜出，启动自动恢复不能覆盖手动打开。
- 读取dmA时markRead=true，期间切到dmB、页面hidden并进入legacy；A响应回来仍发conversation.markRead(dmA,7)。opts是请求前的快照；stillCurrent只核项目/装载代次，没有当前会话/视图代次、此刻前台/焦点/贴底。缓存可按A键写，但不能把后台读取当作读完。

原始结果loader-race-result.json。无真实水位写入，不声称用户现场已发生。

提交标读前重查当前实体+导航代次+前台/焦点+贴底条件，DM发送成功后现在硬传markRead:true也须走统一门。覆盖A→B→A、发送后切走、滚看历史、响应期间进入后台/legacy。不要因R48要出包把既有阅读合同放宽。

## 5. 接管与空态的少量收尾

- roster读取catch返回null再映为[]：成员请求失败会被呈现成“暂无成员”，且coordinatorMemberId取首个成员也不是服务端协调者事实。失败保留正确旧名单并就地报错，未取得名单暂停派发；不要伪造实体属性。房间archived字段也应映射并按既有规则呈现。
- takeLegacy当前只传目标类别，没有当前项目/会话/资源身份；H1尚未接附件、停止/验收/归档时应给当前会话“在原界面打开”的具体落点，不能让用户在另一默认房间重新找。
- 待我处理locate使用`scrollIntoView(...) ?? '未找到...'`；该方法正常返回undefined，因此找到元素也报定位失败。改成先判断元素存在，再执行滚动并返回null。
- 文件与Git入口只打开Files集合、设置入口实际打开帮助区；标签与真实落点要对应，确实未换装的能力给清楚的原界面入口。不要以控件存在代替可操作。
- legacy定位setTimeout链返回新界面后也可能继续；按接管代次取消。ErrorBoundary内部出错/外部main回退也要关hifi全局样式，旧端启动时必要的一次性配置读取保留，但明确隐藏期纯读与标读/派发边界。

这些为源码盘点，不混称全部已由用户现场或页面探针复现。

## 6. R48施工与交付门

先集中修第2–4节核心时序，补受控同步点的UI测试（本轮已登记的双击/IME也一并补），然后同轮交H1首包；无需再等H2/H3全做完，也不以Android未回填阻止前端交付。

必须在**最终冻结产物、默认hifi**跑完整适用用户链：全新数据首启自动出现真实项目/房间/DM、指定成员派发并能定位结果、仅记录零新运行、DM回复在当前视图出现、未知重试恰一次且不丢新草稿、切目标不串草稿/水位、legacy定向接管与返回、重启历史与错误反馈、优雅停机。报告按UI/业务持久化/管道/模型分层，fake运行不称真实模型调用。

候选包从最终冻结清单拷贝并核实际全部文件（数量可随hifi资产变化），真实启动器干净环境自测，原型/新界面同窗视觉对照。--no-hifi只作原界面专项，不当默认界面全绿证据。用户只需要短测首包体验，工程先覆盖竞态，不让用户再找这些边界截图。

独立目录交H1，保留现有v6及Android数据/CA；如果想复用演练数据与CA，先副本验证迁移/回退，再给具体方案，不能擅自覆盖。继续A+Word、B不集成不下载、零新增真实模型调用；r20/r25/通知/D1–D10与v5/v6记录原样保留；价值评价/DEV-11/并行写入不开放，G5不连带宣布。
