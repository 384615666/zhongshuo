# R87 串内消息与真实交接施工设计

阶段施工记录，不是最终体验验收。基线阶段4e9f6e6/7d01c04。001–052冻结。

已施工：每条用户新消息独立thread_reply_requests（053），冻结成员/有效配置/原接收事实，不重写原task owner/route/已排队信封；老051请求继续旧消费者与UNKNOWN合同。普通消息不冒充task.review/executeRework，运行中排队追问应在前次自然交付后受理：接收时事实保持不改，实际执行轮的最新成果绑定进不可变context bundle并在startTurn前再次检查。正式返工/验收仍按原精确版本。新消息即使在工作串也回答，纯回答不生成新交付/重开已验收版本。

readThreadMembers统一原收件/实际任务分派/显式following或removed；显式移出优先，不把候选房间名单当参与名单。@本串全体只选本串eligible；显式点名房间新AI在提交事务中邀请；添加本身0模型。父与child现源码共享conversation_thread_id，附加coordination_steps绑定恢复是为派发未开始及旧兼容，不能预设子串必独立。

已接通正式worker消息通信（隔离夹具通过）：TaskComplete新增有界handoffs[]（toMemberId,message,purpose=ask/review/implement/reply），communicationContract明确开放final-result通道与真实成员发现；不能只把静态DAG叫Raft。规划协调者可发具体请求，接收方用正式子task/worker唤醒，实际消息及来源字节进原串。被唤醒的分析/评审可再向获准同伴发ask/review/reply，不能提升写权限；具体handoff可动态追加最多8步计划的有依赖步骤，依赖当前来源步骤，真正传递已冻结上游版本。所有calls共享原轮24硬顶/更小预算与2格整合预留，single_writer及停止守卫不变。实现类交接仅协调规划角色可提出，目标必须有原冻结写权限。

追加054专用coordination_messages持久表：记录原sender turn、source/target、purpose、原message及hash、根run/child task、实际接收turn与状态，来源和索引幂等；同根同sender/target/purpose/hash重复不再唤醒。每条最多4次handoff，每根最多8真实子步，无空闲/收到回声。发件人只取实际turn身份，不信模型自报。回复给协调者可排到唯一最终integration，不额外制造同一汇总调用；回复给其他来源成员必须实际新建并唤醒其只读接收步骤。真正开始才记received/running；accepted/queued不冒称AI已读。返回携带实际交付id/revision/manifest和消息/材料hash。

提示语义同步：standing不再泛化request_participant等逐项授权；renderTurnBundle不再无条件DIRECT唯一执行者，按coordination.planning/child/integration角色选择。prompts/taskComplete新handoff合同及正式验证/调度已接通；角色模板按真实stage选择，实际原生双模型验证尚未开始。DIRECT明确单人和DM只开放本次回答，不暗自扩员；多人@进入自然AUTO具体协作，不自动固定DELIB，独立研讨仅高级明确选择。

尚未完成：真实双模型handoff及最终原生输入复证、主池多@默认改路由、模型发现与添加AI一次完成、消息三操作/正序/工程文案清理、逐页小白检查、数据引导、最终新BUILD空白数据自然DOCX或PDF报告流程及真实两模型连续验收。0新增真实调用至当前阶段。

2026-10-17 09:25：新增正式worker A→B→C→B→A动态链，接收方再交接实际创建任务并读取上游原消息；C不在获准名单时0派发。重复/自我回声/越界/评审转实施被拒。失败、未知和无效协议不记交接完成；停止前派发、openSession在途停止及移除收件人均不唤醒。修复前无效协议统一完成收尾反例已补永久回归。首次新负例自身structuredFinal=false使前置输出resultKey不绑定，原失败日志保留，改为真正无效schema输出后通过。4文件78项（加停止3例后待阶段组合复测），双类型检查通过。增量eslint新模块通过，历史commands/Room等23问题仍在；不宣称全仓lint通过。0真实模型调用。

2026-10-17 09:31 第二阶段：普通主池多@/全体改自然AUTO，显式所选名单通过participantScope冻结，协调者不在所选时取首位；原无@默认AUTO仍可发现本房间获准候选。固定独立研讨只有新collaboration=deliberate高级明确选择，默认信封不附此字段，旧未知信封不自动改写或派发。高级选择保存到草稿/完整出站信封，能力预判同参数。新增root正式命令验证所选A/B不含C；既有固定研讨测试改显式发起。9文件137项、双types、新模块lint与diff-check通过；原第一组研讨图片夹具漏显式选择的失败票保留，改为明确高级发起后正式图片字节测试通过。

共享消息菜单和主池根卡菜单只保留复制/引用/收藏（取消收藏），历史表情仅只读显示，协议原件仍在运行详情，不放聊天菜单。主池取消二次倒序，旧→新，不按回复重新排序；新增本地有界readingPositions复用hook，按数据namespace/项目/房间保存贴底与可见原消息锚点，返回历史不因新回复抢滚动，贴底随内容尺寸增长。串内进度内容变化仅在贴底时跟随，不按readAt轮询强制跳转。孤立ThreadPage记录串不再默认暗用recordThread，仅显式仅记录保留。以上UI接线待真实鼠标/键盘与最终新包视觉验收，未称已通过原生体验。

2026-10-17 09:40 全仓首次回归：167文件1230项中1223通过、7失败，原source-suite-first日志保留。真实新增缺陷为Codex严格输出schema未将handoffs列为required；已补native输出必填空数组及提示样例，旧持久TaskComplete仍兼容缺省字段。其余旧断言逐项核实：线程普通新消息已排队不能再断言仅记录；固定研讨须显式选择且至少两人；新提示版本及角色已改变；历史052迁移测试固定到052实现并新增52→54完整根副本/匹配备份回退/旧schema拒绝测试。不可修改旧图片证书伪造正例，原0.3证书在adapter0.4下保持不匹配，恢复endpoint也不冒充重认证。7文件41项修复回归全过；全仓尚需最终重跑。

2026-10-17 09:46 P1配置/首次入口阶段：新增member.runtimeCatalog只读本机能力，Codex走原生model/list，Claude走共同配置解析后的本渠道/v1/models（GET、禁重定向、8秒/512KiB/500项边界，不发送工程文件/正文或推理）；动态有效渠道无法确定时不向候选端点请求，不读取CLI登录私钥。列表清楚区分reported与configured提示，失败保留已配置项，缺枚举可高级手填。模型下拉可搜名称/准确ID，切渠道清候选和等级，程序路径/权限移高级，模板复用同控件。member.create可选严格白名单runtime并在原事务中独立绑定；无效配置不留半实体，未知原号重放不重复创建。默认仅在用户勾选且现房间无可用协调者时补首可用AI；旧可用协调者/模板创建不变，不自动派发。room.create修复协调者可能不在所选room名单的正式反例。8文件38项含原成员/停用/图片权限回归及新元数据与事务用例通过，双types/新模块lint通过。尚未原生UI验收。

审阅新增精确e646d70受控DOM迟布局反例：dist/review-r87-independent/reading-late-layout-e646d70.json。原锚点首次被尺寸钳制后丢失。当前hook保留原锚点最多8秒，迟布局再定位；用户wheel/pointer/阅读按键立即取消，非用户程序滚动不误取消；停止后定时器收拢。生产hook受控几何正例、用户取消、超窗停止、贴底跟随4永久用例通过，未称原生UI已过。OpenFolderModal选目录直接openProjectByPath，picker启动即取得最新导航意图；取消/换项目/迟到不落位，错误就地保留选择，可重试。共享Composer移除正常常驻路由条与禁用方式/权限假开关，实际权限只在次级菜单按回读显示。项目/配置/设置/恢复/完整数据引导仍须整体走完，不能用这些局部变化提前交付。

全仓Word检验生成了8个新的合成DOCX/PDF，已复制保全到dist/review-r87-source/generated-word-suite-20261017，并按Git原blob逐字节恢复历史tests/artifacts原件；新增默认运行输出独立dist/test-artifacts时间戳目录，后续不覆写历史证据。没有清理用户样本或旧包。
