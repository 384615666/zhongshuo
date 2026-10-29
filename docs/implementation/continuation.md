# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

## 2026-10-29：R124 用户要求继续破坏性测试（仅测试）

用户进一步要求发散异常场景并明确指定 `newapi/deepseek-flash`。内置agent工具无该型号，但本机Claude渠道可用；经CLI实际完成两份DeepSeek max隔离上下文设计（一次长请求超时后短重试成功），返回modelUsage记录。三名gpt-6.1-sol代理实际测命令乱序、协议和记忆；主代理实测存储故障蔓延/真实Windows文件锁/DeepSeek终态状态猜想，整合复跑。设计推测不当实测；DeepSeek状态方向几项“缺陷”经复核为既有保护/语义/未证，不计确认问题。

五新文件39项：18守住、21预期反例（含一个强语义边界、一个直接DB篡改完整性项和同漏洞多变体，不能算21个漏洞或产品全通过）；相关七文件77项通过，完整tsc和七新增代码lint通过。确认共享进程退出仍RUNNING挂消费器、OPEN排队根请求穿过房间归档实际写文件、记忆表写错堵全局队列/重启、协议身份/旧审批代次/启动恢复缺口、非法终态假成功、迟到成功未合并笔记等。分项复现、限制及修复顺序见 [R124汇总](../reviews/r124-adversarial-chaos-20261029.md)。

本轮仅测试与文档，未改生产代码、未重包、原数据未动；V65身份保持原样。产品业务执行0真实模型调用，DeepSeek设计请求为真实模型请求，不能声称本轮总调用为0。下一步优先修执行退出收尾、归档启动门禁、故障隔离和协议身份，再修其余已证一致性问题。

## 2026-10-29：R123 已授权实施：跨串并行与共享笔记

用户明确“按这个方案做”，允许gpt-6.1-sol与deepseek-flash/max子代理；当前接口无deepseek，使用多个sol完成归属、准入、记忆存储与回归，主代理整合。修Codex无归属消息和旧进程代次串线；DIRECT取得准入/物理租约后才捕获基线，24/12任务各只24/12基线；同角色按冻结scope跨串并行、串内有序，旧无key UNKNOWN继续保守保护。记忆新增060迁移和schema60、同房间同角色跨串增量事务合并，带来源冲突保留，失败不记，成功待合并可重启补做不重跑模型。详见 [R123说明](../reviews/r123-session-parallel-memory-20261029.md)。

完整272文件2314通过/1个Windows文件symlink权限跳过；双types、变更lint无新增，正式UI33×2共66项通过，手册02/06/08重采集。独立复核发现并修复最终笔记撤回失效及记忆故障漏成果快照，已独立复验；最终完整回归已通过，V65已交付；原任务/数据未动、0真实模型调用。

V65：desktop-daily-win-v65-r123-session-parallel-20261029，clean源码1cfee2214d0f7bb09e82efe226819504696c1094，BUILD bld_b2d6e7d9f27a4b65；615程序hash一致，ZIP648文件CRC通过，SHA256 ae03a855a21f23aa60877e72deec7c0ca9b57b87663247dbb64b298e98c61ea2。实际Electron/daemon、14章19图、新记忆说明、原界面命令桥及正常退出通过；沿用数据入口与V64字节相同，用户退出旧版后自行切换。数据原位，首次正式打开按机制备份并迁移到schema60。实现与交付记录仅本地提交，未推送。

## 2026-10-29：R122 破坏性并发测试与会话并行评估（未改产品）

用户要求模拟多AI/多串多任务撞车，并评估共享角色模板、独立会话和共享记忆。新增17场景，正式命令/SQLite/outbox/worker、真实文件及本地协议进程；0真实模型调用，用户原数据未动。36同角色根请求、12×3成员协作60轮、20串内追问、重复发送/停止、改配置、挂起保护等已核验。24写入最终无丢失但300基线/约74秒，独立Git12写入78基线/约17秒；共享记忆两成功任务丢一次更新；无归属普通消息经实际Codex adapter+worker落进错误串已复现。详见 [R122报告](../reviews/r122-collision-stress-20261029.md)。

仅测试中替换成员准入为会话槽，证明同角色只读峰值可到2；写任务仍串行。产品并行策略、事件处理和记忆功能均未改，未发布V65。下一步建议先修 onNotify 无threadId时默认选第一个session及worker普通消息无turnId归属，再把DIRECT基线捕获移到取得准入/物理租约后；须保留停止/UNKNOWN/重启保护。共享记忆应版本化读、事务合并增量。新17场景含缺陷/风险正复现，不能称产品全通过；相关既有7文件106通过/1权限项跳过，types与新增4文件lint通过。原始早期脚本修正与最终证据在ignored dist/r122-collisions。

## 2026-10-29：R121 房间切换、执行配置与发送提示

修复同项目切房间重载与跨项目侧栏缓存闪现；Codex 新请求使用 v3 指纹，支持独立技能数组下过滤无关项目信任，旧 v1/v2 授权快照不改；权限提示查询不再排队等待发送的 CLI 准备；正常发送不显示恢复查询面板；已完成且无需验收的回复页隐藏横幅。现场确有配置文件改写，但旧快照无原文，未声称已还原具体改写字段。详见 [R121记录](../reviews/r121-room-send-execution-20261029.md)。

完整264文件2225通过/1个Windows文件symlink权限跳过，双types通过，16文件lint无新增；正式UI 33场景×2宽度共66项及成员读取250ms延迟下4项/449次DOM切房间采样检查通过。手册与回复串截图同步；0真实模型调用、原任务和运行数据未改。

V64已交付：desktop-daily-win-v64-r121-room-send-20261029，clean源码114b0adb8b3c0606b7ca97b718598a1b5b0c9e44，BUILD bld_3237b6d84ef16010；615程序hash一致、ZIP648文件CRC通过。实际包内Electron/daemon、手册14章19图、原界面命令桥及正常退出通过；两次辅助入口/主屏参数失败原件保留。沿用数据启动器与V63字节相同，原数据不搬；用户正常退出旧版后自行启动V64，在原串提出继续要求。

## 2026-10-29：R120 文件容量、头像与5次重试

按用户要求移除文件上传/托管读取/预览/解析/ZIP/快照/生成物/导出/远程下载/另存为的固定大小和数量限制，以及文件列表和Git差异截断。头像默认显示且原图保存，明确设置false仍保持。临时网络/服务故障5次额外重试，重启计数与详情共用常量；只读格式补交和副作用/UNKNOWN处理沿用既有语义。

新完整缓存与旧摘录缓存分开验证；历史输入允许已知旧完整/截断缓存，保留真实截断标记，预览重新生成完整缓存。操作手册和19张编号示例图同步。详见 [R120说明](../reviews/r120-file-capacity-20261029.md)。

最终263文件2217通过/1个Windows文件symlink权限跳过（maxWorkers=4），双types通过、60文件lint无新增；默认头像实际参与33场景×2宽度66项界面检查，均通过。主代理已独立复核各子代理结果，实际大文件与超旧数量正例通过；旧固定限额负例已改成完整读取/保存正例，analysisOnly改用真实越界链接提供失败事实。0真实模型调用，原任务/原数据未重放迁移。

V63已交付：desktop-daily-win-v63-r120-file-capacity-20261029，clean源码2af26dbc6256596706156c3ef8a5d3ebdda6dd9b，BUILD bld_ff4262054941e813；615程序hash一致、ZIP648文件CRC通过。包内实际Electron/daemon、手册14章19图、原界面、正常退出通过；现有头像控件实测保存3.6MB原图字节一致，65MiB+17文件另存为逐字节/hash一致，0turn/0real_call。沿用数据入口与V62字节相同，原数据保持原位。完整SHA及验证在R120记录。

## 2026-10-29：R119 固定上限与系统提示

续查5000文件限制后，移除单份8步/8依赖、4交接、12成员（含运行准备漏网路径）、结构化业务说明长度，以及Git清单64MiB缓冲上限；实际仍在运行的研讨成员超过20分钟不再误判缺席，完成后正常计入。删除过时缺席等待控件，保留用户明确配置的单轮时限和真实失败/停止/UNKNOWN处理。

全项目正式与原界面文案清理：规则编号、内部阶段枚举、原型/合同/事务施工说明改为短状态及动作。共享转换只处理系统说明，旧记录即时改善；业务消息、问题、反馈、文件及原始协议不改。手册14章19张编号截图更新。完整剩余限制及影响见 [R119审查](../reviews/r119-limits-and-system-copy-20261029.md)。

最终完整默认回归（maxWorkers=4）257文件2153通过/1个Windows文件symlink权限跳过。高并发I/O测试超时及回放立即读回执的竞态分别记录，回放改等实际回执；最终全部通过。双types和114文件lint与HEAD对照无新增；当前UI+daemon 33场景×2分辨率（125%）66项通过。0真实模型调用，未重放或搬迁用户数据。

V62已交付：desktop-daily-win-v62-r119-limits-copy-20261029，clean源码1d6d28f366f8dc2cdf520a431e104c337e22c459，BUILD bld_2a22340286648ed6；615程序hash一致、ZIP648文件CRC通过。实际包内Electron/daemon、手册14章19图、原界面命令桥及正常退出通过，0turn/0real_call；本机沿用数据入口与V61字节相同，原数据保持原位。辅助原界面标志误用已修正，日志保留。见R119完整校验值及交付记录。

## 2026-10-28：R118 项目基线误扫ignored运行数据

现场V60两位研讨成员均0调用，原因是全目录扫描包括ignored旧包/运行数据，触发默认5000截断（旧递归追加至5007）并遇到外置依赖junction。已实现Git项目文件清单范围、非Git默认完整迭代扫描、持久范围指纹和根身份、after并回before路径、范围变化的新路径unknown，Git失败不更换扫描边界；错误信息包含具体路径。保留真实越界/读取失败保护，手册同步更新。见 [R118记录](../reviews/r118-project-baseline-20261028.md)。

7文件134项通过，Windows文件符号链接权限不足跳过1项；实际目录junction正反例通过。双types和本轮eslint通过。现场只读新清单2657项，0截断/读取失败/越界；未重放用户业务、0真实模型调用。原始事件仅保存在ignored dist/r118-baseline。

V61已交付：desktop-daily-win-v61-r118-project-baseline-20261028，clean源码da12269711dd8fd0133f04ab92507b68fdf3c095，BUILD bld_e017b34044d66776；615程序hash一致、ZIP648文件CRC通过，实际Electron/daemon及14章19图加载、正常退出通过。原数据未迁移，沿用数据启动器与V60字节相同；升级后在原串继续，旧失败记录保留。

## 2026-10-28：R117 补齐确认后的文件交付与同AI多问题接续

用户授权修复V59独立复核中的两处遗漏。文件部分按提问事件持久保存未交付改动集，确认后合并完整版本链，派发及连接后重验文件；旧V59和格式补交通过持久来源恢复，正式交付切断旧链。同AI多个问题按提问顺序逐条接续，已有答复不重复绑定，问题身份冻结并在启动前重验；多AI沿用@选择。没有新增界面控件，手册同步更新。详见 [R117记录](../reviews/r117-confirmation-file-chain-20261028.md)。

主代理最终10文件189项定向回归通过，本轮新增25项；双types通过，eslint与HEAD对照10项既有问题、无新增。未重放原业务，0真实模型调用。原独立复核仅为缺陷复现；本轮才实施修复。

V60已交付：desktop-daily-win-v60-r117-confirmation-20261028，clean源码70c749166cf98941f2afe39ec7bae9b37b32f16a、BUILD bld_5710204bb36d94f3，615程序hash一致；ZIP648文件CRC通过，整包实际Electron隔离启动、14章19图和正常退出通过。沿用数据启动器与V59逐字节相同，原数据保持原位。辅助采集导航竞态诊断保留于ignored证据目录。

## 2026-10-28：R116 连续返工、确认接续与内部限制修复

用户已明确授权修复并全面检查阻碍不同场景的固定规则。已移除一次返工/第四轮强制收尾、隐藏24次上限、累计8步、候选成员总数误限、100文件/32MiB/嵌套12层等门槛。按实际冻结权限允许成员交接实施，累计步骤/交接读取完整。新增userQuestion具体提问；独立工作继续，原串答复接回原子任务及整合，问题历史不覆盖新完成状态；安全待确认重启不变失败。长Retry-After按服务端时刻持久化等待。UNKNOWN/文件版本/授权/用户停止保护保留。

25文件421项定向回归通过，最后接线补改相关3文件91项复核通过；双类型和构建通过，lint22项原基线无新增。手册14章19图及真实UI新增图19已复核，0真实模型调用、未重放原业务。详见 [R116修复与限制审查](../reviews/r116-adaptive-workflow-repair-20261028.md)。原根因报告为历史现场。

V59已构建交付：desktop-daily-win-v59-r116-adaptive-workflow-20261028，clean源码ff0fdbb9983dcdef7391e2af6aaada0b8043f1f1、BUILD bld_fcbe3a60045a3ae3，615项hash一致；通用ZIP648文件、CRC通过。实际包内Electron通过隔离app.health/19图/正常退出，0turn/0real_call；首次wrapper参数兼容失败保留，最终CDP验证通过。沿用数据入口与V58相同，原数据保持原位。用户需正常退出旧版再开新包，在原串继续旧任务；未替用户切换运行版本。

## 2026-10-28：R116 交付再次受阻的根因已定位，尚未修改业务代码

接续用户指定会话的根因调查：现场12次turn全部成功、outbox全部done、调用预算disabled，第二版复核仍有有据可查的内部修改要求；`deliberationRunner.ts`却以`synthesis.revision === 1`只允许一次返工，因此直接发布blocked并结束PARTIAL。R96起保留的限制在V57随包和当前main均存在；旧议题已全部resolved，不是旧议题残留。最终复用整合稿“已完成”摘要及通用失败提示又掩盖了实际停止原因。

隔离Fake复现3项：预算关闭/100次充足预算下第二次要求修改均停止，第二版ready则正常完成。结果只证明缺陷复现，不表示已修复。证据在ignored dist/r116-delivery-rootcause；私有原文留本机，原库只读、无模型调用或业务重放。详见 [R116根因记录](../reviews/r116-delivery-rootcause-20261028.md)。后续修复须处理多轮返工的版本/预算/停止原因与最新反馈展示，不能只再换一个固定轮数；本轮无业务代码修改或新包。

## 2026-10-28：R115 移除分析开关与高分屏逐页检查

按用户要求使用gpt-6.1-sol/medium与deepseek-flash/high子代理，主代理独立审查和验证。移除R107遗留的“本次仅分析”按钮和普通新发送字段，忽略旧草稿标记，保留历史任务权限及未知信封同号同参恢复。宽屏卡片随空间增列、正文限行、文件/Git树适度加宽、项目设置统一居中对齐；没有新增输入设置或功能按钮。

独立测试8文件31项、双types、eslint、UI构建通过。隔离持久化测试库含4项目10房间16成员21任务78消息20成果与12模板，正式UI33场景×2560/3440两种分辨率×100/125/150%三档缩放，最终198项边界/读取/遮挡检查通过；逐页拼图和关键截图复核，原生Windows另核对房间、恢复和看板。最终证据为ignored dist/r115-layout-review/accepted-all.json；旧verified采集存在恢复弹窗遮挡，不作为验收。手册14章18图，其中3张截图同步去掉旧按钮，0真实模型调用，原用户数据未动。详见 [R115记录](../reviews/r115-high-resolution-20261028.md)。

V58已交付：`desktop-daily-win-v58-r115-high-resolution-20261028`，clean源码`a8f72c8450bcf0e259d1928535172ba74926e553`、BUILD `bld_7f3805d606847ecf`，614项独立hash一致；ZIP646文件、CRC通过，整包手册14章18图和正常退出检查通过。沿用数据启动器在ZIP后单独加入，与V57字节相同，原数据保持原位；源码和交付记录推送公开main。

## 2026-10-27：R114 预算关闭态隐藏与已有设置搜索

用户要求隐藏“调用预算未启用”，检查已有设置遗漏，并指定前端deepseek-flash/max、后端及混合gpt-6.1-sol/medium子代理、主代理独立验收。已按指定配置完成代理分工并审查成果：房间/串/私信关闭态不显示预算胶囊和菜单段，开启态功能保持；AI设置预算搜索补齐且定位开关，说明精简；已有头像编辑、归档、已移除项目补齐搜索定位。后端预算读写正常，无需增加后端能力或全局选项。

主代理独立执行5文件17项定向测试、双types、eslint及正式UI+隔离daemon22项检查通过；手册更新14章18图，新图标明设置页开关。示例为Fake、0真实调用，用户原数据未动。详情见 [R114检查与实施](../reviews/r114-budget-settings-20261027.md)。

2026-10-28完成V57交付：`desktop-daily-win-v57-r114-budget-settings-20261027`，clean源码`cbedcc8e44fca979966a933a9985468325423983`、BUILD `bld_b3462f725237f977`，614程序hash一致；通用ZIP646文件、CRC通过。随包隔离启动、14章18图加载、正常退出与pid移除通过，0turn/0real_call。ZIP完成后再单独加入本机沿用数据启动器（与V56逐字节相同），原数据保持原位。源码和交付记录推送公开main。

## 2026-10-27：R113 当前 main 的 V56 实机测试包

用户要求生成当前版本供实机测试。已从公开main `387c037825f451ea3eee5ac013f09db1bdf790da` clean构建V56，BUILD `bld_8e8a703bde78686e`、613项hash全部一致；目录 `dist/desktop/desktop-daily-win-v56-r113-public-main-20261027/`，通用ZIP `dist/desktop/zhongshuo-v56-windows-x64-20261027.zip`，644文件、CRC通过。通用README和许可证随包；本机沿用数据的专用入口在ZIP生成后单独加入交付目录，不在公开资料或通用ZIP中。

隔离随包入口/Node/daemon启动、手册14章17图加载、正文同源、正常退出码0与pid移除通过，0turn/0real_call；未启动用户原数据。当前并发规则已核查：同成员逐轮串行、任务上下文独立，跨项目独立成员可并行；相关4文件54项本地模拟测试通过。完整包身份、校验值和辅助验证修正见 [R113交付记录](../reviews/r113-public-main-package-20261027.md)。后续源码仍在本公开克隆，旧私有仓库不恢复推送。

## 2026-10-26：隐私清理、main合并及公开发布完成

用户授权检查全部历史、合并main并开源。已在隔离副本匿名化远端全部511提交（开发分支相对原main的504提交完整保留），移除个人邮箱/目录/实际服务器地址，清理示例Word作者属性及2张含个人目录的旧截图。真实业务内容只在本地工具检查点，未推到远端且不进入公开库。原始仓库保留私有，公开版本使用独立清理历史；后续从公开main克隆开发，不合回旧历史。

公开版README、MIT及第三方说明、凭据/数据库忽略规则已补齐。旧回归夹具与当前协作规划/导航对齐后，248文件2033项通过，双types与构建通过，产品执行逻辑未改；Word属性清理后另复核3文件20项通过。完整范围与结果见 [公开源码检查记录](../public-source-review-20261026.md)。

全部504个开发提交已合入[公开仓库main](https://github.com/384615666/zhongshuo)，GitHub确认public与MIT。未登录请求验证新版源码可读、原始旧提交404、原始备份未公开。原始私有库已归档保留；后续使用新公开仓库的克隆，不向公开main推送旧私有库的提交历史。最终历史扫描无新增凭据告警。本机现有程序、聊天和任务数据保留原位。

## 2026-10-26：R112 通用新手图文手册

用户要求手册给所有用户阅读，去本机交付路径/专用启动方式，配图让小白能照做，不写推卸责任的话。已重写14章通用教程，以“读书会筹备”为同一示例，17张带编号的真实UI截图对应短步骤和结果；发送后用三格图解。个人升级安排从手册中剥离，交付时单写“本机升级说明”。README与施工约定同步要求图文维护和读者分离。

图文脚本lint、UI构建、正文图片/路径检查通过；正式组件14项及900/1440/3440、深色通过，17张图全部正常加载。采集为独立数据库/项目3次Fake示例、0真实调用，正式桌面身份的私信截图读取正常；编号/裁切与截图已核对。可复用采集脚本 scripts/capture-user-guide.cjs，具体证据和边界见 [R112记录](../reviews/r112-public-illustrated-guide-20261026.md)。不碰原用户数据或任务，保留debug删除和无关untracked。

V55包desktop-daily-win-v55-r112-illustrated-guide-20261026，源码05f21aadcd54dd1988ccab186e30cc6cba009d81，BUILD bld_241fcc311cf698cb，613项hash一致、内外版正文按图片路径归一后一致。整包17图加载及独立手册通过，0新turn/0real_call，正常关窗daemon退出0、pid移除。包内通用README与“本机升级说明.md”分离，当前用户按后者运行start-existing-data.vbs继续原数据；启动器字节与V54一致，未实际切原数据。dirty仍为原基线；按既有授权推送源码与交付记录。

## 2026-10-26：R111 独立操作手册页签

用户嫌V53帮助关于中的手册排版难看，授权独立页签。已实现“设置 → 操作手册”，手册全高阅读、外层不滚动、扁平目录/正文，去灰底卡片/阴影/混排诊断。宽屏目录在左，正文有阅读行宽；窄窗设置导航一行且选中项可见，正文不裁切。使用同份正式tokens并同步主题，14章完整，移除重复导航表；用户手册与维护约定同步改入口、V54/R111。deepseek-flash/high子代理402余额不足未产出，已关闭，由统筹实现。

双types、build、相关lint及12项隔离Electron正式组件检查通过，900/1440/3440无裁切/内外横溢出/外层纵滚动，深色通过。先前窄窗grid最小宽度问题已从截图发现修正；证据和边界见 [R111记录](../reviews/r111-guide-tab-20261026.md)。不跑原任务/真实模型/远端sandbox，保留debug删除及无关untracked。

V54包desktop-daily-win-v54-r111-guide-tab-20261026，源码27e9a086d3eb38a7fee91cce8401fcdb1c86fd91，BUILD bld_4b727a5a3065e6d0，599项hash一致、内外手册正文一致。整包资产/随包daemon隔离启动通过，帮助页与手册分离，0turn/0real_call，正常关窗退出0、pid移除。实际界面截图在ignored dist/r111-guide-smoke/package-data-3d0beda7/package-settings.png。沿用原数据用新包start-existing-data.vbs，旧V44数据不搬；未实际切用户数据。dirty仍为原基线，不称clean；源码与交付记录按既有授权推送GitHub。

## 2026-10-26：R110 设置内完整手册已接入

用户要求手册放进设置且以后更新同步维护，已实施“设置 → 帮助与关于”直接阅读14章完整手册，并接现有设置搜索。`build:ui` 每次从 docs/user-guide/README.md 生成设置内本地资源与离线HTML，打包附带离线版；README及施工总任务书写明功能/入口/交互变更须同步改手册、版本、日期及相关截图。只做此项，不恢复旧52项扩张。

已实际派发 zcode/GLM-5.3-Trial / max，子代理因429重试失败，无修改产出，已关闭，由统筹完成。双类型、构建、本轮代码lint、11项隐藏Electron正式组件及同源手册检查通过；900/1440宽窄无横向溢出。未启动产品真实模型或用户原数据，未跑全量/真实模型e2e/GitHub sandbox；具体检查边界见 [R110记录](../reviews/r110-settings-guide-20261026.md)。

V53包desktop-daily-win-v53-r110-settings-guide-20261026，源码947e2586e08f35fe1b5bad807769d86d4aa84cb9，BUILD bld_27ac1b55c2fedc88，599项独立hash一致，内外手册正文一致。设置整包资产+随包daemon隔离启动检查通过，0turn/0real_call，正常关窗daemon退出0、pid移除；辅助启动器前两次失败及无遗留进程边界保留在报告。start-existing-data.vbs继续原V44数据位置，用户正常退出旧版再开；未实际切换用户数据。BUILD.dirty=true仍为既有debug删除及untracked，不能称clean。提交推送按既有授权进行，保留4个debug删除和无关untracked。

## 2026-10-25：精简7项已实施，V52已交付

用户最新明确说“开始做吧”，已授权实施 [精简7项](../design-proposals/usability-20261025/simplified-scope.md)，不再停在待评审。范围仍以该精简版为准，不恢复旧52项界面设计。当前统筹在D:/zhongshuo直接修改既有源码；保留4个debug删除和无关untracked。用户既有GitHub推送授权继续有效。默认测试已排除githubSandbox，绝不运行专用GitHub sandbox或真实模型/e2e套件。

源码已完成、相关回归19文件189项通过，完整手册14章已生成HTML；具体改动及验证边界见 [R109实施记录](../reviews/r109-simple-implementation-20261025.md)。V52目录desktop-daily-win-v52-r109-simple-20261025，源码6a852d9a37803593509e17c1e086ab1499a05488，BUILD bld_801877b1549cd5e9，595项独立hash一致。整包Fake隔离实例1turn任务DONE并正常退出，daemon.pid移除；无真实模型调用，未切换用户原数据。包内start-existing-data.vbs沿用旧V44数据位置；先退出旧版再开新包，不迁移数据。BUILD.dirty=true来自保留的既有删除/未跟踪材料，不能称clean。

普通发送让模型使用既有协调/交接，原V51显式并发队列通过单独legacy fixture继续验证，不能恢复成按正则或按钮选择顺序。成功找回自动定位并隐藏查询块，新私信上下文保持独立。主工程/hifi类型通过，修改文件32项lint均原基线、无新增；不要再重跑已通过的189项或用户原任务，除非源码变化或出现新问题。原生退出弹窗手点与Windows通知真实点击未验，不冒称通过。旧演示首次误选停用成员的失败已保留并确认无遗留进程，使用显式Fake fixture后通过。

实施中：标题栏X简单退出确认；项目菜单现有行显示完整目录；正常已收发送不常驻找回块、查询成功直接定位原消息；现有回复串自导航过滤；继续原请求移除固定analysisOnly=true（后端会继承原请求原有只读范围）；选区引用不截400字；Toast取消旧计时器；快捷面板成员直达详情。后续继续补协作接线、旧任务成果读取、设置/通知落点及完整手册、必要验证与包交付；尚未验收或提交，不把进行中改动当完成。

## 2026-10-25：用户否定界面扩张，旧52项推荐及原型撤回

**最新权威是 [精简后的7项清单](../design-proposals/usability-20261025/simplified-scope.md) 与同目录 cut-decisions.json。** 用户逐项反馈U01–U22后要求砍掉全部不必要新增界面，先看精简版再修改。不能继续按下方旧推荐、旧优先级或子代理评审施工，也不能把本轮裁剪理解成已批准实现7项。

保留方向仅为：X退出时简短确认；现有位置显示已选文件夹路径；建房沿用原默认AI选择；完整真实操作手册；现有消息派发/完成/继续行为修复；现有入口正确落点；现有内容与重复展示错误修复。新建私信保持独立上下文，不增加标题、搜索或续聊提示。

**用户明确要求：** U02/U03草稿改造不做，U04迁移/启动扩展与U06备份扩展不做；U09不记住上次位置；U10范围不改；U12/U13不加说明/新状态；U14不用防御性产品文案；U15只精简，U16不加功能；U17/U18不改输入框、不加提示、不新增正则或顺序设置，让模型理解并用已有通道派发；U19不新增检查功能，完成判断只反映实际执行；U20不加界面信息，U22不加按钮或功能。后半段的新搜索、筛选、恢复按钮、配对引导、通知例外、表单确认、诊断与设置扩展同样撤掉。

原52项中32项退出本轮，19项仅收窄为7组现有流程修改，U21一项沿用现状。原 decisions.json、详细报告及原型是历史材料；overview.md已改为精简版入口。本轮只更新方案文档，不修改业务代码、不实际删除既有功能或数据、不调用模型或运行项目测试。

## 2026-10-25：统筹逐项决定与界面原型，继续等待用户评审

用户要求给出统筹自己的意见，逐项讲清怎么改、分歧与推荐，并为能看见的前端画小原型。本轮权威入口为 [52项决策速查](../design-proposals/usability-20261025/overview.md)，[详细逐项意见](../design-proposals/usability-20261025/README.md) 与同目录 decisions.json 保留每项两位评审意见、我的取舍、推荐、理由、验收及P01–P11场景。DeepSeek逐项52项；GLM只评论20项，余32项标为未单列，不当作赞同。推荐优先级调整为P0 5 / P1 27 / P2 20。

主要取舍：自然聊天默认识别明确两人顺序，可见预计安排且可调，歧义才确认；复用既有AUTO依赖、结果绑定与完成门。继续原任务不静默切只读、不自动扩权。待确认发送跨页收进现有待处理，查到原消息就精确定位，成功收起异常。现有看板与会话筛选补本人私信，不另建平行系统；新建私信保持独立上下文。成果修改用“提交并开始修改”主动作；文件恢复接现有changeset.undo并显示冲突。表单与键盘随改动同步达标，普通开关仍可即时保存，避免全局强制向导。

对话原型在本线程可写visualizations目录，主工作台11场景加两种协作输入方式对照，均为纯本地虚拟数据，不连接项目、模型或磁盘操作。仓库仅保存决策文档、原型截图及检查记录，不能把这些示意当成已上线界面或已完成真人桌面验收。正式用户手册仍随未来实现更新。

本轮只做设计与原型，没有修改业务代码、封包、运行项目测试或真实模型业务。用户仍要求先看整改方案再修改；“继续”指继续完成当前设计交付，不授权实现全部52项。推送按既有授权只提交本轮方案材料，保留4个debug文件删除和无关untracked。

## 2026-10-25：用户指定 DeepSeek Flash 与 GLM 5.3 Flash 的独立评审已完成

用户明确要求将全项目总结发给这两个子代理，从人类和实际使用角度复核。统筹实际 spawn `newapi/deepseek-flash` / max（`01a1713a-8c93-7d51-b566-9bb2d7558181`）及 `newapi/glm-5.3-flash` / max（`01a1713a-8d12-72f0-a124-c73bbc291f29`），同一52项底稿、互不读对方结论。DeepSeek 交逐项评审；GLM 首次长输出触发 max_output_tokens，同一代理压缩后成功交付。DeepSeek 的 U34 初稿误把已有撤销能力当新功能，统筹独立查正式命令后要求有界复核，该代理已更正。两位均已完成并关闭。

权威取舍见 [双模型评审汇总](../reviews/usability-peer-review-synthesis-20261025.md)，原件为 [DeepSeek逐项评审](../reviews/peer-usability-deepseek-flash-20261025.md) 与 [GLM精简评审](../reviews/peer-usability-glm-5.3-flash-20261025.md)。已有AUTO依赖/上游绑定/完成门、正式changeset.undo/冲突保护/续跑不能被抹成不存在；改为补收件人到计划的接线、上下文动作和正式UI入口。52项仍为候选，不整体批准；U01降按P1处理活动退出，U26视为P0意图问题；合并动作与恢复链，缩小全量发送历史/全文索引/新向导，差异默认范围不强行统一。共享组件在改到处同步补键盘和焦点，不做阻塞核心闭环的大重构。

本轮仍仅方案文档；没有业务代码、封包、测试、用户原任务或数据库操作。GLM原文观点保持，仅由统筹校正四处引用位置。后续等待用户评审具体范围再施工；不能把子代理赞同或本轮授权评审理解成批准实现全部52项。

## 2026-10-25：体验审查扩展为全项目，仍先方案后施工

用户澄清要检查整个项目，不仅是最近功能。新权威总表为 [全项目使用体验排查](../reviews/project-wide-usability-audit-20261025.md)：12 类使用流程、52 项问题与改进点（含前 R109 的 15 项，新增 37 项），另列 12 个待实机体验场景，区分代码路径确认与真实 UI 验收。覆盖首次使用、数据、导航、成员权限、多人协作、私信返工、状态恢复、文件成果、搜索归档、看板待办、设置通知配对、通用表单键盘反馈。当前仍仅交付方案，不改业务代码、不重新封包、不运行模型或原业务。

新增重点包括：清理草稿直接删含未确认发送的持久化键；24h 普通草稿过期规则；最后窗口关闭即后台停机；旧任务成果从项目最近100条再筛导致条件性假空；选区引用静默截400字；快捷面板成员不到详情／24项截断；搜索返回丢筛选；设置搜索手工索引与旧定位词；正式改动详情无内容撤销入口而非Git提示仍承诺撤销；Toast旧计时器可清掉新提示。已核实当前文件页用 FormalChangeDetail，不能误报未挂载旧 ChangeSetDetail 的原型编辑器和未接入撤销按钮。后续应基于全项目总表评审批次，不能收到“都找找”就自动开工或只修最近15项。

## 2026-10-25：用户要求先审查实际使用流程，暂不施工

用户反馈：Claude 说没有向 Codex 派发通道；串内“打开回复串”却去详情；“查询刚才的发送”只在原会话且常驻。**用户明确要求先列问题表和整改方案，看过后再修改。** 当前只交付 [使用流程排查与整改方案](../reviews/r109-usage-audit-proposal-20261025.md)，未改业务代码、未重新封包、未重跑用户任务；不能把早先修复授权解释为本轮可直接开工。

只读原库核实：这次含“然后@Codex”的跟进仅将 Claude 保存为正式 mention，DIRECT/direct.work、只有 Claude 一条执行请求、成员交接 0；其工作结果明确记录 Codex 验证未发生，任务仍 DONE。现有纯 mention 解析函数能复现中文相邻 @ 漏识别。源码确认 thread 状态动作固定 `?tab=run`；找回入口只按当前 draftKey 读取且 accepted 仍显示；找回优先 task 深链落概况；“按原请求继续”实际固定 analysisOnly。方案共 15 项，先解决收件人与有依赖协作／完成判定，再整理上下文动作与跨页找回，其后整理状态、通知、应用内帮助与升级入口。接下来等待用户评审选择，不自动派发给编码会话或启动子代理修复。

## 2026-10-25：用户操作手册随版本交付

用户要求“添加了新功能应该把操作手册一起给我”。操作手册统一放在 [docs/user-guide/README.md](../user-guide/README.md)，配隔离演示项目截图；`node scripts/package-user-guide.mjs` 生成离线 HTML，追加桌面包绝对路径参数即可只补发手册、不重建程序。`make-desktop-daily.mjs` 在各轮旧说明写完后自动附带根目录 `众说操作手册.html` 和 `操作手册/`，并在 README-DAILY 顶部放当前指引。最终 V51 原数据入口仍为 `start-existing-data.vbs`，不改程序、启动器或数据。

**后续新增功能、改变按钮入口或交互时，同步更新操作手册、相关截图和适用版本，生成 HTML 并随包交付；工程验收报告不能代替用户操作手册。** 说明应包含用途、实际入口、分步操作、结果含义、常见异常。通知真实点击仍未实测，不得在手册或交付中写成已验证。

## 2026-10-25：R108 四项实现与最终 V51 交付

指挥会话 `01a16d02-2621-7330-afbe-b2d116627da4` 已接替旧指挥会话；用户已授权“先做123和修复展示问题”。统一权威执行状态、耐久原发送只读找回、daemon事件→Electron桌面通知及精确补交链展示已完成。完整实现/验证/限度见 [R108交付报告](../reviews/r108-usability-20261025.md)。

最终候选 `dist/desktop/desktop-daily-win-v51-r108-usability-final-20261025`，BUILD `bld_b2ef163be3dc2c99`，595项manifest一致，47文件冻结无漂移，daemon SHA `b98ed4b63c65f16fa2acc863735cee0532f9e53c0c15e055429ea4de4c52aab5`。首候选 `desktop-daily-win-v51-r108-usability-20261025` / `bld_170856db95e65228` 保留；最终新增窄修为找回成功按draftKey+commandId清本次旧错误、保留后来错误/草稿，以及通知设置去除内部实现文案。

**沿用原数据仍从最终包 start-existing-data.vbs 进入，原V44 server-data原地不搬。** V50正常退出后完整冷备872文件/255986849B逐项hash匹配；原库58→59，原比较任务DONE/rev6、全部业务/消息/成员配置保持，真实calls仍23，无active/pending，原库通知0。08/09原生图实际显示#3“原答已补交”默认折叠、#4有效；历史原文可展开。最终V51原库窗口留在该任务，未重放原业务。

隔离Fake实机4task/4turn、0realcalls；最终图10/11/12验证重开找回及成功清旧红字，13实际成员活动，14完成且成员名正确，15实际Electron投递4次且均shown/attempts1。旧两条投递跨重开时间和次数不变。**OS通知实际点击未验**：编码与统筹Sky均无可返回系统通知目标，禁止Win快捷键/自造UIA；没有伪造clicked。主进程点击/深链测试与实际show回执单列，不能写成全部原生验收通过。

最终完整回归在末尾UI窄修前为2022过/1失败（246文件245过/1失败），唯一为未改动Codex回放日志即时读取，单文件20/20复核过；窄修后组件3文件16过（含隐藏Chromium真实Composer7断言）、双types过。lint38项均HEAD基线（源32/旧测6），diffcheck过。父会话所有测试显式排除githubSandbox，不为低影响UI重复全量。

**偏离须持续如实记录：两名子代理分别00:44:56与00:49:06裸跑全量，实际向GitHub测试sandbox写入6测试提交/2分支。** TLS发生在后续clone，不能声称无远端写入；初始误判已更正。原始工具票/统筹只读核验见R108报告与ignored证据；未做远端清理，不继续扩大调查。默认测试已排除该suite，专用配置须另获明确运行授权。

统筹已独立核验最终595项程序清单、47项冻结文件、872项完整备份、原库8张业务/配置表及最终原生截图，结果见 [R108统筹独立验收](../reviews/r108-coordinator-review-20261025.md)。本轮源码、测试、默认远端测试排除配置及两份交付报告，由统筹按用户授权统一提交到 `origin/codex/full-implementation` 并核对远端；实际提交号以Git记录及统筹交付回复为准。OS点击仍保留未验边界，编码会话不再改源码/封包/索引/HEAD；保留4个既有debug删除、无关untracked、V50/候选/备份。后续等待用户反馈，不新增模型、重跑原任务或重新调研。

## 2026-10-25：重复回复核查与开源功能吸纳评估

用户截图 #3/#4 确认为同一调查的原答与 format_repair 补交版重复展示：原答 9970 字符、补交 8315 字符；原回合因交接收件人 ID 校验失败，补交工具启动为 0。现有去重只覆盖同 turn 精确正文，跨补交链展示缺口尚未修复；已向编码会话登记，未修改源码或原数据。用户本轮要求判断和功能评估，没有启动新功能施工。

统筹本人核对开源远端仍为 `4e73c4c8`，并重新阅读源码，详细 13 项吸纳表、现有能力差距、优先级/工作量和验收建议见 [吸纳评估](../reviews/multi-agent-adoption-assessment-20261025.md)。首选统一状态卡、原请求找回、完成通知与工具长结果按需读取；代码地图/更多执行端/外部 MCP 属后续扩展。众说上一轮源码已推送到 `origin/codex/full-implementation` 的 `47c7e596`，远端已核实相同；本轮只新增文档，不新增模型调用或包。

## 当前状态：R107 / V50 技术验收通过，等待用户反馈（2026-10-24）

指挥会话 `01a16d02-2621-7330-afbe-b2d116627da4`。完整交付见 [R107 原比较任务恢复与只读分析](../reviews/r107-analysis-preflight-20261024.md)。最终包 `dist/desktop/desktop-daily-win-v50-r107-analysis-20261024`，build `bld_64960bf21b281f99`，595 项清单一致，daemon SHA-256 `e2bc23bc6aa2d04bcc0848c5bffc5269f8cbbc748235a1f6b9dcb60390816fda`。**沿用现有数据使用包内 start-existing-data.vbs；仍指向 V44 server-data，不搬移或覆盖。**

用户实测原任务 `task_993d7e3e-ad2c-4951-a24a-a7d1a760ce0c`（zhongshuo / D:/zhongshuo / 默认房间 #1 / Claude AUTO）已 DONE/rev6，查证子任务 DONE，原串六条回复和 22,296B 完整七维对比文档已可见。初始故障是 changeset 写入基线包含 dist 旧包、5007 文件 truncated，0 run/turn/call；不是 Codex 指纹。根卡/串/详情现在直接显示持久的具体原因与 NOT_STARTED，原失败卡可“仅分析继续”，新根消息可选“本次仅分析”。只读意图在普通继续、同串、AUTO 子任务/交接/整合继承，不从原 full scope 或 bypass 默认升权。

真实新增 calls20–23：3 成功、1 Codex 复制错 Claude 长 ID 的合同失败；已手动通过正式 `task.redispatch(formatRepair=true,useCurrentExecutionSnapshot=true)` 只读补交原结果，补交 toolStarts=0，失败事件/旧 FAILED run 保留。不是全自动无失败。四个 session 的 full/modification 均 false、analysisOnly 均 true。**可写大目录完整基线超限仍拒绝，未放宽或宣称全量写入已修。** 未新增第二个相同业务根。

全量 237 文件 / 1964 项通过（排除 githubSandbox），双 typecheck 通过；lint commands10/Room12/store8 为既有 30 项，store8 已 HEAD 复现，其余定向检查通过。模型窗口 2583 个 tracked+非 ignored untracked 路径（含4个既有删除）前后无字节变化；原 task scope/成员配置不变。activeTurns/pendingOutbox=[]、未释放租约0、备份 integrity=ok。证据根 `dist/review-r107-preflight-20261024`，01–04 原生截图逐张 view_image 核对；完整对比 artifact hash `9b221d7ca3eb5ea6007b9e0efb3f7e06e641a3dffb3a2fa2f805625a9d7ef4c8`。完整数据根升级前冷备、完成后在线备份均保留。

统筹已独立核验包、原图、原scope/绑定/字节清单与最终状态并明确技术验收通过；原生 V50 保持打开在比较文档预览。用户随后于 2026-10-24 明确要求推送 GitHub，由统筹统一选择性提交 R104–R107 源码、测试与八份修复/审查报告到 `origin/codex/full-implementation`，并推送此前尚未同步的本地提交（含 138e999），不改写历史。原数据、打包产物、无关设计/工具目录及既有 debug 文件删除不纳入本次提交；下文各轮“未 commit/push”为当时的历史状态。实际提交号与远端一致性以本轮 Git 交付结果为准。停止新增模型、业务执行、功能或封包，等待用户新指令。

## 历史状态：R106 / V49 技术验收通过（2026-10-24）

当前指挥会话为 `01a16d02-2621-7330-afbe-b2d116627da4`。本轮四项产品修复与最终事实见 [R106 产品修复与验证](../reviews/r106-product-repair-20261024.md)。最终包 `dist/desktop/desktop-daily-win-v49-r106-final-20261024`，build `bld_49b786e55f9b69ef`，595 项 payload 清单一致，daemon SHA-256 `f56a44ae228c240b9f5c6820643324a09c8d2e90569793857bec1eb6b1a30501`。**沿用现有数据使用包内 start-existing-data.vbs，仍指向 V44 的 server-data，不搬移或覆盖它。**

已修标题装饰、主池长正文约五行/长辅助摘要三行、Codex 版本化配置指纹与无推理准备、明确未派发提示、单初稿加其他成员预派发失败时不单人整合/自认，以及跨项目同名房间的首次点击与正式导航持久化。准备返回 proof 并贯穿事务复核；旧无版本/显式 v1 Codex scope 用精确 v1 比较，旧失败不被 v2 自动收养；0-run DM 恢复用独立意图键且保留 UNKNOWN 保护。

最终全量 231 文件 / 1933 项通过（排除禁止的 githubSandbox），双类型与主要变更 lint 通过；commands/Room 仍有 10/12 项历史 lint。原生 UI 最终新票及独立审计在 `dist/review-r106-product-20261024`。旧误标截图保留并在 evidence-errata.json 作废；以逐张打开过的 verified-01/02/04/05/06/07/09/10 为准。

真实新增 5 次调用（4 成功，1 短答 claims 合同失败后同 run fx 补交成功），无在途 turn、未释放租约 0、业务工具 0。Codex 私信与只 @Codex 的房间直接回复均已可见，实际配置 newapi/deepseek-flash/high；双成员短交流仍只发布主持者合并回复，不称每席均可见。原 #4 保持 BLOCKED/原 5 调用；需求文档保持 25556B、SHA `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2`。原 DM scope 原始字节未改，显式当前配置恢复后 DONE。原两人独立研讨输入偏好已恢复。

本轮保留本地导航提交 `138e999`（子代理创建，未 push），后续本轮补丁为 WIP。不要 reset/revert 共享修改或自动重放旧业务。原配置失配只能证明整体指纹变化；无旧分项前像时不能把某个 trust 块说成唯一原始原因。用户已有启动路径优先级保持：正常重开可按 ui.autoOpenProjectPath 返回默认项目 A，不能为测试改用户启动设置。开源比较由统筹独立完成。

## 历史状态：R105 / V47 已验收，统筹已接管（2026-10-24）

用户已要求新统筹接替旧会话 `01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79`，并回复编码会话 `01a16bd8-dbb4-7553-93eb-aecb1395c860`。当前权威断点见 [R105 统筹接管与验收记录](../reviews/r105-coordinator-takeover-20261024.md) 和 [R105 修复报告](../reviews/r105-recovery-20261024.md)。V47 的 595 项包清单已重新核对，恢复专项重新运行 30/30 通过，原任务已恢复收口。当前等待用户实测反馈；下方 R87 及其后续旧施工段落为历史记录，不能据此自动重开旧任务。沿用原数据须用 V47 的 `start-existing-data.vbs`，并保留其指向的 V44 `server-data`。

## 历史施工：R87 自然协作与电脑小白易用性（2026-10-17）

人类在审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79明确说“开始这一轮吧”，已通过read_thread核对原userMessage。权威范围见 [R87完整任务书](r87-product-usability-plan-20261017.md)；原方案“尚未实施”是历史状态，现已授权持续完成施工、真实验收及最终集中交付。唯一产品写入方为本会话，审阅方只读，不启新代理。

**2026-10-18 rc4 当前候选（覆盖下方 rc2/rc3 断点）**：无协议提示反例确认，旧 rc2 虽把 `outputSchema` 传给 Codex `turn/start`，自定义 GLM 路由仍返回 Markdown 并被正确判为 `turn.outputInvalid`。兼容修复提交 **`ecaef7d5ac7683619986608af7fc294a8b209326`** 在 Codex developer 指令层强制结构化终态；随后 **`16700ed86a65de28e6ca506c79f4dbf4804f1175`** 抑制计划步骤重复 handoff 产生的额外 OPEN 子任务。从 `16700ed` 的 clean worktree 构建 **`bld_da8c2e34f5842bd5` / `desktop-daily-win-v26-r87-rc4-20261018` / 595 清单 / `dirty=false` / 无 `server-data`**。

新一轮隔离根的人类正文和成员描述均不含 `TaskComplete/schema/JSON/Markdown/answer` 等协议词；Claude `deepseek-flash` 与 Codex `ccs-new/glm-5.3-flash`（reasoning `high`）共 **6/6** 真实调用与 turn 全部成功。协调 run `run_91c6a570-bf89-42ce-b231-e6ef53009ab8` 完整走完 3 个计划子任务和最终 integration，`coordination_messages=0`，2 条与计划下游目标重复的 handoff 被程序审计后抑制，根下仅 3 个计划子任务且全部 DONE。根 task `task_811f8365-3c39-4dc5-9614-4136282cda37`、thread `thread_8677e0f6-f6df-43ee-8eba-53076b000ccb` 当前为 REVIEW，pending delivery `dlv_turn_2470538f-94fa-4ef5-b48f-70d64d05fc2c`（revision 1，integration run `run_69aa019d-6572-4fcd-9263-29e6e1197ac6`）；`报告复核-v1.md` 26,876 B、SHA-256 `3dc68cdaffdeb3a89a2506aafa97f24f5eb01fcf5628ce020a8b9f15299fa27d`。

最终聚合 [r87-rc4-final-evidence-20261018.json](r87-rc4-final-evidence-20261018.json) 在评审前封存为 `ok=true`、17 项检查全过、`releaseQualified=false`；独立评审后不改原票。全量单线程首次运行 169/170 文件、1258/1259 项，唯一失败是文档测试检出 WPS 而非 Microsoft Office；该文件独立复跑 5/5，随后完整单线程 JSON 回执 **170 文件/1259 项全过**（536 test suites、hash `ecf2e67d53502e0247760b180a614661bf03c173bf68a74b6fd023d35a7e0800`）。rc2 的 8/8 工程提示回路、natural-1/2/3、额度失败、rc3/rc4 提前关窗根和旧保存 CDP timeout 均作为历史保留，不计入 rc4 成功。

**独立评审附录**：[评审原件](r87-rc4-independent-review-appendix-20261018.md)（SHA-256 `dd8f030f363208ebfa2e1fce6851befa4f2669ef2b1a9dd663dfb0f9dc775557`）与 [机器可读结论](r87-rc4-independent-review-status-20261018.json) 确认无阻断项，`independentReviewPassed=true`、`candidateReadyForDailyUse=true`。主审 PASS33；Codex transport 8 组 60 项；动态 handoffs 5 场景 71 项；54 份历史原件 hash 全相等。原封存 JSON 保持 `releaseQualified=false` 与 SHA-256 `9e6c4edce9173d567ba3c01168fe57050d080862d0715a25eca2cbe02d2e2df0` 不变。该结论是有限工程候选评审通过，不是用户已验收任务，也不代表 rc4 原生 UI/保存路径重新跑过；实际 GLM reasoning 为 `high`，rc4 自然根是计划步骤上游传递且 `coordination_messages=0`。

**rc2/d9 历史工程与 UI 基线（覆盖下方 977 收口）**：`d9bc8c8e14f9d68fe34769e1402ee3dfe06d04db` / `bld_2b4d48d74833429d` 的 595 文件 clean 包继续作为非模型 UI、数据、旧包和保存门的来源；rc4 两个 scoped commit 只改 Codex structured-final developer 注入与协调重复 handoff 抑制，按审阅范围未重跑这些非模型门。rc2 mixed-4 的 8/8 调用是带用户正文协议提示的工程正例，不能冒充无协议自然验收。977/`bld_939523319bbbd61d` 从此只算更早前候选，不再称最终。原 rc2 全量单线程为 170 文件/1257 项；同 BUILD 的欢迎/项目取消、添加 AI、键盘与 IME、保存取消、数据备份、旧包导入、看板和恢复摘要证据继续保留，入口见 [逐页便利性登记](r87-page-usability-registry-20261018.md)。

**rc2 工程提示历史正例（不是无协议自然验收）**：全新隔离根曾完成两条精确模型的 8/8 成功调用：Claude 成员 `DeepSeek 审查` 使用 `deepseek-flash`，Codex 成员 `Codex GLM 复核` 使用 `ccs-new/glm-5.3-flash`、reasoning `high`。该回路真实 Codex 子任务、协调步骤 `downstream.upstream`、专项 DOCX/PDF 发现、DeepSeek 合并、普通追问、显式 v2 和精确验收均闭环；task `task_6736c142-f74d-431a-97d5-548eb11263e9`、thread `thread_4c832b06-cf68-43ae-9257-7bdccfa560e3`、accepted delivery `dlv_turn_1e6fd57d-88ae-4e2a-a9b0-0210036a7539`（revision 3），`报告复核-v2.md` 14,085 B、SHA-256 `c62c864f3bcfa8775dc58032ce57510bca4de7f5c688ff73a79202ca4d5ee504`。该用户正文含协议提示，故只作历史工程正例；最终 rc4 票见上。

在上述 rc2 工程正例中 `coordination_messages` 为 0；有用结果通过 `coordination_steps.downstream.upstream` 传递，不把该根称为动态带外 handoff。动态能力只沿用此前独立正式 worker 测试或 977 真实票的范围。历史失败没有删除或改写：mixed natural-1 的 5 分钟 deadline UNKNOWN、natural-2 的 10 分钟 deadline UNKNOWN、natural-3 的 GLM `turn.outputInvalid`、较早 `gpt-6-luna` 周额度 FAILED，以及首次混合保存重开的 CDP timeout，均由最终聚合器按同 BUILD 包数据库/原 JSON 哈希保留。原 natural-4 的自然脚本仍在验收按钮选择器处 `ok=false`，后来的精确 pending-delivery UI 验收单独存证。rc4 当前核验只补无协议自然协作与有用结果；Chromium/系统自动化不等同真人小白认证或用户最终验收。

**2026-10-17 15:50 收口（覆盖下方旧断点）**：新开发席已完成 R87 完整数据引导、设置/恢复/成果简化、首次 AI 创建后的成员投影刷新，以及同包真实双模型报告路线。源码提交 **`9771a8a39caec15c85429580b78827ef9f8baca0`** 已推送；从 clean worktree 构建 **`bld_939523319bbbd61d` / `desktop-daily-win-v26-r87-20261017` / `dirty=false`**。同一 BUILD 的 Claude **`deepseek-flash`** 与 Codex **`gpt-6-luna`** 共 9 次真实调用全成功，完成合成 DOCX/PDF 读取、同串扩员、@本串全体、交接回传、普通追问、明确修改、精确 revision 3 验收、预览保存原件和正常 BAT 重开；重开后调用数仍为 9。数据引导在同一 BUILD 的隔离副本完成 75 文件完整备份、切换到新副本和 BAT 重开，0 模型调用。证据见 `dist/review-r87-final/final-natural-1/result.json` 与 `dist/review-r87-source/r87-data-copy-probe-2026-10-17T15-32-48-812Z/result.json`。全量测试 170 文件/1254 项通过、双类型通过、本轮改动文件 eslint 通过；全仓 eslint 仍有既存历史失败，不能宣称全绿。用户原根、旧包、`.codex-deepseek/` 和凭据未动。最终交付报告见 [R87收口记录](r87-final-delivery-20261017.md)。

**2026-10-17 09:56 最新断点**：28bc59d模板跨渠道修复已提交推送，审阅源级关闭。完整数据引导已有第一层核心src/contracts/localDataCopy.ts与9个正式数据/隔离宿主证明用例：完整字节和空目录、profile不拆分、已关闭证明/活动PID拒绝、重叠/链接拒绝、容量预算、ENOSPC/EACCES、原件变化、schema拒绝、篡改/未完成备份拒恢复；0模型。第一真实工程反例：readonly SQLite检查也在保存payload旁创建wal/shm，导致manifest失配，原data-copy-readonly-sidecar-counterexample票保留；现仅对新建独立scratch复制的DB/WAL/SHM做验证，payload原字节再次核对后才complete，9项过。**尚未宿主/helper/设置入口，不能交付或称完整备份已可用。** 独立审阅额外指出备份容器data/manifest入口先realpath会解引用junction，已在读取前lstat/包含关系拒绝并加容器data-junction负例。需要实现src/ui/main.ts可信窄桥、随包Node关闭后copy worker、独立只读进度窗口、原根同级控制指针及正常BAT记忆数据选择，计划见设计。不得在线cp LevelDB，不得改迁用户原根。

同时强化普通会话型评审/汇总（responseKind=conversation）实际交接仍有正式上游版本的正例，19项成员串回归过；修正审计把只读协作答复误称“已发生文件差异”的文字，workBasis区分coordination-output/project-diff/write-tool，原模型协议不改。2文件27项通过。当前继续设置/恢复/成果与完整数据UI，最后新cleanBUILD原生自然Office两模型闭环；不要停工或重复老包最终宣称。

**2026-10-17 09:49 继续断点**：4840c6a已提交推送，主线7d01→411e8c2→e646d70→1de93be→4840c6a远端一致。审阅对411e8c2五组交接、e646d70十组路由及4840c6a迟布局修复独立PASS，均0模型/非原生。审阅发现模板切渠道只改kind、残留旧model/executable/effort；现已用runtimeChannelPatch修复且正式模板保存/回读Claude↔Codex正例通过，显式plan权限不变、0真实调用，2文件9项（含reading4）过。数据完整引导正在施工设计，详见r87-data-guide-design-20261017.md，**只有设计，尚无代码入口，不能当已完成**。接下去先实现closed-root完整copy+校验+宿主重启指针与本地UI进度，原根不动；再设置/恢复/成果简单化及逐页矩阵、最终同新BUILD真实BAT自然DOCX/PDF两模型流程。不要停在这个提交。

**2026-10-17 09:46 最新断点**：HEAD1de93be（修Codex严格native输出handoffs必填、升级/旧证书保真与旧默认语义回归）；完整第一次源码167文件1230项1223过/7失败，原票保留，逐项修后7文件41项全过。配置及首次入口这组WIP已完成：新member.runtimeCatalog真实元数据（无推理）、搜索模型与等级联动、独立runtime随member.create原事务、首可用协调者默认（不替换旧可用/不改模板合同）、新房间协调者只从自身名单选；8文件38项/双types及新模块lint过。原生尚未验收。OpenFolderModal已改选定后直接打开并保留最新导航意图。审阅精确e646d70发现受控迟布局丢历史锚点，已修8秒有界恢复+用户输入取消，4永久用例过。完整Word测试生成8文件已归档dist后按HEAD原blob恢复，后续新测试输出独立dist目录，用户数据/旧包未动。

下一步：把本阶段提交并给审阅精确版本；继续全应用简单化，**完整已有数据/备份恢复实际入口尚未实现**（需closed-root完整copy+校验，profile草稿未知账本一起保全，原根绝不迁移覆盖；不可只做提示文案）。设置/恢复工程动作收高级诊断，成果就近修改/确认保持精确版本；逐页便利性记录。最后同一新clean BUILD空白数据BAT/真实鼠标键盘/中文IME/窄窗DPI，用合成DOCX/PDF含真实错误做DS+准确gpt-6-luna真实协作→追问→实际修改v2→验收v2→保存原件/reopen。**仍0新增真实模型，旧v25不能当本轮交付**，持续施工授权不需要再问，不启代理、不触碰用户正在使用根。

**2026-10-17 09:31 第二阶段**：411e8c2已提交P0串内消息/真实交接并请求审阅方只读定点核查，81项阶段组合通过。当前第二组主池多@自然AUTO与显式高级研讨已接后端/能力预判/草稿/冻结信封，所选A/B的授权scope不含C；9文件137项及双types、新模块lint通过。共享消息与根卡菜单三操作、主池正序与有界阅读锚点hook、孤立ThreadPage记录串默认发送已改，**原生UI仍未验收**。接下去完成真实模型下拉/一次添加AI配置/默认协调者等P1及逐页简单化，然后同新BUILD空白首用DOCX/PDF两模型真实路线。仍0真实模型调用，不重复旧包宣称交付。详见设计记录追加段。

**2026-10-17 09:25 阶段进度（优先于下方早期记录）**：7d01c04后普通thread_reply_requests正式生产者/消费者接通，原task owner/route/旧信封不改；记录串显式新AI请求可启动首task，不自动发送原private record。真正消息交接新增054 coordination_messages，handoffs原成员→同伴→其他获准成员→回原来源，正式worker A→B→C→B→A夹具通过；给协调者回复进入唯一最终integration。运行真实身份/上游文本与版本/预算/只读角色/停止配置守卫保留。无效结果不误报completed、UNKNOWN blocked不重发；成员移除和会话在途停止均0新增startTurn。主/界面types过，4组78用例及新增3停止边界通过；阶段组合复测及提交接下去执行。具体见r87-dialogue-execution-design。**真实模型仍0，P1、主池多@默认自然AUTO及高级明确研讨、最终新包/空白首用DOCX或PDF两模型路线均未完成，继续推进，不交付旧包冒充。** 当前可用空间32.5GiB，未清理用户文件。增量lint显示既有commands/Room等23项，未宣称全过。

### 历史：01:07早期施工快照

**01:07阶段进度**：standing运输阶段提交4e9f6e6、独立精确快照8格复证pass（0模型）。本串正式thread.members.change已接入已有followers表，读thread.get返回统一members/version/eligible集合，原执行者自动在串，实际coordination_steps子成员由权威绑定恢复（不取整房间候选），显式removed覆盖旧证据；CAS支持ABA、同号重放、归档/跨项目拒绝。ThreadMembers真实添加/移出、Composer线程候选仅取本串eligible接线完成。4个正式名单用例过，尚未真实窗口/派发链验收；旧默认续问限制仍待下一步成组更换，不能宣称@发送已修完。

追加迁移053为新消息级路由请求与可见运行进度提供新语义版本门，001–052未改，不升级用户原根。Claude完整自然assistant块转message.progress，控制对象/残缺JSON不进公开进度；worker只接受当前未停止/未终态turn，按turn保存一个最新有界快照，thread.get把根/真实子turn进展交回复区，终态隐藏，不加假聊天回复/计数。3文件48项（含原CLI运输）通过；首进度fixture漏终态导致测试超时已如实纠正，非真实模型故障。当前新thread_reply_requests表尚未用于普通续问；下一步以每条用户消息冻结收件人/本串范围/配置/原交付身份，允许普通串自然进入工作及多成员，原task/消息不改写。之后开放真实结构化handoff消息、角色提示一致性，P1全部范围和最终新手首用同包仍未验收。采用含可发现问题的合成DOCX或PDF作为最终报告材料，不用greeting代替。

基线 clean4f7da14，运行a2bc376/v25-rc11仅作旧基线。R86模型文件/版本及工程事实保留，但用户七项截图和常驻注入反例证明日常体验未达标，不能拿17门继续宣称日常可用。当前先成组P0：Claude native standing注入、本串持久成员与@范围、普通串自然转工作、消息式真实交接与及时可见反馈；再P1配置发现/简单控件/次序/文案及逐页首次/日常/异常/继续使用。最终新同BUILD从空白数据实际UI起完整路线，不预配项目代替首用。

已重跑未修生产Claude adapter+假进程反例：dist/review-r87-source/claude-standing-prompt-transport-counterexample.json，counterexampleConfirmed=true，0真实模型/0原生进程，原独立票未覆盖。CLI本地help确认native append-system-prompt及文件形式支持。首个可review修复：Claude保存developerInstructions，所有权限参数重建后以native --append-system-prompt-file注入，每session独立系统文件，用户文本/图片stdin不混入规则，首次/续接/长指令/权限档都覆盖；确认退出后只清理自己的临时文件。adapter版本升0.4，使身份变化如实可见。Claude12格（readonly/full/project × text/image × first/resume）和会话隔离/覆盖拒绝、Codex真实RPC start/resume系统参数共源；4文件59项及主types/增量lint通过，日志dist/review-r87-source/standing-transport-tests-20261017.log。真实模型0，尚未业务/最终包验收，不新增交付宣称。下一步本串持久成员与消息式唤醒成组实现；Claude中途message.delta未入消息已确认，须分离自然进度/控制JSON后修，不能裸上屏。

持续授权工程合成真实调用优先Claude/deepseek-flash和准确Codex/gpt-6-luna，必要多次；只用自有合成根，绝不发用户文档，不操作正在使用旧包/数据/凭据。默认CLI完整权限继承，分析/评审只读，single_writer、停止、原号同参UNKNOWN人工处理及精确验收不绕过。001–052冻结，必要追加迁移。

## 历史：R86 桌面多 AI 协作（工程总门通过，用户验收待定）

**持续用户偏好**：后续 Codex 工程真实测试优先使用本机清单的准确 ID `gpt-6-luna`；已在途/未知信封不换配置、不自动重发，确有复杂缺陷或能力阻断才按既有授权使用 Sol，不默认批量发昂贵模型。开发会话自身仍遵守用户既定 GPT-6.1 Sol；不擅改用户成员、模型或账号设置。

**2026-10-16 19:32 当前权威快照**：clean运行源码 a2bc37606baa745357b47cf07cb5db012d857e3c，desktop-daily-win-v25-rc11 / BUILD bld_cf50e93cc0db5723，593程序和4guide哈希一致，候选不带数据。全部严格17门通过（代码根final-gates.json）；双模型DS+Luna真实代码v1/v2/精确v2验收、普通同串、文档6次/真实SaveAs、聚焦DELIB14次/第四native证明、两个根正常BAT重开均完成。协作最终重开票 collaboration-reopen-completed-v2.json PASS/32calls不增；原两张false保留。后续原生读研讨和恢复原requirements标签/表格也已看图。全13自有准备根157次=149success/7failed/1interrupted/0inflight；账本与独立相符，不新增调用。首DELIB5min超时保留，新自有项目10min通过；CR有一项未逐条互评但12RATIFY与6发布分类精确一致，不称一致同意。源码163文件1164、双types/增量lint、额外QA20、同BUILD full/upgrade/6组视觉已通过；用户图片手测继承。白名单117文件/6.77MB及交付记录已提交7766e9e，全部归档工作文件与Git blob逐字节hash一致；RELEASE-VALIDATION绑定此记录提交与冻结BUILD，候选外置/版本管理收据相同。最终收据记录55f6746已推送且远端一致、工作区clean；独立17门/117归档核验通过，独立终审 r86-independent-final-signoff-20261016.json PASS，已补清空白候选首用路线，本轮完成交付；后续等待用户自然使用反馈，不继续发工程模型任务，未以工程通过代记用户验收。最终入口与边界以 r86-desktop-collaboration-v25-20261016.md 为准。下方全部为历史，不再重复模型任务。

### 历史施工快照（原件保留）

**2026-10-16 14:55 当前最高优先断点**：运行冻结仍 a2bc376 / rc11 / bld_cf50e93cc0db5723，记录HEAD55d611e。新协作根第一研讨 task_41da... 在SYN硬截止失败：旧派发300000ms，real_calls创建14:37:49，turn.started回执14:40:18，停止退出14:42:49；源码consumeUntilTerminal硬截止从消费事件时起算，与absence有效执行时钟分离，未证明计时bug，不改runtime。stderr unrecognized_model不能据此判模型不存在（此前同模型多次success）；原12次11success/1failed及budget/时间/error保留 `deliberation-original-failure.json` 和原 `delivery-deliberation.json` false，未重放旧run、无UNKNOWN/在途/保护。

沿已有正式project.collab.set、精确自有项目CAS1→2，将**新派发**turn时限设600000ms，14次调用上限及全局默认5min不变；bounded-new-turn-config.json记录0模型调用配置，原生项目菜单→项目设置→协作限制已实际看到10分钟、native-project-deadline-readback.json/png保留。新原生@全体自然两功能问题 **task_984b01f8-dcc9-4d98-b557-f522b3256719**，watch **25880** 写 `delivery-deliberation-completed.json`，目前IND/CR在途。新正式deliberation-proof/native-proof-deliberation只在此新task真正发布后取票，未写默认proof，不能把旧false改绿。

QA watcher新增最新正式run FAILED/INTERRUPTED/CANCELLED无交付就立即失败，不再纯等45分钟；ledger必保本次SYN两份false。最终archive已改纳入新completed观察、旧失败、10min配置、原生回读、独立文档小票。最终门新增候选4份外置guide的BUILD+hash严格核验；候选与两个own副本已同步说明（各own/guides-before-deadline-note保留旧说明），593程序/BUILD不动。`.gitattributes`新增R86白名单证据 -text，防Git换行破坏hash。改动尚待阶段提交。还需新研讨完成、精确四证明/自然报告、原生关闭+新协作根reopen、全ledger/final门、白名单archive与final文档/RELEASE-VALIDATION/提交推送/独立最终核查。代码根life/nav全pass且21calls保持；文档6call/真实预览SaveAs及独立pass，不再重跑。

**2026-10-16 14:41 最新**：运行BUILD仍不变，记录HEAD b6cf345（另有QA/docs待提交）。新协作根文档已6真实success自然交付，task_5948... / native-proof-document-v1 六精确sessions pass；真实撰写→Luna评审→DS修订→Luna再读→整合。最终requirements.md 5586B / SHA913f7488...，原生文件树/Markdown标题及功能表实际检查，原生系统SaveAs到本own根/native-saved-original.md，document-preview.json pass/hash相同；终版两处整合补文未再第三方评审，reviewCoversCurrentBytes=false如实。独立 rc11-luna-document-original-independent-audit.json pass。DELIB目前12call（11success/DS synthesis在途），watch72134仍等自然结果，不重发。

额外新增QA协作根原生正常AltF4后同BAT重开校验脚本 verify-r86-collaboration-reopen.cjs，待DELIB完成/四证明全收后再关闭；检查正式daemon closed、同根、原doc+DELIB交付、文件hash、零新增call。最终门新增此必要票，20QA正负+eslint过。archive-r86-release.cjs白名单归档脚本需最终门pass才执行，包含既有源/四native证明/六对图/原失败/有限独立票和合成输出；不遍历DB/profile/转录/用户目录，有文件/总体容量及疑似密钥拒绝。当前尚未执行归档/放行。

**2026-10-16 14:25 当前优先断点**：同 a2bc376 / rc11 / bld_cf50e93cc0db5723。上午 Luna 根代码 v1/v2 十次成功、普通两次成功及原生 v2 accepted 均保持；文档 review 和 DELIB 后续各出现一条 Codex quota FAILED。`quota-original-failures.json`、两份 delivery false 原件保留，该根共21实际call（19success/2failed），没有自动重试。用户返回后窗口均无，正常BAT起原根触发恢复保护，旧研讨 RUNNING→INTERRUPTED，未解除。随后原生 AltF4 正常关闭、`reopen-r86-own.cjs` 同BAT重开 PASS，代码v2身份/文件hash保持、21call相同；原生子任务/精确子交付/返回/CtrlR/未发草稿＋分列Chromiumhistory的 `native-navigation.json` PASS。保护保留不影响只读历史，不冒充旧研讨成功。

当时额度API primary已用3%（余97%），ordinaryUsageAllowed=true；仅代表app账户，不冒充custom上游，按用户继续以新明确意图准备 **同BUILD新根 `review-r86-final-rc11-collaboration-20261016` /52864**（不是旧任务重放）。原生新文档 task_5948b2ac-47ee-482c-a584-51e23f578262，watch90934；原生@全体两席DELIB task_41da4d33-ea0e-4fbd-8533-4d99dd773366，watch72134。DS+Luna medium，当前都真实运行。最终门新增显式owned `--collaboration-evidence=<新根>`，只在同BUILD分场景取文档/研讨票，代码根票不变；额外强制所有原生proof及研讨的expectedModels准确匹配，不可换模型拼票。独立发现旧门漏绑DELIB原生proof，原反例保留；现只读投影真实publish delivery/run/manifest，第四native proof严格绑定task+run+delivery+revision+manifest，缺票/错身份负例过，QA19例/lint及双types通过，runtime无改，不再构建。

视觉首次因原型不含root导致等待false；第二目录v2脚本被工程中止，留目录不称有完整票；第三欢迎恢复modal false；v4六对capture成功但滚动不一致，v5已统一thread顶部。**`review-r86-final-rc11-visual-v5-20261016/visual-pairs.json` PASS，12张实际逐张查看**，wide/narrow/1.5DPR模拟，原型缺用户根/真实runtime/交付状态等差异如实记录，DPR1.5原型列宽较窄/横滚不冒充产品像素一致。新总门 `--visual-evidence=<v5根>`，原false保留。

Native新插件版本26.1013.31256已重读skill/guidance/confirmations；globalThis.sky，r86Window=新协作根265514，r86CodeWindow=代码根264714。仅自身这两窗口操作，用户v23不碰。新模型调用自然结束前可继续docs/QA；还需新根文档原生proof/共享预览/原生SaveAs own/native-saved-original.md、DELIB双方阶段/nativeproof和自然报告；新根必要重开可单独记录，不改代码life既有pass。全ownedledger原失败含本轮quota/视觉、严格总门、最终说明/索引/候选RELEASE-VALIDATION、commitpush独立审阅后方可交付。

**2026-10-16 09:22 最新断点，优先于下方历史**：Git b7ba0ef clean，运行源码仍 a2bc376 / v25-rc11 / bld_cf50e93cc0db5723，不为 QA 换 BUILD。当前最终自有根 `dist/desktop/review-r86-final-rc11-luna-20261016`（52854）已完成代码 v1 五次成功、v2 五次成功、普通问候及同串续问两次成功。v1/v2 各五个真实原生会话 proof pass，Luna 独立读文件并运行 Node 测试，v2 六项通过；原生两步验收后原 task_e46a8ea9-c6af-42c7-a8ae-90639b704110 DONE、v2 accepted、v1 changes_requested，`code-lifecycle.json`已记录 accepted，尚未正常关闭重开。关键 `rework-running-window.json/png` pass，独立同步采样、v2原件与测试也通过，不依赖旧根迟到观察。

已通过原生输入另发自然文档协作 `task_e5dca083-a8dd-4b9a-a8d3-e8f9ae3e0080`（requirements.md，不动 greeting），只读 delivery watcher session4547；原生 @全体明确两席、只读DELIB `task_70e1f0c0-d385-45f4-944d-12f6b09d0a3a`，watcher3539。二者正在真实运行，不自动重放。视觉脚本19588，输出 `review-r86-final-rc11-visual-20261015`，需实际看六组成对图才可填inspected/pass。Vite23607/53985。当前 native globalThis.sky/r86Window/r86State，句柄331002，须用 globalThis 维持跨调用；UIA tree有滞后，按新截图输入并再次观察，不能据旧索引重试。

配置 v2-delivered 仍同 env926993...与冻结用户配置hash；正式预热新增工程trust元数据的历史说明保持。旧 rc11-real v2配置guard阻断原false及六次成功不改、不重试。还需当前文档真实字节/native proof/共享预览/系统SaveAs hash，DELIB阶段和原生proof；全部真实调用终态后原生AltF4→同BAT正常重开/no-autocall；原生子任务/精确子成果/草稿/CtrlR历史；实际视觉检查、所有阶段真实调用账本/严格总门、当前矩阵/交付说明/RELEASE-VALIDATION、提交推送及独立最终复核。full/upgrade/源码已过同BUILD，勿重做昂贵无关测试。

**2026-10-16 09:05 最新断点，优先于下方历史**：runtime 仍 a2bc37606baa745357b47cf07cb5db012d857e3c / desktop-daily-win-v25-rc11 / bld_cf50e93cc0db5723，593clean。源163文件1164、双types/quality59files无新增33既有、同BUILD full/upgrade零推理全部已过；不为QA换BUILD。当前QA HEAD56cdf3a，另有待提交QA变动。

旧 rc11-real 根 v1 已4真实成功，native4session及独立原件2/2测试通过；real-code-v1-completed.json pass，原real-code-v1.json 因编号比较QA false保留（无JSON泄漏，raw42ab...相同）。第二只读观察复用了PNG名，原JSONview/hash保持但不冒充原截图，planning-observation-provenance.json如实注明，今后label输出独立PNG。新最终门支持显式 --code-evidence，不能覆写原false。

16日重开时原窗口/进程均无、独立根旧daemon.pid仍在；所有模型calls已成功。正常BAT重开同根，未手删PID/改DB；v1原件、名册2人、hash保持，没自动派发。初次短Node退出太快未起进程、一次PowerShell环境清理命令被工具policy拒绝，未执行；用既有Node launch+等待CDP正式BAT成功（continue-launcher-3.log）。这次不是v2正常close认证。

随后原生返工意见6.5s零新增调用、明确execute同task。**rework-running-window.json/png pass**：原intent done、父WAITING/真子步未完、正式task.get queuedtrue、实际“返工执行中”且无重复按钮；已实际查看画面。独立实时采样来晚时任务后续blocked，其独立false已澄清，仅图片确认有效。v2计划与实施两次真成功后，Codex review启动前被旧配置身份guard拒：task.contextAssemblyFailed write-authorization-changed “有效执行配置已变化；未沿用旧会话”，无review run/turn/第7次call。**delivery-code-v2.json false / configuration-boundary-blocked.json false**永久保留；该旧根总6call均success，父blocked，不自动重试/不改旧scope/不手动恢复凭据。source task_693f... 原配置仍gpt6.1sol。

实际global config.toml mtime 16日00:39:58晚于旧scope冻结15日23:18，旧scope只有opaque key；宿主CODEX_SESSION_ID/THREAD_ID/APP_TOOLS_PIPE_PATH/TASK_WORKSPACE_VERIFYING_IDENTITY也有进程噪声敏感性（独立0call夹具证明）。**无法唯一还原旧阻断是有效配置、元数据或两者变化；不据此改runtimeguard/兼容旧授权**。采用QA-only：独立新意图启动/重开统一engineeringLaunchEnvironment，仅去4宿主会话标识、清ZS覆写/ELECTRON_RUN_AS_NODE；CODEX_HOME、OPENAI_*、代理、其他CODEX变量全部保留。程序/用户原根/凭据不动。OpenAI Docs已读官方config basics/reference，配置优先级来源记录，不把官方页当本次唯一原因证据。

人类在独立评审chat最新直接说后续测试尽可能用便宜GPT-6 Luna，已通过read_thread核原人话；本机正式model/list零调用列出准确 gpt-6-luna 和medium。新独立根 **dist/desktop/review-r86-final-rc11-luna-20261016** / **port52854** / 同rc11真实BAT，0call prepare后，已原生新意图send DS+gpt-6-luna，非旧信封重放。**task_e46a8ea9-c6af-42c7-a8ae-90639b704110 / thread_a9540bba-0f59-4e17-9f76-597e219759f5**，observer **66736**，写real-code-v1.json；当前仅DS planner在途。**保持原生UI replies打开，先取子步未完规划窗口再导航**。

新root progress记录launchEnvironmentRecipe名字/移除变量名，无密钥；configuration-prepared/sent/intent-frozen记录配置文件/环境hash。官方预热为新项目添加trust metadata（user config 7690→7813，sent+frozen sha befab347...一致，env hash926993...始终一致），发生正式发送冻结前，不冒充用户配置byte未变。后续每长阶段与重开用 observe-r86-configuration.cjs own unique-label 只读追加hash，不输出明文/不改配置。17项QA门与原生解析/新intent model override/env recipe测试过、lint过。

Native SKY当前会话 global sky 已初始化；**r86Window handle331002**，app完整路径含review-r86-final-rc11-luna.../copy/ZhongshuoDual/electron.exe，title R86 合成协作验收52854，r86State最新root消息+replies。只用SKY做Windows鼠标/键盘，view_image看落盘图。重启后全局var需用var声明；如失效重新list/get唯一窗口。旧rc11-real handle330288保留blocked，不再操作或重试。用户在用v23根始终不碰，旧rc9用户选中文本的窗口之前保留，不主动关闭。

剩余完成：新Luna root同BUILD v1原生proof→原生意见/0call→explicit v2＋rework-window→真版本交付/proof/两步accept；普通无@你好/同串“我刚才说了什么？”0child/0delivery；新真实文档协作/原生Markdown预览/系统SaveAs own/native-saved-original.md hash；原生@全体两席只读DELIB/双方IND+CR+自然report；全部terminal后正常AltF4/BAT重开hash/0新调用；子任务/精确子成果/返回/未发送草稿/CtrlR/实际历史；6组prototype配对wide/narrow/DPR emulated并实际看图；全owned根ledger（含原旧rc11 v2precall false）、总门、RELEASE-VALIDATION、current matrix/continuation更新、白名单证据、commit/push、独立审核。**不要再停在阶段；不要把rc10/旧rc11拼为新根总pass**。新root默认proof读取progress.expectedModels已是Luna；--codex-model可供独立新intent显式模型，旧p.expectedModels不变；final --code-evidence只在该新root自己QA需要时用。full/upgrade默认rc11固定根可直接复用同BUILD已pass；无需新包/无需再发昂贵Sol。

**最高优先新阻断（23:02，需新冻结，不放行 rc10）**：restored 实际v2运行时，AUTO父规划已消费redispatch outbox，父run WAITING、子任务执行，但成果详情回退“返工意见已记录、尚未执行”并重复显示执行按钮。原生 `native-rework-running-mislabel.json/png` 和独立 `rc10-rework-running-original-failure.json` 保留；正式命令仍安全拒绝重复，无自动重发。根因 reworkPendingOf 仅数未done outbox。最小修复只读派生 queued=pendingIntent OR 同task非source真实活跃run，排除历史/别任务；不动执行、幂等、权限、预算、保护。正式worker永久反例 before确实queued false失败，修后33项（coordinationR86＋reworkExecutionContract）过，含只记录false、outboxdone但父WAITING true、真子任务后true、重复执行拒、自然v2后null、再次记录且别任务活跃仍false。双types在跑。

**最新冻结 a2bc37606baa745357b47cf07cb5db012d857e3c / rc11 / bld_cf50e93cc0db5723（23:09）**：593 clean一致；正式33项和双types已过，source-quality-a2bc376.json PASS（59文件/33既有无新增）。全套full-a2bc376.log已163文件/1164项全过（包含额外QA gate断言；full-a2bc376-context.json记录应用src无变化与QA文件hash），生成Word目录已正确完整复制到ignored证据再restore。新rc11根 review-r86-final-rc11-real-20261015 / port52844 已prepare 0calls，尚未真实send；真实模型等待rc10阶段三链全部自然结束后再发，不抢资源。rc11-upgrade和rc11-full（52845）均完整pass/0真实调用，full保持单独前台未再出现隐藏截图。

独立旧投影16case before有四个新run活跃状态错false、修后16/16过（rework-a2bc376），前一次late动态观察 bugReproduced:false不能当独立复现。新增QA verify-r86-rework-window.cjs 只读等待父WAITING、原intent done、子步未完、正式task.get queued=true＋实际交付面板“返工执行中”/无重复按钮；6项总门正负例过，脚本与总门改动还未commit，属于QA-only不换BUILD。新最终门必须这张窗口票。

rc10 restored代码v2已8familycalls自然完成，native-proof-code-v2.json4sessions过，尚未人工accepted，因rc10不是最终不冒充验收完成；doc5calls已自然交付并watch pass，DELIB约12calls进入末尾。所有旧原件保留。Vite53985 session57883存活。最终仍需rc11同BUILD真实代码v1/返工v2/验收/重开、文档原生预览+SaveAs、DELIB、普通问答、原生导航和6组视觉、ledger/总门/记录提交推送。不要停在此阶段。

当前rc10三条真实链继续自然完成作为阶段证据，不中断、不自动重试。code v2 observer37109、DELIB29962、doc14199，均写restored根。full-v3已全部pass/0调用/同rc10 BUILD（含R79三周期、真实BAT重开、R85 daily），旧两false留存。新runtime冻结后需要最终包复证，不将rc10阶段计作新BUILD成功。Vite参照已重新启动53985（session57883），可用时再做六组视觉。后续源改动仅dm.ts及永久回归，其余QA/记录提交分列。

**2026-10-15 额度恢复后的当前断点（覆盖下方旧施工快照）**：源码已冻结并推送 `ad513c2b858f7dac81e7e1f0d02f9d11b0ad3916`，rc10 BUILD `bld_07ef3cd9b4b08add`，593 文件清单独立核验通过。全套 163 文件 / 1161 测试全过；双 types、57 文件增量 lint 过（33 条已匹配既有问题）。首次 rc10 独立根 `review-r86-final-rc10-real-20261015` 的规划可读窗口真实 pass，但 Codex 评审明确报额度耗尽，整条原 false 保留；不自动重放。用户已说额度恢复，现新建 `review-r86-final-rc10-restored-20261015`，端口 52834，原生 UI 发出同一自然合成任务；任务 `task_f9464a6c-4f3a-4b4e-b617-6549ceb67dbe`，线程 `thread_e48f08d0-e7ea-4348-83f2-afee7e6e9a28`，observer 等待中。当前窗口保持 replies，须先记录子任务尚未完成时的自然规划窗口，再继续代码 v2、文档、DELIB、普通问答、关闭重开、导航与视觉。所有最终门仍待收齐，不能用 rc9 阶段成功替代。

rc10 `review-r86-final-rc10-upgrade-20261015/upgrade.json` 已 pass，用户原数据根从未访问。首次 rc10 full 工程夹具前述房间/DM/历史等业务步骤成功，但 archive 截图窗口 hidden 导致总 false，保留 `review-r86-final-rc10-full-20261015/result.json`。QA 将为已附着的唯一工程窗口补最小化恢复且继续强制 visible+paint；另用新根复证，不覆写首次失败。源码无运行行为更改。全套测试产生的八个已跟踪 Word 样件已恢复仓库基线（尝试保存生成副本因 Git 引号路径失败，不能宣称生成副本已保全；原完整测试日志已保全）。

**进一步进展（22:52）**：restored 根 v1 已 PASS，4 次真实 turn，全子步 DONE，双实际模型、真实原生读取/测试证明 `native-proof-code-v1.json` 4 sessions 过。普通问候+续问两成功，原串根正文/上下文/原成员正确，0子任务0交付；`ordinary-chat-completed.json` 通过。原 `ordinary-chat.json` 因 QA 错把“同串续问”要求成“同 CLI session”而 false 保留；房间原合同每 turn 独立会话、第一轮规划只读→后续配置权限，实际 threadDigest 精确重放，自然答对你好，不改产品或跨权限强续接。

v1返工意见原生保存后6.5秒0新增调用，明确点击执行返工已绑定原v1/manifest/note，`code-lifecycle.json` 已记录；v2 observer 只读等待。另已原生 @全体明确选中两席研讨 task_fce21525-8a3d-49f6-80ab-12d257a35076（只读，14次预算）与默认AUTO文档 task_f2d78498-540f-4b7c-b6cb-23de9da9cf72 自然请求；两个只读watch分别写delivery-deliberation/document-v1。均未最终收口。

full-v2 的 Browser.getWindowForTarget 在该 Electron CDP 不支持，原false保留，已完全撤销此 QA 尝试；待实际 UI 验收后以单一前台工程宿主复证，不再并行争抢画面。最终门增加普通问答保全必需票及显式 owned full 证据参数，5项门测试通过；QA-only 不换ad513c2运行BUILD。

**最新必要修复待冻结（2026-10-15 21:55，优先）**：rc9最终路线实际29turn全成功：DELIB14、代码v1五/返工v2五、文档五。代码v2已原生两步确认accepted/DONE、独立Node7/7；Markdown实际共享预览、系统另存为原件hash一致（document-preview.json），Codex评审旧稿后整合改变字节，reviewCoversCurrentBytes=false照实。已收齐未见其他预览阻断。但原生v2规划窗口暴露TaskComplete JSON，原封存raw-rework-plan-observation及planning-chat-original-failure.json为false；旧chatAnswer独立字段白名单不含新增coordinationPlan，连null普通问答也漏识别，rc9绝不能最终放行。

新源码仅把TaskComplete版本/schema/output工厂抽成browser-safe contracts/taskComplete.ts（纯zod/coordination），prompts保留原API import/re-export，chatAnswer同源safeParse，agent限定/answer优先/legacy回退、human原文、额外/错字段原文保持；不改历史DB原件。单位before2失败保留，修后46定向＋12证据门/原生解析正负过、双types/hifi构建过；独立unfrozen比较8schema指纹完全同旧05b。正式Fake补规划已发表且子任务未执行的自然正文/原协议/主池线程身份，以及普通AUTO coordinationPlan:null无子任务无交付；新总门必须readablePlanningWindow。即将commit/push/构建rc10，先正式实际挂载，然后native发送代码任务并立即点开回复串，在planner已发表而子步未完窗口取主池/线程可读票，不能最终回复盖住后补拍（观察器自动读DOM/screenshot，不自动导航到replies，需原生打开）。随后v2验收、文档预览/save、手选DELIB与2个极简ordinary真实turn（文件任务后默认无@你好→原串“我刚才说了什么？”；核无子分工/工作交付/验收且原成员回答），最终正常关闭/BAT重开、导航/视觉/总账/总门。QA-only整理随后commit不换BUILD。

用户正在选读rc9自有文档窗口，SKY normalClose被user-input保护拒绝一次，已重读看到选中文字，明确保留不再关闭或操作它；没有实际关掉，不能声称rc9关闭/重开过。此不阻塞新独立rc10根。该窗口r86Window=13767508 / own final-rc9-real端口52814；后续Native需重新从list_windows唯一选择新副本，别误关用户在用v23或正在读的rc9。rc9 allcalls终态29，watchers30659/25452/83857均完成，无UNKNOWN。lifecycle-read-before-confirm为QA过早读的原false，后真实确认；现code-lifecycle保留observationFailures引用原件，未reopened。Vite66576/53985仍供视觉。磁盘最后约43GB空余，用户文件/旧包不清理。新stage脚本/leaf/test dirty以git实读。

**当前运行冻结 / 最新断点（优先于下方历史段）**：05b1331d892e8afad0bde9dc47d53d6d018161a2，候选desktop-daily-win-v25-rc9，BUILD bld_19cfe41229996380，独立593 clean/pristine核验过。首个新根`dist/desktop/review-r86-final-rc9-real-20261015`真实BAT端口52814，先原生手选Codex＋DeepSeek发只读DELIB，task_fdbb8db3-808b-475d-a091-0fadacf44a5d / run_aee3b839-2592-4ab0-aaa0-5d8aa1f66091。双方IND、CR、三轮ISS、CHK/SYN/RAT全部完成，14真实turn全succeeded，正式与14个原生session proof均pass，独立audit-v2也pass；主持是本次首选的Codex，房间AUTO协调者仍DeepSeek。只读watcher58531已完成并写delivery-deliberation.json；无自动重放。原生报告已检查、保存native-deliberation-report截图；两处模型正文完整成员UUID经独立判断为非阻断可读性边界，保留原文，不新改runtime。当前已原生发AUTO code task_942e5568-bbf2-41ae-89eb-005beaece98c，watcher30659观察real-code-v1.json，实施和Codex真实评审成功，修正step在途，完成后继续v2/文档/重开等。DELIB已跑过`verify-r86-deliberation-proof.cjs <root> <task>`及`verify-r86-native-proof.cjs <root> --label=deliberation --task=... --deliberation`（显式task允许早于code观察），再同BUILD AUTO code v1→记录意见6.5秒零调用→显式v2→精确accept→文档协作+实际Markdown预览→全部真实调用终态后原生AltF4、BAT重开→原生子任务/成果/返回/CtrlR/草稿与单独Chromium历史→6组原型配对实际看图→总账/严格总门→外置记录提交推送独立复核。不在阶段结果停工。

源码05b首次full163文件1157项全部通过（dist/review-r86-source/full-05b1331.log），双types＋相对R85的51改动文件增量lint无新增，33既有逐rule/message匹配（source-quality-05b1331.json）。Word生成件已复制generated-word-05b1331并仅恢复已跟踪工程样本。最终同BUILD `review-r86-final-rc9-full-20261015/result.json`完整正式Fake/重开pass/0真实调用，`review-r86-final-rc9-upgrade-20261015/upgrade.json`完整根/原UNKNOWN/草稿原件/旧程序拒52/匹配回退pass，独立包清单pass。Vite session66576端口53985已启动供原型配对；未关闭用户任何应用。新增QA-only source/ledger/final汇总脚本未提交；guide generator已补真实UI“项目设置→任务交付→任务交付后需要我确认”，发送前开启，仅新任务冻结，旧auto-deliver不伪称可补验收。已重新生成rc9根外置guides及hash，不改593程序或BUILD；最终own实测副本需同步这几份外置guide，记录后续QA/说明HEAD不冒充runtimeCommit。

**最新断点（2026-10-15 20:26）**：rc8 clean1cca516 / bld_a9b6180a48c8053a，owned final-real端口52804。真实AUTO v1六调用、原生意见零调用→显式v2再六调用均自然交付，native-proof-code-v1-discovery及code-v2-completed精确session过。原v2仍REVIEW，未accept，不冒充闭环。手选DELIB真实Codex IND被invalid_json_schema明确拒绝（nested claims uncertainty未required），已原生精确停止该task CANCELLED，原failed/interrupted保留，不能算双模型成功；全部calls终态，无UNKNOWN重放。新产品最小修复在deliberationRunner：生成transport schema递归required全部properties（optional无值用空串/空数组，不加null，不改历史domain可选字段），六stage正例同时过原Zod/Ajv、错版本拒、8种schema含AUTO递归strict检查，before原失败保留；34定向+双types/lint过。即将冻结新rc9，先正式实际DELIB全阶段成功，再同最终BUILD code v1→意见→执行v2→验收→文档预览→全部调用终态关闭/BAT重开→原生导航→视觉配对→最终总门。QA observe已按准确首AUTO选择，不误选先行DELIB；native proof支持显式DELIB task早于code observation。不要因QA-only另换包。

rc8同BUILD完整Fake final-full-v3 pass/0calls、升级final-upgrade pass、独立593清单pass。源码full首次1153/1154，唯一TLS原false保留；同GitHub随后5/5。此前两次1500ms双RAF screenshot失败保留，5000ms且visible后第三新根完整过。最新QA8原生正负＋完整54定向过。当前dirty含新strict修复/tests与QA脚本，Git实读；准备保存审计后commit/push/build，源码不能冒充仍rc8。最终文档/AUTO/DELIB/视觉/导航总门尚未完成，不交半成品。reviewer01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79只读已获授权；最后建议先DELIB避免尾部才发现同类schema缺陷，已采纳。用户deepseek-flash无需再次确认；必要真实合成调用已充分授权。

当前阶段：运行冻结0f3452b870b3a2b1f99433357a1ee496058956dd / desktop-daily-win-v25-rc7 / bld_9fa40125a99e71b6，593程序文件。用户已指定deepseek-flash替代耗尽的GLM；rc7真实同任务DeepSeek+Codex开发v1→意见仅记录零调用→显式v2→验收v2→原生关闭/BAT重开已通过，8次成功；文档协作另5次成功，旧版评审后整合修改，不能称评审覆盖终版。原生子任务/精确子成果/返回/CtrlR/草稿保持已证，Chromium历史另列，AltLeft不声称支持。源码全套163文件1151通过。现已独立复现并修正project.open每次复活默认房间已移出成员，须冻结rc8最终同BUILD复证；原false与rc7阶段证据均保留。最新HEAD用git实读，后续QA/记录提交不冒充运行源码。分支codex/full-implementation，独立审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79只读复核；无其他产品写入者。

立即续工：冻结房间初始化修复（仅首次建房填名册，显式member.create自动加入活动房间合同不变）及永久正负例，rc8 prepare新owned根DeepSeek/Codex medium；最终实际开发v1/v2验收重开、文档及实际预览、显式选两成员DELIBERATE、原生导航、原型成对宽窄/DPR1.5截图实际检查、同BUILD完整源码/Fake/升级回退及593清单、真实调用总账/最终严格总门、提交推送独立复核。rc7 own根review-r86-real-rc7-deepseek-20261015端口52794，文档task_230a20c5-dc9c-4282-ac50-6bd7f8940e7b已REVIEW；不要重放旧任务。native-proof-document-v1原false由编号Get-Content输出解析导致，numbered新票核不可变上游snapshot后pass，QA-only更正不新调用。未完成最终总门，不交半成品。

用户要求一次房间发送→协调成员自主分工→异构成员交接→整合→人工验收，并支持显式选成员研讨。同任务两个不同实际模型必须通过；不限定两个CLI。必要合成真实调用已授权。GLM/glm-5.3-flash当前429周/月额度耗尽，提示2026-10-16 19:42:30重置；保留失败，不拿成功别的渠道冒充GLM。本机正式model/list已零推理确认gpt-6.1-sol与gpt-6-sol，沿现有Codex配置在独立成员/根使用这组，不改用户渠道/模型/凭据。真实调用账目以各owned根SQLite real_calls实读，不再写“0调用”。

实测反例已修：CLI不接受Zod默认draft2020，所有正式输出schema改draft7并有Ajv正负对照；AUTO漏接R84零推理配置准备，首次full thread/start写本工程trust元数据后旧身份被正确拒绝。rc6发送前按同源房间候选完成准备后才freeze，await后核原目标/权限/名单/运行配置，旧快照与guard保持。不得把后者称未证明的外部配置变更。CLI初始化会写选定工程trust，不能宣称全局config完全不变。

rc6真实现场：`dist/desktop/review-r86-real-rc6-two-sol-20261015`，端口52790，原生鼠标键盘自然发送；真实规划已成功，实施第二调用已启动（原断点已越过），后续评审/整合/v2/验收/重开待完成。observer进程session37313只读不自动重放。源脚本preserve原false，不覆盖旧票。

同BUILD隔离回归 `review-r86-rc6-full-20261015/result.json` 已pass：房间DIRECT和DM完整返工v2验收、停止、普通开关/跨项目、持续17.5秒三周期、历史分页/选择/重开、Git/归档/看板/活动全范围，真实调用0。rc5升级`review-r86-v25-upgrade-v2-20261015/upgrade.json`已pass，含完整旧根复制升级52、原UNKNOWN/草稿/字节、匹配旧程序回退和旧daemon拒52；仍须最终rc6同BUILD复证。全套e155074正在session25666，日志dist/review-r86-source/full-e155074.log；不要在完成前恢复其生成Word样本。先前两次全套false保留，不代记首次成功。

待做：最终同BUILD真实异构自然开发v1→返工意见→显式执行v2→精确验收→关闭/BAT重开；第二类型文档协作与预览；显式多选真实独立研讨；原生子task/精确delivery点击与返回/后退/刷新/草稿身份；新UI宽窄与仿真HiDPI成对图并实际看图；最终完整源码、双types/lint、升级复证、原生会话工具/版本/TAP或spec证据、全总门逐项变异、所有调用/原失败清单、提交推送及独立复核。QA-only解析更正不追加已成功模型调用。当前总门必为false，不交半成品。

用户在用v23-rc6/server-data禁止读/复制/迁移/操作/关闭；仅owned review-r86目录工程。001–051冻结，仅追加052；不自动重放、对账、释放保护；默认CLI完整权限、显式只读、原件/草稿/UNKNOWN/图片既有合同保持。共享工程single_writer，研讨/评审/规划实际只读。不做旧价值评分、Android、安装器签名或其他无关延期。最终仅一条约5分钟增量确认路线。

<details><summary>R86早期阶段记录（历史，非当前状态）</summary>

## 当前施工：R86 首个桌面多 AI 协作长批次（尚未交付）

用户明确选择“一次发送→协调成员自主分工→汇总→人工验收”，支持手动选择；必要验收至少 Claude/glm-5.3-flash 与 Codex/gpt-6.1-sol 两种真实模型共同完成同一任务。必要真实调用已授权，旧零调用/两次额度限制不适用；工程仅独立合成根，禁止触碰用户使用中的 v23-rc6/server-data。R86 重新开放 AUTO/必要协作，旧业务价值评分未做仍如实记录，不作为停工理由。

先读 [R86审计与阶段记录](r86-collaboration-audit-20261015.md)。基线60f36eb；阶段提交732b1d6计划合同、0d625a4持久父子调度、7b4f3d7四反例修复、7046054拓扑修复。当前源码以git实读，存在研讨worker/runner未提交施工，勿覆盖。新增052尚未作为候选发布，001–051冻结。独立审阅会话01a0f257-16b0-7ba2-a9b4-7a3e5aed6b79负责复核，已获用户跨会话消息授权；无额外产品写入会话/子代理。

已具备工程阶段 AUTO 计划白名单/DAG、真实子task/依赖、只读规划/评审、沿原权限实施、单写串行交接、父停止/配置/未知守卫、聚合预算与整合attempt绑定、冻结版本覆盖链/present与absent校验、有界公平pump、任务详情初步协作面板。当前协作集成15项通过；原四项独立反例在7b4f3d7通过，前向依赖反例在7046054待独立复跑。真实模型调用本批迄今0，不能称成品或真实异构协作已过。

后续阶段abecc10已实现研讨正式输入/schema/图片/配置/自然报告和v2、界面与父子成果读取，已推送；全量160文件1128通过。v25-rc1工程候选 BUILD bld_6c42cfa0f484ba20 clean abecc10/593清单一致，pristine未启动，非最终交付。独立发现peer openSession跨UNKNOWN误启动、第二研讨run停止读旧run两反例，已修并加正式测试，待最新冻结复核。当前协作集成23项，真实调用仍0。QA准备脚本 scripts/verify-r86-real-launcher.cjs 仅操作owned review-r86根，prepare零推理，observe不自动重试。

继续：新冻结独立复核/全量；独立启动器真实异构开发闭环与第二类型任务，实际文件/测试/返工/验收/重开；再冻结最终clean BUILD候选、清单与独立复核，推送完整交付。不得在审计或单补丁后停止。后续新增变更与记录以git实读为准。


</details>

## 上次交付：R85 / v24-rc2 已完成并独立复核（历史交付记录）

先读 [R85交付记录](r85-desktop-closeout-v24-20261015.md)、[当前矩阵](r85-current-capabilities-20261015.md)、[最终总门](evidence-r85-v24-20261015/release-gates.json)。运行冻结 clean 383f2ee5df3260eb424a2c85f6c68c7f31d71b19 / BUILD bld_5711009e30c663e7，唯一候选 desktop-daily-win-v24-rc2，593程序文件；独立审查记录HEAD c4b9fb9a453ecd9fe4b726d9e5c7953d2d612026已与远端实核一致；随后仅追加外置审查记录，最终HEAD以git实读，不冒充新的运行源码。本次完整156文件1088 + 另14总门正负例、双types、增量lint通过。完整正式Fake闭环/持续历史/daily scope=complete、增强整根v23升级回退、六组原型配对与原生菜单/关闭均通过。真实GLM共4次succeeded，rc1两次保留、最终rc2两次自然文件/Node/返工v2验收与BAT重开，不再追加调用。源/证据真实数据见交付记录，不拿阶段false/旧prototype遮挡票转绿。

用户正在使用的v23-rc6目录及server-data禁止作为工程输入、运行、复制、迁移、清理或关闭对象。升级仅由用户按[指南](r85-v23-to-v24-guide-20261015.md)选择，工程验证用自有完整根。旧包、失败根、草稿/UNKNOWN和迁移001–051保持；不自动派发/重发/继续/对账/解除保护，原权限/图片/同串/返工合同不退回旧设计。R85新建工程窗口与Vite服务均按自有身份关闭，旧R84/用户窗口不动；如独立审查要求核证，读取现有票，不为纯说明/CSS重复模型。

边界：不称OS睡眠/断电、多日或实体HiDPI通过；归档分页/冲突容量如实标注。主页初聚焦名册未读极短0/空态留后续细化，不将其冒充已完全解决。独立最终复核无新增必要阻断，另9文件56项/双types过，见r85-independent-final-audit-20261015.json；整体用户验收仍pending，仅安排一次约5分钟自然增量路线，不索要竞态/故障/图片历史清单。Android/安装器/签名/更新/并行/自动分工等旧延期不扩。

## R84历史交接（2026-10-15，必要门通过，整体用户验收待定）

当前冻结运行源码 clean `05b549f61169b7293521dd42ec38e1a2fe239de1`；候选 `desktop-daily-win-v23-rc6`，BUILD `bld_fcf357a7e1e4ad52`，593清单一致。当前HEAD用git实读，后续QA/记录提交不冒充构建源码。150文件1058确定性测试、双types/增量lint无新增错误通过；外部GitHub TLS旧边界单列。详见 [R84进度](r84-progress-20261014.md)。

rc6 GLM/glm-5.3-flash/high 与 Codex/gpt-6.1-sol/xhigh已各10次真实全部成功，含三轮普通/图片字节/实际文件命令/项目外合成写入/返工v2验收/显式只读及正常关闭BAT重开。两份原生工作会话各证明实际测试退出0；Codex response_model仍null，不反填渠道底层型号。R84去重81次（37Codex/44GLM）全succeeded，旧副本复制7行不重复算。真实v22 UNKNOWN自有根完整备份+复制升级rc6已证原号原参/@/image/record/草稿保全，无自动派发；只在升级副本人工原号回放无重复，原旧根逐文件未变，原件正式字节/hash/浏览器decode与关闭重开通过。新根副本被旧程序明确拒51，匹配完整旧备份真实BAT开回50/原未知信封保持/0调用。不要触碰R83旧中断未知根。

新增：cached thread跨项目定位循环、线程结构化@丢失、诊断将自动图片误报历史认证均已修。普通同串原成员回答/显式仅记录零调用、工作意见后显式返工保留。追加051、001–050冻结。Codex零推理配置准备与耐久关闭保活已冻结，旧失败原件保持。

最终Fake连续观察北京时间08:31:55.208–10:31:55.212，7200004ms/352采样完成，8路径各44次；原线程/README恢复，消息24/模型调用0，请求+8980，daemon RSS85.79–88.07MiB，恢复计时器保持1。关窗后真实BAT再开，历史run4/历史窗口/展开/草稿和最后确认滚动584.8恢复。早先探针误用分页交互前517.6坐标而失败，原件保留，不代记首次成功。详见 [最终收口](r84-desktop-closeout-v23-20261015.md)、[当前矩阵](r84-current-capabilities-20261015.md)、[必要门](evidence-r84-v23-20261015/final-gates.json)。

原生菜单最终副本7步真实输入、最大化/还原/预览Esc/关闭通过；用户2026-10-15已在审查会话对本BUILD鼠标拖动回填“能正常移动”，已单独按human/manual绑定BUILD/manifest，必要门pass=true。原自动化位移仍unverified，封存false结果保持；整体userAcceptance=pending。六对成员/详情原型与共享Composer九组通过，DPR1.5仅仿真。已收唯一待测拖动项，无需再次向用户索取拖动或历史清单；无账号/模型资源阻断。后续只按新用户反馈推进；不要重跑81次调用、2h或旧未知根。

唯一当前候选desktop-daily-win-v23-rc6/start-desktop.bat（旧v23/rc2–rc5保留阶段证据）。五份最终程序593文件均核size/hash、交付前候选未启动无数据根的收据已封存，quickstart与随包两份说明同hash；当前用户已启动产生数据，须原地保留。42份白名单证据已入docs，无DB/profile/密钥。源码/QA/42份证据收口已推送d707005，独立审查在该clean提交另跑总门确认同一唯一鼠标缺口；后续只有审查记录提交，当前HEAD由git实读，不将文档HEAD冒充冻结运行源码。

只读Codex返回work/files=[]并进入REVIEW已独立核实为现有“计划档止于方案”的合法文字方案交付；原answer/未执行原因明确未创建文件，不是伪造文件成果。GLM返回conversation属于允许的分类差异。不按中文关键词改worker/旧状态，不为此追加模型调用；quickstart已说明待审方案不代表实际执行，不承诺旧只读任务提权。完整证据readonly-result-facts.json，独立审查答复保留。

### rc4阶段历史（下段不代表当前候选）

先读 [R84进度](r84-progress-20261014.md)、[完整要求](prompt-r84-daylong-desktop-closeout-20261014.md)。R84基线969302b，当前HEAD用git读取。Codex当前gpt-6.1-sol/xhigh/custom阶段7次真实成功，原生鼠标移动仍未证（可见标准窗口键盘移动+12为观察正例）。人类已确认普通同串默认由原成员回答；现已实现正式持久队列、每消息固定配置/权限/前文边界、停止/归档/UNKNOWN守卫、普通已回复与实际工作分列。工作意见仍记录后显式返工。追加迁移051（001–050不变），完整兼容和最终三轮真实复证待完成。rc4 clean56e1025/bld_9629f3bf0827f192两个渠道各10次真实成功、普通3轮/图片字节/文件命令/返工v2验收/显式只读/仅记录均证；GLM重开通过，Codex关闭exit0无stop落盘/PID残留，故未放行。已零模型子进程反例确认IPC关闭后unref异步dispose让Node过早退出；working entry保活至真实stop落盘/关库/解锁，forced-incomplete仍保锁，永久2项通过。新运行源码待冻结/候选再复证/完整2h（早期阶段或前置失败不挪用）。兼容v50→51业务旧行/凭据/old仅记录sentinel已证，一次真实升级续问不含sentinel；旧程序拒51、696文件完整匹配备份回退v22可读、real_calls保持7。另v22自有unknown renderer原信封/草稿/提及/附件旧根已正式生成并重开保留未重放，待新包完整升级保全。不要套用下文R83为本轮已交付，也不要重跑任何旧未知请求。

## 历史交接入口（2026-10-14，R83主要路线已证，原生拖动门未验证）

先读 [R83交付与剩余门](r83-desktop-experience-v22-20261014.md)、[当前矩阵](r83-current-capabilities-20261014.md)、[总门](r83-v22-delivery-20261014.json)，再按git实读HEAD。运行源码冻结7af617e68697e549cab16bf96d427a67c7429a79，clean BUILD bld_06a536e62475c22f，最新入口dist/desktop/desktop-daily-win-v22-rc6/start-desktop.bat；后续QA/文档提交不是构建源码。1027源码项/双类型/增量lint、最终8次GLM普通语言真实请求、模型实际写文件/Bash/项目外自有写入、图片字节、返工v2验收/重开、593清单、原生菜单8项及必要Fake/UNKNOWN/导航回归已通过。corePass=true，完整pass=false：原生标题栏移动未取得位移证据，最小Electron同样，不能宣布首版已放行。下轮只接该剩余原生验证及新用户反馈，不重跑真实48调用或重新开发六项。

累计48次Claude/glm-5.3-flash尝试46成功、1已知失败、1阶段3中断未确认；后者原根不重开/不重发/不对账/不解保护。没有真实Codex调用，仅metadata/replay。当前工程根review-r83-v22-rc6-20261014保留8个原身份及未发送工程草稿。旧阶段失败、本轮关闭窗口连接失败/探针参数错误记录均保留，不代记首次成功。用户确认待定，最后仅一条10分钟自然路线，故障和历史长清单由工程承担。

用户最新政策：新真实执行任务默认CLI完整权限，可读写电脑并执行命令，保留显式只读/限制及旧任务快照；图片自动输入，不以工程证书名单恒定阻断；思考等级按真实CLI/模型列表并传入参数。必要真实调用已授权，使用独立目录与合成输入，已有Claude/glm-5.3-flash；不发送用户文档、不修改原数据。阶段3中断请求保留原身份，不重发、对账或解除保护。迁移001–050冻结且未变更。

## R82历史交接入口（2026-10-13，v21曾标候选，用户反馈未通过）

当前入口为 [R82交付报告](r82-desktop-write-v21-20261013.md)、[同BUILD必要判据与hash](r82-v21-delivery-20261013.json)、[当前能力矩阵](r82-current-capabilities-20261013.md)。R81与以下内容仅为历史；旧“零真实调用/全部写权限未接/唯一R75快照”等结论不再作为当前状态。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`，R82基线 `411932e`。冻结运行源码 `ab6a2b07db70b899d38e826801608e53d021c4e1`，clean BUILD `bld_13dda5dba459bbd4`，最终入口 `dist/desktop/desktop-daily-win-v21-rc6/start-desktop.bat`。后续HEAD为QA/记录，用git实读，不把记录提交冒充构建源码。首次v21及rc2–rc5阶段包/原失败原地保留，不能误开作当前候选。
- 已接：正式项目目录授权/CAS/幂等/物理身份，默认只读、旧任务不提权、模板只复制偏好；房间/DM输入与启动复查；Claude原生restricted项目文件工具；Codex沙箱协议映射但实际写入未认证；single_writer前后像/差异/交付绑定，退出未确认UNKNOWN保持耐久保护。
- 实际可用：已有Claude/glm-5.3-flash、登记CLI2.1.283字节/有效渠道/固定文件策略。最终同BUILD真实BAT7次全部成功：默认只读/房间v1→明确返工v2→验收、B模板成员真实跨项目拒写、DM原生续接v1/v2→验收、撤销后新只读；真实差异/文件预览/普通关闭重开/实体定位通过。不是Shell、网络工具、委派或全渠道认证。
- 修复真实阻断：revision=1工作区入口导致r2重开失败、Markdown正式交付结构失败、模板后房间名单漏回读、跨项目设置未对齐导致授权禁用、文件页局部投影假0、新差异面板空内容渲染。原失败保留，不能改记首次成功。文件页权威最近100项/audience与选中文件前后快照；100路径/每侧256KiB，缺失/失败/二进制/超限分列，未接mock撤销/暂存。
- 工程门：145文件/1017测试、双类型、变更lint、593清单；最终同BUILD20步Fake自然工作流、UNKNOWN回执丢失/重开/人工原号重放、11导航取消/设置目标、附件稳定/实际PNG/原件hash、3视口原型配对。工程故障/视觉与真实模型分别记录，不代用户验收。
- 调用账：用户R82已授权必要多次合成工程文本调用，无逐次再问/旧两次限制。deepseek返回402后用户指定GLM。累计32真实turn尝试（31GLM、1deepseek），原生探针5/正式worker27按turnId去重；最终7全部正式成功。无真实Codex/新识图调用；资源不再阻断已验证组合。不要自动重试旧FAILED/UNKNOWN，下一轮新调用范围按新需求处理。
- 数据：只追加050，001–049冻结。完整自有旧v20根副本67旧表/92文件、真实旧程序拒绝50、匹配备份回退通过；用户原根未迁移/覆盖，无删除/清理/搬移用户旧包或文件。无需新增schema来读差异。
- 用户已通过图片发送/预览，继承。本轮用户确认尚未回填；最后只一条5–10分钟空测试目录自然“只读→授权/需验收→修改→看实际文件→明确返工/验收v2→重开”路线，不制造竞态或重测图片。
- 边界：仅原生受限项目文件编辑，不认证Shell/自动构建测试/网络/委派/其他CLI模型；Codex写入/识图仍unverified。不新增改动集全文分页/统一行级diff或OS睡眠/多日认证。AUTO/DELIBERATE、并行写入、Android、安装器/签名/更新/通知/价值评价等既有延期保持。不自动发/继续队列/验收/对账/解保护。
- 下一步：收集本轮自然使用反馈；不要再依历史表宣布项目修改未实现。新缺陷先复现；如果扩通用执行工具或其他渠道，需明确机制及独立证据，不能复制GLM文件档认证。

## 历史交接入口（2026-10-13，R81 / v20）

当前入口为 [R81交付记录](r81-member-management-v20-20261013.md)、[必要判据与证据hash](r81-v20-delivery-20261013.json)、[当前能力矩阵](r81-current-capabilities-20261013.md)。R80及以下段落仅为历史，旧矩阵不能当当前状态。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；基线HEAD `56a8b87`。正式运行源码冻结 `ab418320a827803fb56d9de54a28100822e451ed`，clean BUILD `bld_12c5ceedf87665ec`；入口 `dist/desktop/desktop-daily-win-v20/start-desktop.bat`。后续为QA/记录，当前仓库HEAD先用git读取；不得把记录提交冒充构建源码。
- 已实现：资料编辑的项目/成员/版本合同与CAS、名称/说明/短ID查找、启停/配置/工作量分列；明确来源的白名单模板保存/查看/编辑/停用、明确项目创建独立快照成员、实际重开后再用。原成员ID/runtime/任务/会话/正文不重建，不共享可变profile，不同步既有成员，不复制凭据/认证/私有正文/任务/项目上下文。
- 已修：成员路由项目错配、旧路由抢新打开、深链启动未知账本不可达、写成功读失败可重复创建、Codex正式工厂忽略程序引用。程序可用性与正式解析共源；权限保存值与实际值分列，Codex仍read-only/never、不接新权限认证。未知成员操作独立64项/256KiB原信封，用户人工同号同参；消息/任务旧账本合同保留。
- 工程：992项/139文件确定性门、14项新增、双类型检查、增量lint；最终真实BAT7步正常成员流程、5组故障及手工重放、20步R78/R79闭环；项目取消/交叉10场景，附件/原件hash与阅读必要回归；593文件清单。最终同BUILD视觉6成员/3模板、宽/窄/HiDPI明确viewport、动画完成。失败原件和探针问题保留，不能代记首次成功或用户验收。
- 持久化：仅追加049模板表，001–048冻结。完整旧v19工程根副本86文件/66旧业务表、实际旧程序拒绝49、匹配48备份开回通过；用户原根未迁移。回退只恢复升级前事实，不合并v20新增变更，不开发整根恢复产品功能。
- 用户已通过图片发送/预览，继承。R81工程通过不代用户确认。只一次约5分钟“改名已配置成员→保存配置模板→测试项目创建→核原成员不变→重开”路线，故障竞态由工程承担，不要求用户重测图片或调用模型。
- 真实模型调用0，Codex gpt-6-luna识图仍unverified，旧上游超时保留，不retry/startTurn；Claude仅有效配置身份匹配的旧证据。程序引用存在≠模型可用/认证。模板不伪造使用数量；思考强度/子助手/生命周期重置仍未接。
- 用户旧包/数据/凭据/草稿/未知账本原地保留，无删除/搬移、自动派发/重发/验收/对账/解除保护。D盘用户自行处理。既有AUTO/DELIBERATE、并行写入、工具权限认证、Android、安装器/签名/更新、通知、价值评价仍延期。没有新增OS睡眠/多日认证；外部GitHub sandbox本批排除，不把旧外部失败改为通过。
- 接手先核Git与当前交付JSON；不要按R75/R59旧表重新宣布当前能力缺失，不自动重试真实模型或未知命令。

## 历史交接入口（2026-10-13，R80 / v19）

当前入口为 [R80交付记录](r80-desktop-recovery-v19-20261013.md)、[必要判据与证据hash](r80-v19-delivery-20261013.json)、[当前能力](r80-current-capabilities-20261013.md)。旧R79/v18及更早段落仅为历史。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；接手HEAD `10d9e8c`。冻结运行源码 `7de88268e1730d227254458d362e20309a1f93b7`，clean BUILD `bld_02c536c5b5eb3ab3`；日常入口 `dist/desktop/desktop-daily-win-v19/start-desktop.bat`。后续提交仅QA/记录，当前仓库HEAD以git读取为准，不把记录提交冒充构建源码。
- 新能力：有界共享连接恢复与明确失败/挂起提示、monotonic截止、只读返回核实；保留确认事实和读时间；阅读位置/所选run/历史页/私信任务按根与实体保存；原件原子提交；本地脱敏诊断查看/复制。已修同线程深链陈旧意图、相同时钟容量淘汰新位置、跨分组清理DOM覆盖旧展开。
- 工程门：978项/136文件确定性套件、双类型检查、本批lint无新增；真实最终BAT完整闭环、受控断连/恢复/重载/重开、真实未知回执同号重放；最终同BUILD持续观察时长与计数以JSON为准。前序30分钟旧BUILD证据保留，不代替最后修复后的最终包。源码、隔离注入、发布形态、OS行为分开记录。
- 用户已通过图片发送与本地预览，继承；不代记R80用户验收。最后只有一条5分钟“查看/复制诊断→正常切换阅读→关窗重开”确认；故障、未知账本和长观察由工程承担。
- 边界：真实模型调用0；Codex gpt-6-luna识图仍unverified，不retry/startTurn；Claude仅继承原有效身份认证。powerMonitor通知明确为模拟，native仅暂停自有PID3秒；未做真实OS睡眠/休眠/断电/多日挂机。阅读元数据64项/512KiB、重开12标签包含活动项；仍重验权限与原件，不是事实缓存。
- 保全：用户旧包、数据、配置、凭据、草稿、未知账本原地保持；R80没有清理、删除或搬移用户/旧包文件。迁移001–048冻结。无自动重发、队列继续、验收、对账或保护解除。既有外部GitHub沙箱2项失败保留未重跑。既有延期范围保持。
- 下一步：收集v19正常使用反馈；不要让用户再制造竞态、配置错配或长任务。真实模型认证须另行明确最小调用需求，本轮不推进。不要因历史段落重做R75/R76/R78/R79。

## 历史交接入口（2026-10-12，R79 / v18，已由上方R80替代）

本段和 [R79交付记录](r79-desktop-stability-v18-20261012.md)、[必要判据](r79-v18-delivery-20261012.json) 是当前入口。下面 R75/v13 及各旧轮次仅作历史，不能作为当前能力矩阵。

- 工作区 `D:\zhongshuo`，分支 `codex/full-implementation`；R79 接手 HEAD `cbc6d15`。当前冻结运行源码 HEAD `83ec701e70f2eb903df5a1017fe99d333f2c008e`，clean BUILD `bld_8f7f491551feeaf7`；日常候选 `dist/desktop/desktop-daily-win-v18/start-desktop.bat`，与旧 v17 独立。此后仓库提交仅工程探针/交付文档，实际仓库 HEAD 请读取 `git rev-parse HEAD`，不要把构建源码身份替换成文档提交身份。
- 当前能力：继承 R78 房间DIRECT/DM完整闭环、项目打开/取消/最新导航意图、附件事实链、图片阅读、草稿与未知原信封保护；新增可见详情5秒有界单飞读取、隐藏/接管暂停、历史run选择保持、失败快照和读取时间、选中run按需明细、运行/活动/交付稳定游标单页历史、详情长列表统一滚动、权威成员工作量、预算/用量及执行摘要。看 [R79当前矩阵](r79-current-capabilities-20261012.md)，完整工作流基面仍对应 R78 当前矩阵而非 R59/R64 旧表。
- 工程验收：962项本地确定性测试、双类型检查、修改文件lint无新增错误；最终真实BAT20步（普通首启/房间与DM两版交付返工验收/失败显式继续/停止/持续活动/历史/重开），10取消交叉场景；正式仅记录工程PNG实际解码、3轮刷新、缩放拖动/Esc/树入口/原件hash。593清单绑定同BUILD。既有外部GitHub沙盒测试初次2项失败原样保留，未称全量967通过。
- 用户已通过：图片发送与本地预览（继承此前明确反馈）；R79工程通过不代记本轮用户验收。用户只需记录里一条约5分钟已有任务阅读路线，不制造长任务/竞态/故障，也不重复图片清单。
- 边界：本批真实模型调用0；Codex `gpt-6-luna`真实识图仍unverified，无retry/startTurn。Claude仅沿用有效配置身份相符的旧认证，不扩大认证范围。普通任务由正式worker产生；26run/3250活动/61交付历史规模夹具明确分列，非真实模型成果。所选run的80轮/每轮50用量、子任务50/改动集100/成果100仍显式截断，没有本轮分页；分钟级交互与恢复验证不等于多日挂机/睡眠唤醒认证。AUTO/DELIBERATE、并行写入、工具权限、Android、安装器/签名/自动更新/价值评价仍延期。
- 保留：用户旧包/数据/配置/草稿/未知账本原地未动，迁移001–048无改动，无自动重发/对账/解除保护。D盘曾ENOSPC，若干本轮生成的重复程序副本可恢复转移到 `C:\Users\user\.codex\tmp\r79-stage-programs-20261012`，工程数据库/截图/失败回执保留在原dist路径，详情见反例记录；不删除用户包。
- 下一步：使用v18自然阅读已有任务，收集实际业务问题；真实模型认证只在另行明确授权最小调用预算后推进。不要因旧报告重做R75/R76/R78，也不要自动启动模型或处理未知命令。

## 历史快照（2026-10-09 第七十五轮；R75/v13 已被下述 R79/v18 替代）

> R75=项目切换落位/取消收口（review-r74 独立复核：从房间经真实弹窗打开 B 被旧 A 路由抢回×2+装载期取消只还原焦点留 A 的 lastPath）。**主交付=desktop-daily-win-v13** `bld_d4510629e370c260`（commit `6ddd41e`，dirty=false，593/593；r63 --src v13 ok realCalls=0；**启动器发布协议复证普通打开路线 ok**：A 房间真实弹窗开已注册 B 全落位/A 保留/零 toast+再开新目录 C 最新意图+重启进 C+console 0+realCalls 0）；交互门 `verify-daily-r75.cjs` **G1–G3 全绿**（ok:true, errs:[]；realCallRoots 3×0）；全量 922/922；r72/r73/r74 门回归全绿。
> - **P1 落位所有权**：openProjectByPath 提交时登记 `openInFlightTarget{projectId,urlSeqAtStart}`（router `currentNavSeq()` 每次 hashchange +1）+收尾按代次清；房间路由/ProjectHomePage 在「他项目打开在途且 URL 自打开发起未变」**让位**；**返回 {id:目标}**——打开弹窗/pickAndOpenFolder 按目标 id 选房间落位（不读异步结束时的 activeProjectId）。**先复现**：stash 后「A 房间→真实弹窗开 B」FAIL（URL/active 留 A+lastPath=B=复核签名）。
> - **P2 回滚完整性**：装载期取消回滚=焦点+**zs.lastProjectPath**+**rooms/members/memberRuntimes/dms 整表投影**（守卫 openedId 已提交/焦点仍指本次目标/无新代次/非同项目重开——不覆盖用户后续选 C；注册表不回滚）；装载**失败**+取消同口径安静收尾。门 G2③：active/lastPath 回 B+侧栏 B 房间投影恢复+i4NavSets=0；集成 S3/S3b/S3c。
> - **衍生真缺陷①ProjectAlign 双态**：R74 窄回滚掩盖的churn 在补齐投影回滚后变 **project.open 无限循环**（探针 cmds.log 47,172 条）——房间路由在「本项目打开在途」**保持对齐分支挂载**（意图存活到波收尾），清理判据=**URL 是否仍指向本项目**（成功交接只释放/用户真跳走才取消）。修后 31 条 6s 进房。
> - **衍生真缺陷②R74 回归：交付文档内「打开文件」**硬编码 files 来源→对话内点击被 R74 自动收起即刻折叠（r72 门 G1 成果文件视图超时暴露——R74 门未覆盖该链）——改按当前预览上下文 openedFrom；r72 门修复后全绿。
> - **坑**：弹窗 autoPick 挂载即取目录（测试再点「浏览…」会多取一行）；ZS_PICK_FOLDER_FILE 按行序供目录（一次运行连开多项目）；member.list 延迟钩子会被 B 基线装载消耗（改 saved.list）；**daemonPipeNameFor 按 home 派生=用户级单例管道**（残留 electron 树占管道→后开的 app 连到旧 daemon→「no such table/directory」假阴性——清杀残留后绿，非代码缺陷）；r72 门 G1 是交付文件链的唯一回归覆盖。
> - **边界**：发布启动器无延迟钩子（bat 清洗 ZS_*，显式直通 ZS_DEV25_DEBUG_PORT/ZS_PICK_FOLDER*）；装载期取消强复现在源码门/集成；触屏/<940px/像素对照（沿用）；15s 上传悬置；既有延期不动。报告 `r75-open-landing-rollback-closeout-20261009.md`+矩阵 `capability-matrix-r75-20261009.md`。

## 历史快照（2026-10-09 第七十四轮）

> R74=两个交叉场景修复与日常使用收口（review-r73 独立复核：project.open 在途取消失效+混合标签自动收起失效，各复现 2 次）。**主交付=desktop-daily-win-v12** `bld_49bb7307dfac1435`（commit `1dbf27b`，dirty=false，593/593；r63 --src v12 ok realCalls=0；**启动器发布协议复证两交叉场景+基本布局 ok**：混合收起/恢复 2 标签/拖动 608→460/放大+Esc/双 hash 取消 prefs=B（与包库核对）/正例 A，console 0，realCalls=0）；交互门 `verify-daily-r74.cjs` **G1–G5 全绿**（ok:true, errs:[]；realCallRoots 5×0）；集成 `hifiNavCancelRound74` 1/1；全量 **922/922**（921+新增 1）；r73 门回归 ok errs:[]。
> - **P1 取消凭据进项目打开内部**：openProjectByPath 收具体 NavIntent——project.open 回执后（焦点/可见集合/zs.lastProjectPath 提交前）与装载刷新波后（persistNav 前）核意图；取消=零提交（不切项目/不写记忆/不写偏好/不弹错/安静返回，recordWrite 'project.open.cancelled' 观测）；**装载期取消还原焦点**（仅当焦点仍指向本次结果且无更新代次）。验证分列：集成 S2/S3/S4（project.open/成员装载/thread.get 等待期）+S5 反序+S6 合同（启动恢复不被无关意图拦、用户级打开仍取消在途）；门 G2 用 **main.ts 既有观测钩子 ZS_UI_DELAY_METHOD_MS**（真实转发层受控延迟——重启注入 project.open:3200/member.list:2500 造确定性窗口）。**先复现**：unfixed 集成 FAIL 于 S2、unfixed 门 G2①② FAIL（active=A+prefs=A=复核签名）。
> - **P2 混合标签收起**：判据改 `shouldAutoHidePreviewFor`（**当前活动预览来源**+explicitShow——保留的历史房间/线程标签不再阻止收起）；Room/线程共用，**DmPage 同判据新增+DM 头部 PreviewReopenButton**（hidden 时 pane 不挂载——单向门反例）。门 G1 矩阵（真实侧栏点击+原生滚轮）：room+files/thread+files/显式再往返/显式保护/跨项目/在途/DM+草稿+阅读位置 240 保持。**先复现**：unfixed G1 FAIL 于①③⑤⑥+截图视觉判读（两标签占房无重开按钮）。
> - **衍生真缺陷：阅读位置恢复**——原 effect 挂载即赋 scrollTop，异步内容装载前被钳 0（r73 实测 reopen=0 未断言）；且钳制赋值触发 scroll→rememberScroll 把钳制值写回=丢位置。修复：逐帧重试到**目标可达**才赋值（≤90 帧），用户滚轮/按下即停。
> - **上传重传口径**：uploadDiagnosed 逐次记录（耗时/错误原文/artifacts 落库/分类）——本轮 3 次 XLSX 首次通过（4.7–5.1s），**15s 未复现→归类悬置**（r73「环境抖动」维持未证实；仪器常驻）；UNKNOWN 合同未动。
> - **坑**：ZS_UI_DELAY_METHOD_MS 只延迟首个匹配方法（重启换钩子）；start-desktop.bat 清洗父环境 ZS_*（发布形态取消复证用同刻双 hash——取消先于任何异步回执）；侧栏房间只列最后聚焦项目（refreshRooms 替换语义——跨项目回房走项目页路由）；合成 scroll 事件不触发 React onScroll（门内滚动用 CDP 原生滚轮）；import.meta.env 在 esbuild 打包链未定义（调试行曾致渲染回退）。
> - **边界**：触屏/触摸板、<940px 分隔条细分、逐页像素级对照（沿用）；既有延期不动。报告 `r74-cross-scenarios-closeout-20261009.md`+矩阵 `capability-matrix-r74-20261009.md`。

## 历史快照（2026-10-09 第七十三轮）

> R73=页面切换/预览布局/导航取消收口（v10 用户实测三项：切房间预览占用+无分隔条+放大无效；review-r72 §P1 已取消定位仍切项目）。**主交付=desktop-daily-win-v11** `bld_87d8fd4ec1c6283c`（commit `ed39838`，dirty=false，593/593；r63 --src v11 ok realCalls=0；**启动器发布协议复证三项修复 ok**：自动收起/拖动 608→460/放大铺满+Esc，console 0）；交互门 `verify-daily-r73.cjs` **G1–G6 全绿**（ok:true, errs:[]；realCallRoots 6×0）；全量 921/921（一次环境 flake 复跑绿）；r72 门回归 ok errs=[]。
> - **A 自动收起**：进对话上下文时纯文件页来源预览 hidden（标签/阅读位置/草稿保留；房间头部重开按钮=显式不乒乓）；explicitShow 两处 openPreview 统一（**actions-preview 漏设是在途回弹根因**——门迭代挖出）+effect 补 s.resources 依赖。
> - **B 真分隔条**：usePreviewWidth 驱动 L3/L4 上下文|预览真实边界（原生 pointer/380 下限/双击复位/窗口缩窄拉宽不棘轮）；旧 L4 回复串左缘反转语义移除。
> - **C 真放大**：paneCls 消费 maximized 铺满 .workspace/.main；**hifi-flag.js 注入的 frameless top:38px!important 需同级 !important 压回**；Esc 还原（.menu/.scrim 打开时不穿透）。
> - **导航取消（真缺陷）**：lib/navIntent 登记簿（navigate/用户级 focus/open 取消全部在途意图；system/fromIntent 标记防自杀；启动恢复标记系统防误杀冷启动深链）；定位链每个 await 后/重试/提交焦点前核意图；LocateThread deps 补 message/tab（同 threadId 取最新）；错误按真实原因分列；冷房间直链条件（active 已恢复但房间未装载——§2 疑点证实）。
> - **PPT 页级 render-ready**：RenderedSlide data-zs-render=pending/ready/error（页+代次绑定，live 防迟到旧页误标；此前 ready 拒绝被吞）——G5 82/82 ready 0 失败。
> - **坑**：window.zs 是 contextBridge 不可重定义（延迟注入改用「同刻 hash 双写」制造在途取消时序）；文件树挂载时扫描（新复制文件需离回重扫）；raw pageCmd 不写前端注册表（重载装载）；r73 门 XLSX 上传 15s 主进程超时=环境抖动（门内重传）。
> - **边界**：触屏/触摸板、<940px 分隔条细分、逐页像素级对照未覆盖；既有延期不动。报告 `r73-layout-navigation-cancellation-20261009.md`+矩阵 `capability-matrix-r73-20261009.md`。

## 历史快照（2026-10-08 第七十二轮）

> R72=原始使用路径修复与桌面日常收口（review-r71 独立复核：文件树 22.54MiB 仍被 20MiB 拒/Git 往返残留/深链不稳定/验证口径纠正）。**主交付=desktop-daily-win-v10** `bld_0558b208779db4a7`（commit `a700a58`，dirty=false，593/593；r63 --src v10 ok realCalls=0；**启动器原始路径复证 ok**：树开真件 82 页 5.4s+p40 图 1/1 解码+console 0 错）；交互门 `verify-daily-r72.cjs` **G1–G7 全绿**（ok:true, errs:[]；realCallRoots 6×0）；全量 921/921；r71 门回归 ok（前两次环境 CPU 争用 flake，第三次干净通过+G1 单段绿，如实登记）。
> - **P1 文件树容量**：PREVIEW_BINARY_EXTENSIONS 接共享合同（Office=OFFICE_MAX_BYTES 32MiB、PDF 分道 20MiB、图片 8MiB）——readFull/originalFile 双通道；r67Contracts 增 20–32MiB 边界永久用例（21MiB 过+33.5 拒+21MiB PDF 仍拒）；G1 用户原始路径真件 82 页 5.4s+另存 sha 一致+上传件/成果件分列。
> - **P2 Git 往返**：成功清 notARepo+已解决的 git.status 读失败（其他操作 lastOp 不抹）；非 Git 重置 emptyGit 投影（留 commitMessage/reflog）；真实错误清中性标记——G2 七步含 objects 损坏=红（`.git` 变文件会被 simple-git 归 NOT_A_GIT_REPO，换 objects 变文件注入）+跨项目 trunk/main 分列。
> - **深链四修（真缺陷）**：loadThread stillCurrent 双门丢跨项目装载→ensureProjectActive（**活跃≠已装载**：applyServerNavPrefs 恢复 active 不装房间→直达房间报不存在；现要求活跃且房间已装载才早退+focusProject 落位校验+openProjectByPath 兜底）+locateThread（探归属→对齐→一次重试）+`/project/:pid/room` ProjectAlign+**Room 挂载期 previewSide 让位**（路由重挂载 prevThreadIdRef 相等不动作→上传芯片 pool 侧把线程面板整个隐藏）+消息高亮有界重试。G6 十步矩阵 10/10（真跨项目/看板/待办[二次派发造未读]/收藏[scope 切全部]/搜索[Enter 检索+scope]/冷启动/不串）。
> - **口径补齐**：G3 82/82 逐页渲染 walk 0 失败；G4 Excel aria 69913+Ctrl+Home 8000→0+横纵滚动+sheet 恢复+**视觉判读首/中/末与 openpyxl 全对上**（末行 DATA_AS2.BIN_01478/内部字段表；绝对底部=~120 行尾部空网格行带——正常形态）；G5 全进程采样 worker 峰 887MiB<896 硬界+收拢回基线；**不再上调任何限额**。
> - **R71 证据错位修正**：六源③实为房间级记录（`.composer-input` 全局选择器命中房间区）→.col-thread 作用域+thread_id DB 断言；②「本次仅记录」按钮 2025-09-25 起已收进 ⋯ 菜单（r71 点击实为 no-op、其二实为 AI 派发）→真实仅记录+DB 落库断言。
> - **边界**：canvas 选择/复制合成输入驱动不了（键盘滚动正常）——视觉判读替代；深链对齐链低频竞态已加产品级吸收（take-18 双轮未达→take-19/启动器稳定）；既有延期不动。报告 `r72-original-path-git-roundtrip-20261008.md`+矩阵 `capability-matrix-r72-20261008.md`。

## 历史快照（2026-10-08 第七十一轮）

> R71=真实文档容量与非 Git 收口（用户 v8 真实样本反馈优先：22.54MiB PPT 被 20MiB 上限拦+非 Git 红横幅）。**主交付=desktop-daily-win-v9** `bld_a03ef3a265fd6513`（commit `f4fa0e4`，dirty=false，593/593；包级门 r63 --src v9 ok）；交互门 `verify-daily-r71.cjs` **G1–G8 全绿**（ok:true, errs:[]；realCallRoots 8×0）；全量 920/920+双类型门 0 错；r70 门回归全绿。
> - **容量分道**：Office 20→32MiB（真 22.54MiB/82 页 PPT 全链：上传 5.9s/首屏 4.5s/中页图文/末页/缩放/回位 82/另存一致/堆 13→111MB）；ZIP 单条目 64→128MiB（真 73MiB 表 XML——9.8MB XLSX 69793 行此前被整份误拒）；解析堆 320→768MB+整进程 896MiB（alloc 反例测试改相对常量）；Office 解析截止 120s；超限错误人话 MiB。
> - **非 Git 中性态**：git.status 保留 NOT_A_GIT_REPO 结构码→UI 中性面板（真 Git 错误仍红）；G3 在真正仓库外临时目录实测（gate 目录在 zhongshuo 仓库内——git 向上发现外层仓库是正确行为）。
> - **登记项收口**：project.open DTO 补 rootPath/canonicalPath（新建+命中两分支+测试）；多远端 upstream 真值（upstreamMultiRemote 永久测试：origin+backup ahead=2/behind=1 与 rev-list 对上）；能力矩阵 `capability-matrix-r71-20261008.md`。
> - **交付真文件+六源**：fake writeFile 支持 contentBase64+ZS_FAKE_WRITE_FILES_JSON；真 DOCX/XLSX/PDF 字节自然落盘（sha256 逐一相等）→成果「打开文件」→同一阅读器→另存一致；六真源逐项判据（草稿/已发/**线程回复附件**/DM/文件树/**成果文件**）全绿。
> - **真窗口回弹真缺陷修复**：useThreadWidth resize 棘轮（620→380 不回弹——R70 疑点确认为产品缺陷）→删收敛写回；1283→760→1283 pane 608→514→**609** 实测；DPR2 背板 780=2×390。
> - **未覆盖**：69793 行引擎滚动逐帧性能（观感待用户）；/thread/:id 深链 G5 场景定位不稳（卡片路径替代，独立登记）；82 页逐页视觉（首/中/末+缩略图断言）。

## 历史快照（2026-10-07 第七十轮）

> R70=文件阅读器可靠性与视觉收口（R69 独立复核五类反例+CSP 图片拦截全部先修后验）。**主交付=desktop-daily-win-v8** `bld_6d502ccefe8159b3`（commit `33230aa`，dirty=false，593/593；包级门 r63 --src v8 ok realCalls=0；升级门 ok 负例 4/4）；交互门 `verify-daily-r70.cjs` **G1–G8 全绿**（ok:true, errs:[]；realCallRoots 8×0——每独立根核 real_calls）；视觉门 `visual-pairs-r70.cjs` 8 帧+Word 红字/高亮补帧全 PASS（逐帧记录整窗 2560×1380/DPR1 与**实际预览 rect x=1932 w=620**——两者分列）；r69 门回归全绿；全量 917/917+双类型门 0 错。
> - **反例修复**：①资源 ID=encodeURIComponent 无损键（中文/标点/跨项目不碰撞）②Excel 切表弹回=render 重建 ArrayBuffer→FileStage 稳定 bytes+装载缓存 ③PPT 图片=CSP `img-src … blob:`（zsres 本地 blob 放行；外部边界不变；真件 p5=3/3 解码）④阅读状态=readerState 按资源+版本存取（PPT/PDF 页缩放、Excel 表、Word scrollTop；切标签/收起重开保持）——**goToPage 嵌套 setState 是真根因**（R69 起存在，r69 门只断言输入框值未暴露）⑤PDF fit 观察器挂常驻节点+DPR ⑥Word wrapper 渲染后内联覆盖+四缺失图标 ⑦交付真文件=fake `writeFile` 脚本项+`ZS_FAKE_WRITE_FILES`+报告「涉及文件」逐项打开文件→同一阅读器 ⑧事实回填 applyWorktreeRead+delivery hashMatch/bytes 真值。
> - **三枚行生真缺陷**：Room 线程附件选择器结构性看不到锚附件（thread_id=null——已发消息入口恒空）；renderStructuredFinal 透传破坏 resultKey 绑定（19 例测试翻红——resultKey 一律以 turn 绑定为准）；探针直接 `input.value=` 被 React valueTracker 去重（假阴性来源——改走真实 UI 路径：缩略图点击/翻页箭头）。
> - **判据纪律**：R69 曾把 xlsxTabSwitch=false 记 ok=true——R70 门全部必要判据进 errs（任一假值 exit≠0）；18 轮迭代每个假阴性先翻 FAIL 再修。
> - **未覆盖**：PDF 连续滚动（单页+页码=参考形态）；Excel 行高差（info）；Emulation 拉宽被窗口钳制（wide 信息项）；既有延期不扩。

## 历史快照（2026-10-07 第六十九轮）

> R69=文件预览集中修复与 ZCode 源码对照（用户五图验收基准）。**主交付=desktop-daily-win-v7** `bld_e6abb00832d9dce2`（commit `70b86b2`，dirty=false，593/593；包级门 r63 --src v7 ok realCalls=0；升级门 ok 负例 4/4）；交互门 `verify-daily-r69.cjs` **G1–G7 全绿**（real_calls=0，用户真 PPT 11.7MB/55 页+PNG+四态文本+PDF/Word/Excel/MD/HTML+文件树+DM+已发消息+宏/损坏负例）；视觉门 `visual-pairs-r69.cjs` 7 对同视口（2560×1380）vision 全 PASS；r68 门适配新外壳后全绿；全量 917/917+双类型门 0 错。
> - **对照源码**：zai-org/ZCode @29628c9（映射表 `zcode-preview-mapping-r69-20261007.md`）；新依赖 @extend-ai/react-xlsx 0.16.0（MIT，PROVENANCE 溯源；worker 构建期预 bundle——裸 import fflate 陷阱）。
> - **P1**：房间首开死锁=store.openPreview 调度层同步开标签；PPT 误判=classifyOfficeMain 按**主 part** content type（嵌入 xlsb 不污染；宏只看主 part）；文本原字节=attachment.uploadTextRaw+decodeTextBytes（BOM/UTF-16/GB18030/0B 允许；控制字节=二进制判据）；Office 软解析失败不再吞上传（extraction:'failed' 分列，注入 fail-closed 保持）。
> - **统一阅读器**：PreviewPane 重写（标签条/面包屑/内容三层=参考结构）；fileSource 统一字节链（附件/工作区 readFull 二进制扩展/交付）；PPT=同库引擎架构（缩略图列/主舞台/底栏）；PDF=真实面板 contain 适应+页码输入；Word=分页纸张全白流（无第二副本）；Excel=WASM 引擎+sheet 页签+回退网格；文件树同阅读器。
> - **未覆盖/延期**：HTML 交互（脚本仍禁）、图片自由缩放、PPT 连续滚动、Excel 回退网格无样式、Android/安装器/价值评价既有延期不扩。

## 历史快照（2026-10-07 第六十八轮）

> R68=真实旧版继承与保全收口（R67 独立复核：跨目录继承四缺口/版本门与坏标记/重试门无牙/成员边界/交付文档第三来源/Select 展开态）。**主交付=desktop-daily-win-v6** `bld_99dadb937ca3bc87`（commit `9c11154`，dirty=false，591/591，verify-desktop-daily 绿）；交互门 `verify-daily-r68.cjs` **G1–G6 全绿**（real_calls=0）；视觉门 `visual-pairs-r68.cjs` 11 场景+vision 复核（含 Select 展开态/表格修复后）；升级门 `verify-upgrade-r67` ok（47→48+负对照 4/4）；全量 912/912+r68Contracts 7/7+双类型门 0 错。
> - **真实旧版继承（§2）**：继承标记 `zs.hifi.inherit.<ns>` 与 v2 键存在解耦；同目录 v1 键自动继承（构造性可信）；旧根无标记→设置页「旧数据目录继承」持久化候选+用户逐键确认导入（hasStateDb 核对）；冻结 v4/v3 包真启动链端到端演练全过（原 commandId 完整、同号重试恰一次、草稿恢复）。
> - **版本/身份保全（§3）**：mergeInheritedSnapshots 版本门同判（v999 整体拒收+原件保持）；坏 root-identity 不覆写不换 ID（rootIdentityHealth=invalid-marker+修复指引）；仅缺失才原子创建。
> - **重试门真牙（§4）**：按按钮正文定位+ZS_COMMAND_LOG_FILE 管道信封日志（commandId/params 逐字比对）+负对照实跑；两封不同命令未知并存（queued 按 commandId 并集）；等待期编辑保留。
> - **成员边界（§5）**：归档/移除/空白名服务端守卫+replayGuard；AddMemberModal 捕获打开目标（切换作废）；同名成员 #短标识（卡片/名单/@/配置）。
> - **第三来源与尾项（§6）**：delivery.document 正式命令+Room/ThreadPage「打开文档」（阅读=TaskComplete 结构/源码 JSON/另存对账/引用带 manifest 绑定）；project.file.stat 脏检测→磁盘已更新提示→保存拦截→重载新快照（修复重载后 pendingRevision 重复追加）；空文件 0B 另存；自绘 Select listbox（原生清零、键盘可达、展开可截图）。
> - **衍生真缺陷**：**preview.css 漏出包**（正式构建全量缺预览样式——MD 表格无边框；build-ui 清单补入，vision 复核修复）；继承候选只存内存→重载即空表永久跳过（标记持久化队列）；重载+偏好恢复后 DM/房间投影无人装载（DmPage/ProjectHome 挂载即刷新）；fake 结构化终态补末条消息（真实 final-result 同构——测试基线同步 912）。
> - **README v6**：情况 A（首次从 v3/v4 升级：复制 server-data→设置页确认导入）/情况 B（v5/v6 自建根整根移动：自动继承）分列；回退=升级前完整根+匹配旧程序。**用户实际数据在 v3——按情况 A 走**。
> - 交互门工程事实：强杀丢 LevelDB 缓冲写（实证）→门内 Browser.close 优雅关窗；v3 侧栏不列注册表项目→autoOpen 记忆路径+「默认房间」通用就绪信号。
> - 下一轮（R69）待办登记：v6 自然使用反馈优先；HTML 交互网页（脚本仍禁用）如实边界；R64 遗留 project.open 响应 rootPath/canonicalPath；多远端 upstream 复核；交付文档 UI 的私信任务线程形态核对。

## 当前真实状态（2026-10-06 第六十七轮，唯一权威快照）

> R67=日常使用与数据继承收口（R66 独立复核四反例+升级门修正+控件/原型补齐）。**主交付=
> desktop-daily-win-v5** `bld_fd6a5557b37a5bb9`（591/591，verify-desktop-daily 绿）；交互门
> `verify-daily-r67.cjs` **G1–G6 全绿**；视觉门 `visual-pairs-r67.cjs` 非空密度 10 场景+vision 10/10；
> 升级门 `verify-upgrade-r67.cjs` 全绿（基线先存/全树对照/负对照 4 实跑拒/回退=完整根/版本门拒/
> guard=1+real_calls=0）；全量 905/905+r67Contracts 6/6+双类型门 0 错。
> - **跨目录继承（P1-B）**：root-identity.json 逻辑身份（app.identity 懒建）+持久化 v2 键+
>   双通道验证（快照内嵌 dataRootId 本地自证——目录改名/移动可继承；旧格式经 app.rootIdentityOf
>   只读核对旧目录标记）；merge=pendingSends 按键取新/账本 commandId 并集/草稿 24h；旧键保留。
>   G1=真实完整目录复制+真实启动器：未知横幅+commandId 逐字恢复、同号重试 0 重复。
> - **工作区完整阅读/原件保存（P1-A/P2-B）**：project.file.readFull（全文+sha256+includeBytes）/
>   originalFile（原字节）；WorktreeBody 三源同风味（MD 排版/HTML 隔离 iframe/源码）+读取时快照
>   字节保存；保存链经 ZS_SAVEAS_AUTO_DIR 测试钩子实际落盘 sha256 逐字核验（不检测桥存在）。
> - **恢复来源稳定（P2-A）**：首次成功快照实体签名固定 startup；同运行新实体=runtime（toast+侧栏
>   永不弹窗/不改判）；G4 六态含真实重启 startup 自动弹一次+关闭不重开。
> - **衍生真缺陷两枚**：①文件-only AI 派发在 turnInput empty-root-message 恒 BLOCKED（R66 只证
>   建卡——复核原话的实证）→允许空正文+附件（无附件仍拒）；②保存过导航偏好+无记忆路径→boot
>   永远 pending（applyServerNavPrefs 已设 activeProjectId 而 ready 条件误要求空）——G4 调试中
>   「direct=true 但 attr=0」定位。
> - **P4**：共享 Select 全页接入（含 pdf-zoom/恢复对账/绑定弹窗）；member.create+迁移 048+
>   AddMemberModal（无用户延期依据的既定原型功能补齐）；search.query scope=visible；搜索空态
>   EmptyState；成员页全局默认缺模型名提示（startupFailed 根因界面正解：claude 未配 ZS_CLAUDE_MODEL，
>   pre-launch 失败——脱敏只读诊断完成）。
> - **坑**：①bash 内联 python 补丁转义反噬多次（正则/引号）——复杂补丁一律 Write .py 文件执行；
>   ②runDaemonOnce 短命模式不能用于需管道命令的阶段（startDaemon 持久+显式 kill）；③`, token)`
>   全局替换会把 pipeConnect 的 token 参数也剥掉（auth 静默失败表现为「已连接未获 auth.ok」）；
>   ④DOM.setFileInputFiles 在 React 重渲染后节点失效——页内 DataTransfer+File 构造直设 input.files
>   同走 onChange；⑤zip：切回预览标签=WorktreeBody 重挂=重读磁盘（新快照新显示）——「保存读取时
>   快照」语义按挂载期理解，断言应核「落盘==保存时刻显示」而非旧字节；⑥原生 select 展开为系统层
>   不可截图——统一性以收起态+aria/键盘断言。
> - **待续 R68+**：HTML 交互网页（如实不支持）；R64 遗留小项（project.open 响应 rootPath）；多远端
>   upstream 复核；正式 AI 成果（自然交付件）三源阅读的第三源 UI 场景（合同层已覆盖注入）。

## 当前真实状态（2026-10-06 第六十六轮，唯一权威快照）

> R66=桌面前端修复长批次（用户八项反馈+文件-only 决定）。**主交付=desktop-daily-win-v4**
> `bld_bfeb48c4bb82b07b`（commit 6536301，dirty=false，591/591，verify-desktop-daily 全绿）；
> 交互门 `verify-parity-r66.cjs` **全绿**（G1–G8）；视觉门 `visual-pairs-r66.cjs` 10 组同视口
> 成对（1280×800@1）+vision 复核 19/19+重拍 9/9；升级演练 `verify-upgrade-r66.cjs` 全绿
> （**用户 v3 真实数据根全量副本** 46→47+备份+回退+原根 hash 不变）；全量 899/899+双类型门 0 错。
> - **迁移 047=R65 真实遗留缺陷修复**：navigation_preferences.pinned_project_ids_json 列从未被
>   创建——navigation.get 恒抛 no such column→applyServerNavPrefs 恒失败→重开侧栏按空集隐藏
>   （R65 门未察：persistNav 服务端写也同因静默失败，仅 localStorage 镜像生效）。047 后
>   服务端导航偏好/重开侧栏装载恢复正常；persistNav 加「空可见集不落服务端」防首启毒化。
> - **八项反馈全闭**（详见 prototype-parity-matrix-r66-20261006.md）：白屏根因（唯一一处内联
>   filter selector 违反快照稳定）+TitleBarBoundary/MenuBoundary 双层隔离+原型形态项目入口；
>   MD 排版阅读/HTML 隔离页（sandbox=""+CSP+base）/阅读源码切换入实际分支/readFull 全文与
>   64KB 提取窗分列/技术说明入文件信息；DM 320/440/480 降级+列表收起+单区切换（自渲染
>   PreviewPane，挂载判定与布局判定分离——否则首个标签永死锁）；文件-only 发送（body 可空
>   superRefine+标题📎文件名+未知信封完整意图身份比较+图片门空正文 EMPTY_MODEL_INPUT 双端）；
>   导出收 ⋯ 菜单命名「导出会话记录」；恢复三态（启动已有/运行中新增 toast 不弹遮挡/普通排队
>   中性分节）；member.runtime.effective（未绑定→全局默认 ZS_RUNTIME 如实分列）；下载原文件
>   （attachment.originalFile+zs:saveAs 窄桥——路径用户选/renderer 不可指定）。
> - **P4 页面**：成员（卡片+筛选行+绑定弹窗+房间名单+不设假「添加成员」）/搜索收藏/活动/待办/
>   归档（新路由 /archive+设置嵌入，恢复=project.lifecycle/room.archive 真命令——纠正此前
>   「未接入」误标）/看板统一 `.page-filters`+seg+EmptyState+card 外壳。
> - **坑（本轮新增）**：①PreviewPane dlBusy useState 加在早退后=hooks 顺序崩（点附件白屏，
>   ErrorBoundary 吞掉无 console——诊断钩子+Runtime.enable 才现形）；②探针管道直注册不经 UI
>   →需 reload 让注册表装载；③房间派发需 @成员（mentions 空→AUTO→BLOCKED 无 run——G7 首次
>   pending 造不出来）；④outbox pending 会被 worker 即租（lease 不看未来租约）——排队 UI 正例
>   须真实占用 worker（stall 任务 A leased+任务 B pending）；⑤打包 daemon 需 ZS_PACKED_ENTRY=1
>   否则静默 exit 0；⑥CDP eval 响应形态 d.result.result.value（r65 门 resolve(d.result)——
>   自写 makeCdp 勿再踩）；⑦vite dev 绑 ::1——探针需 --host 127.0.0.1。
> - **R66 后续（不阻塞用户使用）**：视觉门数据密度对齐（正式侧目前夹具单项目——manifest 已
>   标注）；HTML 交互网页/搜索「侧栏可见」范围档/添加成员（DEV-10）如实限制；R64 遗留
>   project.open 响应 rootPath 等小项不变。

## 当前真实状态（2026-10-06 第六十五轮，唯一权威快照）

> R65=完整桌面前端逐项检查与修复长任务（用户反馈：项目按钮/属性/添加房间/看板/添加项目有缺陷；
> 不再只修点名三页）。**主交付=desktop-daily-win-v3** `bld_cdc7ef00dabddccd`（commit 368ebf05，
> dirty=false，591/591，verify-desktop-daily 全绿）；交互门 `verify-parity-r65.cjs` **全绿**；
> 全量 894/894+双类型门 0 错。v2/用户数据/草稿/CA 稳定保留。
> - **项目与房间闭环（复核 §1A/§4 反例全闭）**：迁移046（projects.description+navigation.pinned）；
>   daemon 增量 project.list/update(CAS)/lifecycle(archive/unarchive/remove/restore/relocate+未结束守卫)、
>   room.update/archive/members.set、navigation.get/set（服务端导航偏好）；前端=注册表合并不替换
>   （开 B 不丢 A）、TitleBar 项目管理菜单（勾选可见/点名切换/搜索）、侧栏 ⋯（置顶/编辑/主页/成员/
>   设置/归档/移除）+「+」建房（在途锁连点恰一次）、项目主页（挂载聚焦+最近项目+重新定位）、
>   项目设置页（信息 CAS/验收开关/协作限制/归档/全停=board.view→逐任务三重绑定停止）、
>   欢迎页真实注册表+OpenFolderModal 真实 pickFolder 幂等注册。
> - **看板还原**：TasksBoardPage 同源（范围/房间筛选/项目×状态分组/待验收版本/退出未确认标注），
>   数据=board.view 权威聚合（+room_task_number 投影）。
> - **Git 合同级**：branch.list 真 upstream/ahead/behind（null=未知不冒充 0——复核 §1 反例闭）；
>   git.remote.list 真清单；owner 字符串批量暂存不再降级全路径；写动作经交互门 UI 实证（暂存→提交
>   →bare origin 收到推送）+STALE 负对照拒绝。
> - **R64 声明纠正**：visual-gate-r64 不能称「七组同尺寸成对全绿」（4 张原型图+视口不同）——
>   visual-gate-r65/manifest.json 已如实登记；本批新场景成对原型图**待补拍**（不冒充成对）。
> - **坑**：daemon 管道单实例——探针第二客户端 ENOENT（改走渲染进程 window.zs=真实用户路径）；
>   暂存后 s.git 投影 10s 轮询才见提交表单（gate 需等 textarea）；applyServerNavPrefs 无偏好=全量可见；
>   房间状态投影缺 description/revision 曾导致设置无锁（room.list 已补）。
> - **待续 R66+**：视觉门成对原型图补拍（同 CSS 视口/DPR/主题）；活动/搜索收藏/待办/归档管理/DM/
>     成员页原型结构逐页核对（现为功能完整但非原型布局——矩阵 F 节待修不因本批收口）；
>     project.open 响应补 rootPath/canonicalPath；upstream/计数在 remotes 多远端场景复核。

## 前轮快照（2026-10-06 第六十四轮）

> R64=**按已批准原型还原前端**（用户明确拒绝「只学会配色」的简化界面；R63 首用 PASS 收案但
> 原型一致性未过）。**主交付=desktop-daily-win-v2** `bld_33e7c538c32dfa09`（commit 4218a360，
> dirty=false，591/591，verify-desktop-daily 全绿）。完整差异矩阵与施工日志=
> `prototype-parity-matrix-r64-20261006.md`（必读）。用户下次只看三处点名场景（回复串/文件
> 与Git/设置）是否回到原型体验。
> - **架构**：AppState 视图模型=唯一边界（原型页面组件原样移植；loader 水合层把 roomPool/
>   thread 快照→threads/messages/tasks/readStates/subscriptions/taskDeliveries/runs；selectors
>   对未装载线程按卡片兜底）；lib layout/threadNav/panels/actions-nav/actions-preview 原样移植
>   （引用=r61 引用卡+摘录独立+评论=源会话仅记录真实提交）；正式产品零依赖原型模块/seeds/
>   mock-tree。
> - **已还原**：Room.tsx（宽窗 L2 主池+context-thread 并列/房间三页签/线程三视图+详情分组/
>   次级菜单/窄窗/分隔条/L3L4 预览并排——出站账本/停止/验收返工/关注静音/收藏/表情/导出/
>   room.create 全真）；PreviewPane 合并（原型壳+正式渲染体+legacy 桥接）；FilesGitPage（真实
>   目录懒装载 project.files.list+工作区 project.file.read 预览）；GitPage 全真（daemon gitWrite
>   全链接回原型入口）；Settings 七分区（真实=启动项目/主题/runtime 绑定+派发防护/数据根+草稿
>   快照+清理/远程监听/诊断；未接命令禁用说明）；App 壳（原型侧栏+路由表 /project/:id/room/
>   :id?thread=，boot/接管/深链/恢复面板保留，旧 /room=/thread= 归一）。
> - **两门全绿**：交互门 verify-parity-r64.cjs ok=true（real_calls=0/优雅退出/零残留）；视觉门
>   dist/desktop/visual-gate-r64/（原型×正式成对 7 场景+manifest）。全量 894/894+双类型门 0 错。
> - **坑（本轮实证）**：①RoomPage 装载 effect 误插 early-return 之后=重开即崩（Rendered more
>   hooks）；②useStore selector 返回新数组（.filter）=useSyncExternalStore 契约违反整树崩——
>   必须 useMemo；③daemon DTO 无 sha256 于 project.file.read（hash 占位如实）；④git 命令面
>   完整存在（gitWrite 全链）——矩阵初稿误标能力限制；⑤heredoc 长脚本会被截断——用 Write 落
>   .py 再执行。
> - **待续（R65+）**：DM/看板/活动/收藏/归档/项目设置页按矩阵 F 节逐页还原；upstream/ahead/
>   behind/remotes 投影补齐；研讨/运行详情只读投影；v2 用户反馈优先。

## 前轮快照（2026-10-06 第六十三轮）

> R63=日常桌面使用批次（review-r62-next-round 全项；主线转用户日常使用，复用已认证 runtime/
> 配置）。**用户收案**：R1/R2 **PASS 继承不再重测**；Android 除发送失败就地提示缺口外报正常
> （不补造细节，低优先级）；G9 维持 NOT_RUN。**主交付=日常桌面便携包
> `desktop-daily-win-v1`** `bld_b285020fd554bda1`（commit 850240f，dirty=false，591/591，
> 验证全绿 r63-daily-20261006043816，real_calls=0）。用户下一步只有**首次使用检查三步**
> （打开自己的项目/成员配置/仅记录保存一条重开可见）——不再有 G/R 清单。v6 及演练包保留作
> 工程验证形态。
> - **[§1 统一成功清算（review-r62 §2 反例）]** settleOutbound 扩为唯一成功结算源（正文/
>   mentions（payload member/all↔id 串映射）/refs/一次性意图（记录串回 record）/上传项/删账
>   一次写）；Composer 成功分支只读结算结果同步 UI；retryUnknown 成功走同一函数；原型同步
>   分支注明非第二源。反例（发送成功旧 @ 芯片残留）闭拢：浏览器门 18/18。
> - **[§2 主键保全锁定（review-r62 §3 分离负例）]** 隔离写失败（新增键败+覆盖可成）→
>   persistLocked：主键永不覆盖/persistSnapshot 短路/编辑仅内存态/**stageOutbound 拒发**
>   （不冒充已落账）；retryDraftPersistence 恢复路径（释放存储→隔离成功→解锁）。20/20。
> - **[§3 日常配置路径]** MembersPage「配置 runtime」（member.setRuntime：渠道/claude 模型
>   必填/executable/permissionMode；fake 仅环境允许时可选）；保存后回读+**refreshMembers
>   刷新 store.memberRuntimes 投影**（发送区提示即时消失）；Composer 发送区未绑定就地原因+
>   「去成员页配置」直达（AUTO=无已绑定 agent、@ 指派=该成员未绑定）；SettingsPage「数据与
>   草稿存储」（app.identity 数据根/快照健康度四态/recoveryNote/重试按钮）。
> - **[§4 ZS_ALLOW_FAKE 打包形态泄漏修复（验证中发现）]** main.ts 原 `?? '1'` 缺省注入使
>   打包形态永远 fakeAllowed=true——现打包形态仅透传显式设置（dev 保持缺省放开；演练包启动
>   器自设不受影响）。日常包 runtime.status 实证 fakeAllowed=false/realDispatchGuard=false。
> - **[§5 日常包（make-desktop-daily.mjs）]** 同构建门；启动器 ZS_RUNTIME=claude（成员绑定
>   优先解析）、无 ALLOW_FAKE/GUARD/BOOTSTRAP、**不运行 seed 不带 seed/samples**；数据根=包内
>   server-data（稳定、与演练根分清）；README-DAILY（首次三步/数据根/常见情况/工程-日常覆盖
>   边界分列）。验证脚本 8 段全绿（欢迎无 seed 双库证/环境自述/打开实际项目引导执行成员+
>   默认房间/绑定表单 fake 选项不存在+落库回读/未绑定提示绑定后消失/仅记录+草稿跨重开/
>   real_calls=0/零残留）。
> - **[§6 Android 就地提示（低优先级顺手修）]** remoteClient 发送失败就地显示发送区
>   （send-error 行，绑定发起目标切走即清；事件流保留诊断）：空正文校验人话化（'Too small:
>   expected string…'→附件非正文替代，正文仍需≥1 字符）、IMAGE_INPUT_UNVERIFIED 三选项
>   （去图/仅记录/继续文字——**不放开图片能力门**）、服务拒绝；草稿附件一律保留；pending
>   重试同路。文本级核对入库（未做移动端重设计；随之后必要产物带出）。
> - **坑（本轮新增）**：main.ts spawn env 的 ?? 缺省会污染打包形态（环境自述要与形态核对）；
>  日常包验证点击必须断言 find 结果（?.click() 静默 false 掩盖路由未达）；CDP eval 在关窗
>   销毁期超时属预期（以进程归零为准）；members 页渲染等待窗口受首启装载影响（45s）；
>  bat pause=启动器不随窗退（exit 判据以副本进程归零为准）。
> - 全量 **894/894**；主+hifi 双门 0 错。Android DEV25 v6/CA/RESULTS 未动。
## 当前真实状态（2026-10-06 第六十二轮，唯一权威快照）

> R62=复核缺口收口+Git 只读入口批次（review-r61-next-round 全项）。**新基线
> hifi-h4-win-v6** `bld_9f70ef7f6d48ff8d`（commit 4c1888a4，dirty=false，591/591，三连
> allPass r61-20261006034542）。v5 R1/R2 与 Android v6 回填仍未收到——用户仍只需 R1/R2
> 两组（v5 已测则继承）；G9 无自然新回复维持 NOT_RUN。v4/v5/旧包/回填原地保留。
> - **[§1 出站信封账本（review-r61 §2 早崩反例闭拢）]** store 出站账本在**交给 bridge 之前**
>   耐久落盘完整信封（stage=sending；落盘失败=取消发送+内存回滚，不冒充已保存）；三态收口
>   ok=settleOutbound（**先剥已发正文/refs/上传项并持久化、最后删账**——中途崩溃=账本仍在→
>   重载横幅→同号重发幂等→再结算）/failed=drop（草稿保留）/unknown=confirm（转 pendingSends
>   横幅）；重载=账本全转 pendingSends（recovered 标记，人工同号确认，不自动发送不退普通
>   草稿）；Composer 守卫=未确认信封存在且正文逐字未改时阻止换新号发送；retryUnknown 清算
>   改先剥内容后清信封。房间/私信/线程三目标共用。**dev 演练 early-crash-r62 全绿**（账本
>   3ms 落盘/同号恢复/守卫拦截/恰一次）+**交付形态 early-crash-pkg-r62 全绿**（v6 包×真实
>   启动器×丢回执：账本 4ms/崩溃自动重载（文档新鲜度证——bat 管道不透传 stderr）/同号恰
>   一次/参数逐字 status=saved）；r61 崩溃演练复跑无回归；浏览器门 15/15。
> - **[§2 快照防护+TTL（review-r61 §3）]** initDraftPersistence：JSON/版本/逐条字段校验
>   （draft/envelope/upload 三类）——不支持版本/整体损坏=**原件逐字隔离** `<键>.quarantine-
>   <ts>` 后才新空态（v2/损坏 JSON 反例闭拢：不覆写唯一原件不伪正常）；部分损坏=恢复有效
>   条目+隔离+recoveryNote 计数；**普通草稿 updatedAt+24h 过期**（批准 brief §3.3——r61
>   注释「亦无过期」系误写并更正；无戳回退 savedAt）；未确认账本独立无 TTL；过期草稿上传项
>   不复活。测试 10/10（未来版本/损坏/部分损坏/TTL 边界+账本超龄/盖戳）。
> - **[§3 类型门（review-r61 §4 前半）]** 主门 22 错清零：浏览器型测试移入 `tests/browser/`
>   （主门 NodeNext/无DOM 排除；hifi 门 DOM+bundler 纳入并开 allowImportingTsExtensions；
>   vitest include 纳入）——双门 0 错，非移出门外伪绿。
> - **[§4 包验证器聚合门（review-r61 §4）]** aggregatePass 函数化；v5favoritesOk/v5quoteOk
>   纳入总 pass；bat 退出码严格 ===0；收藏断言绑定具体消息 id×saved_refs 行消长×kind/viewer
>   （非全库计数）；引用断言绑定线程草稿+引用卡含 artifact hash 前 8 位+摘录含真实幻灯文本；
>   --self-check-negatives 7 例变异矩阵全捕获（两门 false/bat=7/bat 缺项/门缺项/正对照）。
>   重启轮坑：草稿跨重启保留（合同）→引用判据前须显式清残留正文。
> - **[§5 回退凭据闭环（review-r61 §5）]** upgrade-drill-r62：凭据基线**前置**；演练根
>   ensureServerIdentity 生成 CA/服务证书（纯 fs 不触用户 v6）；升级前/后/恢复根三点 CA 指纹
>   （identity.json **caFingerprint** 字段——坑：不是 fingerprint）+五文件哈希一致；token
>   全程保持；SAN 重签与 CA 更换分列注明。宽模式 Esc 补实际矩形+原生键断言位（v6 演练
>   overall=true 含 wide 位）。
> - **[§6 Git 只读入口（review-r61 §6）]** FilesPage Git 标签新增提交历史（git.history；
>   后端加性 HistoryItem.parents 全列）+提交差异（git.commitDiff(parentOid)）+merge 父选择
>   （parentsMeta 芯片+mergeNote；comparedParent 回显+请求参数回执核对）；独立代次快切
>   防污染；非 Git 目录如实失败。fixture 探针全绿：root/normal/side/--no-ff 双父/binary/
>   截断(2 万行)/超限省略(55 文件>50 上限)；**坑：fixture 目录必须在任意 git 仓库之外**
>   （OUT 在 zhongshuo 仓库内会被当工作树子目录）；spawnSync git 提交中文 message 直接可用。
> - **坑（本轮新增）**：探针 heredoc 反斜杠续坑（用 chr(92)/chr(10) 构造）；electron 探针须
>   await app.whenReady()（r61 靠构建耗时碰运气）；fixture 残留目录删不掉（EPERM）→时间戳
>   唯一目录；打包 DB messages 列=status（record_only→'saved'），无 intent/disposition 列；
>   材料门串要与模板实际文案逐字对齐（'未自动粘贴' vs '不再自动粘贴'）；聚合函数引用 runOnce
>   局部 n 会 ReferenceError（参数化 runNo）。
> - 全量 **889/889**（含 githubSandbox）；主+hifi 双类型门 0 错；v6 Esc 演练 overall=true
>  （toolbar/slide/input/upper-dialog/wide 五位；zoom Ctrl+= frameless 宿主不生效=如实边界）。
## 当前真实状态（2026-10-06 第六十一轮，唯一权威快照）

> R61=用户反馈修复批次（review-r60-next-round 全项，用户 v4 G1–G10 手测反馈优先）。
> **用户结果已回填**：G1/G3/G4/G5/G8/G10 PASS、G2 正常观察、G6 PARTIAL（收藏不能取消）、
> G7 FAIL（Esc+引用）、G9 NOT_RUN（无新回复——不造数据）、Android 仍未回填。
> **新基线=hifi-h4-win-v5** `bld_292768533f1c899c`（commit 978c8527，dirty=false，591/591，
> 三连 allPass r61-20261006023342，real_calls=0）——用户只补 R1 收藏切换/R2 文件引用与 Esc
> （约 5–10 分钟），v4 通过项继承；G9 无自然新回复仍 NOT_RUN。v4 与用户回填原地保留。
> - **[§1 G6 收藏切换]** savedMessageRefs 投影（saved.list→message 类，项目打开刷新）+
>   toggleSavedMessage（已收藏→saved.remove 原内容不动/未收藏→saved.add；同消息在途互斥，
>   连点忽略后到点击；失败如实提示状态不变）；MessageView 书签 aria-pressed+data-zs-saved+
>   填充样式；**无处理器入口不渲染**（表情/引用/追加更正——不以本地日志冒充功能）；DmPage
>   补 onSave/onReact/onQuote；收藏页取消→消息行同步。探针 TG6 全绿（按钮态×DB 双断言/
>   reload/收藏页同步/注入失败/连点）。
> - **[§2 G7 文件引用重做]** 「引用文件」=资源引用卡直写目标草稿 attachments（与上传附件
>   同一正式链路：发送进 attachmentRefs，服务端 audience/完整性/范围/图片门终审）——正文
>   保持用户文字；同文件同版本去重；跨会话写入前拒；成果/详情标签引用直落草稿+zs:focus-
>   composer 自动切回回复（消除「无可见结果/回回复才插入/第三次批量灌入」根因——
>   pendingQuotes 队列删除）；「摘录」独立动作：内容真源由各格式子组件上报（文本/PDF 当前页/
>   Word HTML 文本/表格当前窗口/幻灯当前页），不再从 page-stack DOM 抓取。queueDraftInserts/
>   takeDraftInserts 一次性消费。探针 TG7 全绿（成果页连点两次→恰一卡正文零污染/第三击去重/
>   同名不同文件两卡/移除/发送 refs 落库恰一条/注入丢回执→原信封重发恰一次+只清本次引用/
>   摘录不含「模型输入/原文」界面文案）。
> - **[§3 Esc 查明]** v4 交付副本×随包种子 PPT×CDP 原生键×四焦点位（工具栏/幻灯内容/输入框/
>   上层弹窗）**全部正常退出展开**（键真实到达 __escLog）——用户报告未在交付形态复现；缩放
>   Ctrl+= 在 frameless 宿主不生效（scale 恒 1，如实边界）。**语义补全**：wide 下 Esc 也回
>   normal（用户最可能形态=按了「宽」后按 Esc 无动作）；Esc 永不关预览、上层弹窗优先。
>   v5 副本复跑 overall=true（PPT 视觉页真实装载 1/3 页）。
> - **[§4 附件存储位置无关重定位（新发现缺陷）]** v4 副本演练暴露：种子附件 blob_path 记录
>   打包时绝对路径——**包目录复制/搬移后所有附件预览报「路径越出托管存储」**。修复：
>   readStoreBytes 记录位置不在当前根时按当前存储根 {hash}.{ext} 重定位，realpath/受控句柄/
>   实际字节 sha256 校验全保持（绝不读越出当前根的文件）。storeLinks 4 新测试+attachmentChannels
>   旧断言按新合同更新（外部同 hash 名内容不同→返回当前根内容；当前根缺失→如实不可读）。
> - **[§5 草稿/未知信封持久化（纠正 R60 判据——原报告保留）]** store 持久化层：正文/提及/
>   意图/已就绪引用/完整未知信封（含 queued）随变更快照 localStorage；命名空间=数据根+本地
>   用户（新 app.identity 只读命令）；在途上传不落盘（恢复=重新选择）；removed 不复活；持久化
>   失败内存仍生效+「草稿未持久化」如实提示；未知信封不设 TTL；重载不自动发送、仅记录不变 AI。
>   bootRemembered 在打开项目前初始化。**同内容不重写修复**（真缺陷：重挂载照写草稿把代次+1
>   →重试清算「代次未变」判定失效→已发正文残留）。集成测试 5/5+崩溃演练全绿：回执丢失→
>   完整原信封冻结（含 commandId）→Page.crash→自动重载恢复草稿+仅记录意图+横幅（同号）→
>   重发恰一次+正文剥离+record_only 零新 run（draft-recovery-r61-…021136）。
> - **[§6 G9 工程正例]** M0 合同=任务串人类跟进只记录不派发（followUpRecorded）——真实新
>   agent 回复经正式返工链（task.review changes_requested+task.executeRework 完整身份）产生。
>   TG9 全绿：关注→离开→水位不动→真实新回复→待我处理出现→阅读消失；静音排除（daemon
>   mine.pending 真值+UI 双断言）。夹具坑：task_review_enabled 是项目开关、tasks.review_policy
>   是创建时快照（两者都要设）；task_deliveries 部分唯一索引=每任务仅一条 pending（先置
>   superseded）；reworkPending 派生要求 delivery.run_id 非空。
> - **[§7 回退演练外部资源]** upgrade-drill-r61 阶段 D：blobstore manifest（hash 复算+文件名
>   形态）→恢复根逐文件拷贝完整→恢复库附件实读（previewText）→export.create 含附件
>   missing=0→local.token 不变；边界=旧程序系当前源码+子集迁移形态（含 §4 重定位），真实
>   已发布旧 binary 不代宣布。阶段 A 补：附件挂正式消息（导出含附件前提）。
> - **[§8 性能分项+githubSandbox]** 分层实测：daemon 就绪 179ms / history 2/2/1ms / 桌面 UI
>   454→455ms（各自成行不互相冒充）。githubSandbox 复跑 **5/5 全过**（62s）——R60 唯一失败
>   证实瞬时 TLS 抖动，原报告保留。全量 **879/879**。
> - **坑（本轮新增）**：工具层 heredoc 吃反斜杠（python 字符串 
 变换行——用 chr(92) 构造）；
>   CDP Input.dispatchKeyEvent 带 nativeVirtualKeyCode 会 Invalid parameters（去掉即可）；
>   preview visual-state 是 slide-controls 的**兄弟**节点非子节点（选择器写错=60s 假超时）；
>   waitForJs 用 document.querySelector 只看第一个 chip（some() 才对）；CDP 轮询粒度计入 UI
>   耗时；收藏按钮只在**回复**消息上（锚块不是 MessageView）；打包 daemon localUserId=homedir
>   派生（夹具直插 dm_participants 要用 app.identity 真值）；docx-word-evidence 二进制 fixtures
>   每次全量测试再生成（打包前 git checkout -- 恢复可得 dirty=false）。
## 当前真实状态（2026-10-05 第六十轮收尾批次，唯一权威快照）

> R60=升级/兼容/证据收尾批次（review-r60 全项）：版本门+升级回退演练+renderer 故障注入
> +兼容性能实测+矩阵重核。**桌面手测基线固定 hifi-h4-win-v4**（用户 G1–G10 待执行/待回填，
> Android v6 未收到回填）；本轮改动不影响 G1–G10 任何测试路径——**不交新候选**，r60 修复
> 入库待下次打包（若用户反馈需修复，新候选集中带出）。
> - **[§1 数据库版本门（review-r59 §2 反例 future-schema-result.json）]** migrate() 入口先核
>   fromVersion≤支持上限：更高版本在任何写入前抛 SCHEMA_VERSION_UNSUPPORTED（提示用对应
>   程序或恢复匹配备份）；不降版本号/不删未识别迁移记录；openDatabase 失败路径统一关句柄
>   （entry 既有 catch 释放单实例锁）。schemaVersionGate 4/4：当前库重开零迁移不新建备份；
>   子集前缀（1..44）旧库升级+迁移前 VACUUM INTO 备份恰一份；伪造 v46+记录拒写（版本与
>   记录原样保留+零业务写入+一致复拒+**更旧程序同门**——已升 45 的库不能被子集程序打开）；
>   备份目录不可写=安全拒启动（库未被改动）。已发布迁移 001–045 冻结未动。
> - **[§2 升级/回退演练]** upgrade-drill-r60-…153359 全判据过：阶段 A=旧程序形态（子集迁移）
>   建库+当前命令层 v44 真实写入（project.open[中文+空格]/message.submit/uploadText/task.review
>   +保护事实种子：损坏 probe released+完好 probe released）；阶段 B=打包 daemon 同根启动即迁
>   44→45：迁移前备份恰一份、七类事实逐项保持（身份/消息/线程/附件 blobstore hash/任务/预算
>   标记/审计完整行 SELECT* 逐字）、**045 证据分类器实际生效（坏 probe→retained、好 probe→
>   released 不动）**；阶段 C=回退=旧程序+升级前备份（复制快照至独立 restore-data）——事实与
>   升级前一致+旧程序可继续正式写入+**旧程序直开升级库被版本门拒**；升级 daemon 退出码 0。
> - **[§3 renderer 故障注入+产品修复]** 修复前真实崩溃（CDP Page.crash）留白屏——main.ts 补
>   **render-process-gone→reload**（界面重载、daemon 不重启、任务不重派；clean-exit 不重载；
>   枚举实名 'clean-exit' 非 cleanly-exited——typecheck 拦下笔误）。renderer-crash-r60-…155045
>   全判据过：主进程+daemon（daemon.pid+kill(pid,0) 实证——命令行不含数据根，进程表匹配
>   不可靠）存活、任务 runs 不变、门禁未落、自动重载后项目/会话/历史归属恢复（崩溃前标记
>   可见）、内存草稿如实为空（合同=不跨崩溃恢复）、崩溃后可继续正式写入、优雅关窗退出码 0
>   零残留、real_calls=0。dev 形态真实 Electron（electron.exe --remote-debugging-port+
>   dist/ui/main.cjs——package.json 无 main 字段，electron . 非受支持路径；Chromium 开关须在
>   入口路径之前）。
> - **[§4 兼容/性能实测+产品修复]** 修复 project.open 接受文件路径（discovery/写入后续才坏）
>   ——directoryIdentity 补 isDirectory→PROJECT_MISSING 入口即拒。local-compat-r60-…155927：
>   冷启动 230ms/复用 215ms/daemon RSS 75.7MB；非Git 目录可开；文件/不存在路径→
>   PROJECT_MISSING；icacls 拒写目录如实记录（读侧扫描不写该目录，打开成功）；DM 300 条
>   record_only 369ms+history(limit100) 1–2ms×3；**v4 包内 node.exe+daemon.cjs 在 PATH 剥离至
>   系统最小集下 220ms 就绪**（打包 Node/native 无开发 PATH 依赖）。中文+空格/小窗/长历史/
>   预览/首启复用=继承既有认证不重跑。全量 869/870（唯一失败=githubSandbox 真实网络 TLS 波动
>   ——git ls-remote 可用/curl 000，环境级如实登记）；双 typecheck 0 错。
> - **[§5 验收矩阵重核修订]** final-acceptance-matrix-r59（同文件修订，git 历史留 R59 版）：
>   备份条件（仅待迁移+传目录才产生——目录存在≠回退闭环，回退已由演练实证）；042=只回填
>   NULL 与 043–045=证据降级**分列**；G4=授权上限 33/**实际 30**（$8.6578，3 次保留未用），
>   延期维持不重开；M1 分列（DEV-08/09 既有真实证据/演练包 M0 限制/新界面未接入/价值闸门
>   未结论）；DEV-10 按证据（剩余=resumeSession 真实续接+restrict* 拒写对照，不由 UI 入口
>   位置代替）；**merge 多父 diff=gitWrite.ts parentsMeta+legacy 父选择按钮均已存在**（真实
>   缺口=新界面未接入，非未实现）；用户状态=**v4 待执行/待回填、Android 未收到回填**。
>   每行实际实现/已跑证据/尚未覆盖/外部依赖/下一动作。
> - **[§6 发布准备]** operations-readiness-r60：启动形态×数据根×开关×认证边界四列表；
>   备份/升级/回退**可执行步骤**（回退=旧程序+升级前备份，非旧程序直开升级库；无待迁移不
>   新建备份的如实限制）；安装器（NSIS 双形态，工程 1 轮）/签名（OV≈$200–400/EV≈$300–700
>   每年，需用户采购）/自动更新（electron-updater，依赖签名）方案与成本清单——**待用户
>   决定，本轮不购买不发布**。
> - **[坑（本轮）]** ①package.json 无 main 字段——dev 真实主进程=electron.exe 直跑
>   dist/ui/main.cjs（electron . 非受支持路径）；②Chromium 开关须在入口路径之前（放后=应用
>   参数，端口不监听）；③Page.crash 成功回执即 "Target crashed"；④electron.cmd 经 cmd /c
>   相对路径不可用（绝对路径或直跑 dist/electron.exe）；⑤daemon 存活实证用 daemon.pid+
>   kill(pid,0)（命令行不含数据根）；⑥pipex 上 spawn 的 daemon 就绪可晚于 renderer——管道
>   连接必须带重试窗；⑦旧管道连接关后新实例必须重建 client；⑧conversation.history 为 DM
>   专用（房间=room.pool/thread.history）；⑨bash 内联 node -e 的 $_/反斜杠必被吃——复杂
>   探针一律写文件；⑩Electron 44 枚举='clean-exit'。

## 当前真实状态（2026-10-05 第五十九轮长批次，唯一权威快照）

> R59=版本绑定与证据收紧批次（review-r58 全项）：执行返工完整身份绑定+OS 证据判据收紧+
> 手测依赖修正+验收矩阵准备，交候选 **hifi-h4-win-v4**。v3/用户数据/RESULTS 原地稳定。
> - **[§1 执行返工版本绑定（review-r58 §2 反例 stale-rework-result.json）]** 事实：旧页面
>   只传 taskId，另一路把返工推进到 v2 后，命令默默入队 v2 返工（outbox 2→3）。修复：
>   task.executeRework 参数改为**完整快照**（deliveryId/deliveryRevision/manifestHash/
>   sourceRunId 必填——r58 旧形态=VALIDATION_INVALID 安全拒）；事务内核核对归属+「当前最高
>   版本=该 changes_requested」；旧 v1 引用面对 v2=STALE_REVISION、**零 outbox/run/审计
>   副作用、不自动改绑**。意见正文仍取服务端记录；同号同参重放=网关幂等原回执；就绪/停止/
>   在途/保护/预算守卫不变。reworkPendingOf/conversation.list/task.get 补完整执行身份；
>   DmPage/ThreadPage 点击冻结快照。合同 reworkExecutionContract **5/5**：③两轮自然交付
>   旧引用负例+合法 v2 恰一次（runs 1→3）；④同 revision 错 id（RESOURCE_NOT_FOUND）/错
>   hash/错 sourceRun 归属/错 revision 全拒零副作用；⑤重放幂等不二次入队。
> - **[§1b 探针 r59 27/27]** verify-hifi-h4-r59（r58 基线 26+TDM4）：**页面版本漂移反例**——
>   探针转发层受控延迟 conversation.list 6s 冻结面板渲染（真实机制非 mock）→另一路执行 v1+
>   对 v2 提交新意见→冻结面板点击仍携带 v1 完整身份（sentLog 实证四字段齐备）→服务端 STALE
>   拒绝 toast、零 outbox、任务保持 ACTIVE→解除冻结后面板如实显示 v2 意见B→合法执行 v2→
>   **executing 主标题分列**→自然 v3；跨视图一致性（task.get=REVIEW 与库同源）。返工面板
>   状态分列（recorded/executing data 属性——review-r58 §4 文案收尾：已入队不再称「尚未执行」）。
>   全量 **866/866**；主/hifi 双 typecheck 0 错。
> - **[§2 OS 证据收紧（review-r58 §3 五缺口）]** verify-os-crash-restart-r59：①retained 观察
>   窗口**结束后重读**任务二计数+turn 事实（不查等待前旧值）；②审计前缀**完整事件行**比对
>   （SELECT * 全列 JSON 逐字——payload/关联身份/时间都在内）；③退出码**必须===0**+PID 实际
>   退出实证（kill(pid,0) ESRCH——不再直写 pidReaped）；④失败分支先写报告再按**精确 PID**
>   收拢自 spawn 进程；⑤负对照实跑：`--self-check`（8 项篡改全被集中判据 checkFacts 拒，
>   exit 0）、`--negative-no-release`（真实流程跳过正式解除→恰一次判据拒 3 项+优雅停机
>   +exit 7——总 pass 确会失败）。另记录 daemon.cjs sha256 与候选包内 daemon 对应（v3=
>   R58 源码构建 sameBytes=false 如实）；覆盖边界分列：daemonCrash/pipeDisconnect=covered、
>   rendererCrash/managedSubprocess=NOT covered（声明不扩张）。正式全链 exit 0：
>   os-crash-r59-r59-oscrash-20261005144704（checkErrors 空）。
> - **[§3 手测依赖修正（review-r58 §4）]** 包外补充说明已由评审入库
>   （hifi-h4-v3-user-test-addendum-20261005.md）；make 模板同步吸收：G3 先做到 v2 出现→
>   **G4 借用 v2 确认框**→回 G3 验收收尾；G6 起/至先留空→至=昨天→**清空「至」**→起=今天；
>   G2 看 M0 提示前先移除芯片（不必发送）；G7 引用后切「回复」标签再核输入框；G10 只观察
>   退出不查 PID；单项目当前/全部相同不算失败。
> - **[§4 最终验收矩阵准备稿]** final-acceptance-matrix-r59-20261005.md：旧库升级与副本回退
>   （001→045 保守回填链/backups+独立数据根）、源码与产物对应（构建门/BUILD 身份/591 清单/
>   包根材料门/daemon hash 对应/三连）、能力分列（已认证/仅原界面/未开放）、G5 剩余条件
>   （DEV-10/14/15 尾巴+G4 用户匿名评分+价值评价延期+用户回填待办+兼容矩阵未启动）——
>   只列事实不代记 PASS，无变化认证矩阵不重跑。
> - **[§5 交付 hifi-h4-win-v4]** buildId bld_c4eee31c1f63f0e2（commit 94ccbbd8，dirty=false；
>   591/591+包根材料门 v4 期望全 true）。verify-hifi-package-r59 三连结果：
>   **allPass r59-20261005145035**（run1/2/3 全 pass；首启/复用/重启、重启轮真实恢复流、
>   bat=0×3、real_calls=0×3、优雅停机/PID 归零；包根材料 readmeH4/templateMerged/
>   templateReworkStep 全 true）。v3 已测结论继承——v4 只需补测返工执行相关少量项（G3/G4）。
> - **[坑（本轮）]** ①bash 管道吃退出码（`node x | tail` 后 $? 是 tail 的——负对照核退出码
>   必须重定向后单跑）；②git add 混 2>/dev/null 会吞 pathspec 错误（review 文档实际名
>   review-r58-long-batch）；③候选包 daemon 路径=ZhongshuoDual/resources/app/daemon/。

## 当前真实状态（2026-10-05 第五十八轮长批次，唯一权威快照）

> R58=稳定性收口批次（review-r57 全项）：准入恢复失败防护+返工真实执行闭环+OS 级崩溃重启
> 补证+稳定性收尾+材料修正，交最终候选 **hifi-h4-win-v3**。旧包/用户数据/RESULTS 原地稳定。
> **[R57 覆盖声明纠正（review-r57 §3）]** R57 TDM2 的「第二交付」是夹具手工 INSERT/UPDATE——
> 它只证明「意见记录与新交付可验收」，**不证明**「提交意见后真实续跑」。R58 已废除该注入并
> 重写为真实链；R57 探针/报告原样保留。
> - **[§1 恢复读取失败防护（review-r57 §2）]** restoreAdmissionFromDb 吞错按空账本启动=把
>   未知占用当零（独立反例 restore-read-failure-result.json：注入一次 SELECT 失败后确认继续，
>   同成员新任务 DONE、startTurn=2）。修复：占位 SELECT 失败或行级绑定读失败（部分恢复）
>   均**抛错拒绝启动**（「准入占位恢复失败——拒绝按未核实账本启动派发（重启 daemon 重试）」）；
>   预算/保护/审计事实在库中重读不改写。合同④（memberQueueContractR56）：负例 A/B 库事实
>   零变化；重试成功→占位继承→resume 后零新增（member deferral）→retained 期间零新增→
>   正式解除恰一次（startTurn 1→2，任务一恒 1 run）；makeEnv 补 entry 同款 releaseAdmission
>   进程内联动钩子。
> - **[§2 返工真实执行闭环（review-r57 §3 反例 rework-dispatch-result）]** 事实：task.review
>   只写验收账本（意见入账/任务 ACTIVE/零 outbox——连续泵 false）。新增 **task.executeRework**
>   命令：以**库内** changes_requested 验收事实为源（意见/版本服务端为准、客户端只传任务号），
>   沿 task.redispatch 同守卫栈（就绪/在途/停止代次/幂等）与同键命名空间
>   `task:<id>:redispatch:<sourceRunId>` 入队；负例全拒（重复=IDEMPOTENCY_CONFLICT、待新
>   交付/终态=STALE）；domain_events 记 task.reworkEnqueued。**assembleDmTurn 补
>   reviewFeedback 附注**（此前 DM 返工 turn 输入不含意见=无反馈重跑——仅房间路径渲染）。
>   **reworkPendingOf** 派生「意见已记录、尚未执行/已入队」（conversation.list+task.get 暴露；
>   DmPage/ThreadPage 面板+执行返工按钮+toast 文案纠正）。合同 reworkExecutionContract 2/2：
>   DM 全链（意见→泵 false×2→执行→同 task 新 run 且**模型输入含【返工】注记+意见原文+v1
>   版本号**→v2 自然产生（revision 递增、v1 验收记录保留不涂改）→验收 DONE；终态后执行=
>   STALE）+负例（待验收/无返工事实拒）。探针 TDM2 重写（r58）：页面提交意见→「尚未执行」
>   面板→**显式执行**→同 task runs 1→2→v2 自然上屏→验收 DONE——零 INSERT/UPDATE。
> - **[§3 OS 级崩溃重启补证（review-r57 §6-2）]** verify-os-crash-restart-r58.cjs：**真实进程**
>   （dist/pack/daemon.cjs 打包形态）独立数据根+独立管道名；ZS_FAKE_STALL_MS 受控在途→
>   按精确 PID taskkill /F（只操作自 spawn 进程）→重启后 recovery.status 核：门禁 held+旧
>   turn UNKNOWN（命令+直读库双核）→**dispatch.resume 后同成员任务二零新增**（member
>   deferral 留证）→对账 FAILED+refunded+retained 期间零新增→正式解除→恰一次（t2 恰 1
>   run/1 turn，t1 恒 1 run）→domain_events 崩溃前前缀**逐字保留**→renderer 断连/daemon
>   故障分列（客户端关闭后 daemon 存活、事实不变、可重连）→优雅停机退出码 0→real_calls=0。
>   证据 dist/desktop/os-crash-r58-r58-oscrash-20261005134222/result.json 全断言通过。
> - **[§4 稳定性收尾（review-r57 §6-3/4）]** ①DmPage.submitReview 补 try/finally——成功路径
>   reloadAll 抛错曾把 busy 永久卡 'review'（探针实证：执行返工按钮禁用、命令零发出——
>   「不锁死操作忙态」）；②首启后台观察器增加 openInFlight 让位（打开在途时 activeProjectId
>   尚未落位——观察器抢代次会覆盖用户选择；openProjectByPath 入口置位、按代次条件清除）；
>   ③pickAndOpenFolder 失败只在无项目时降级 boot=failed（已有项目保持可用）；④DM 读取失败
>   面板+重试按钮。探针 r58（r57 基线 25+TZ 预览连续开关×3/无叠加/关闭后 Ctrl+K 全局键存活）
>   **26/26 PASS**；全量 **863/863**（含新增 3 项）；主/hifi 双 typecheck 0 错。
> - **[§5 材料修正（review-r57 §4）]** 根因=R57 打包显式 outArg 复用 R56 目录+writeIfAbsent
>   跳过已存在 README/模板→旧材料进新包。修复：README-H*改**总是写当前版**（工程件无用户
>   回填；writeCurrent）；RESULTS 模板保持不覆盖（用户回填就填在模板上）。README-H4=v3 口径
>   （返工两步走）；**H4-TEST-template 重写为 G1–G10 合并清单**（H3-v2 未回填项+H4 新操作一次
>   短测，约 20–25 分钟；G3=返工显式执行步骤）。verify-hifi-package-r58 新增**包根材料门**
>   （README/template 关键词核验，独立于应用 591 清单；不一致退出码 5 拒绝三连——首轮即
>   拦下期望串笔误，门有效）。
> - **[§6 交付 hifi-h4-win-v3]** buildId bld_1f8807e36da4d3af（591/591+包根材料门）。
>   verify-hifi-package-r58 三连结果：**allPass r58-20261005140403**（run1/2/3 全 pass；首启/
>   复用/重启三形态、重启轮真实恢复流、优雅停机/PID 归零/bat=0、real_calls=0×3；包根材料
>   门 readmeH4/templateMerged/templateReworkStep 全 true）。
> - **[坑（本轮）]** ①探针点按钮必须先等 disabled=false（忙态卡死+toast 替换双重教训）；
>   ②recovery.status 字段=gateHeld/pendingDispatchCount（非 held/pending）；③daemon 信封
>   commandId≥8 字符；④Esc 要派发在 document.activeElement 上；⑤预览 Esc 只退展开不关面板
>   （关闭=按钮）；⑥验证器材料门期望串须与源码文案逐字对齐（不自动执行≠不会自动执行）。

## 当前真实状态（2026-10-05 第五十七轮长批次）

> R56=H4-v1；**R57=复误收口批次**：恢复准入继承（P1 缺口）+DM 返工正式链+跨会话操作框
> +面板 DTO+首启欢迎，交独立候选 **hifi-h4-win-v2**。旧包/用户数据/RESULTS 原地稳定。
> **[R56 结论纠正（review-r56 §2）]** R56 的「跨重启同成员保护已核清」声明**不成立**——独立
> 复核 queue-retained-result.json 证实：UNKNOWN+retained 旧 turn 下 dispatch.resume 后
> 新 worker（空 admission 内存）照常派发同成员另一任务（startTurn=2）。R56 测试②当时把该
> 行为当正例，恰好漏掉此层。R57 已修复并重写合同测试；R56 历史报告原样保留。
> - **[§1 恢复准入继承（review-r56 §2）]** `DispatchAdmission.restore(turnId,dims)`+DispatchWorker
>   **构造器**按持久事实恢复占位（UNKNOWN / protection_state='retained' / 非终态在途——
>   恢复不查限额：既成占用如实）；`releaseAdmission`/`reconcileRelease` 增加 **retained 门控**
>   （notStarted→FAILED+refunded 但 retained 期间继续占用；recovery.releaseProtection 解除后
>   经同钩子放行）。memberQueueContractR56 ②重写：dispatch.resume 后同成员**零新增
>   startTurn**（文件库关闭重开+全新 worker 双重证明——同进程共享 adapter 连续计数）→
>   notStarted 对账（FAILED+refunded+retained）继续占用 → 正式解除（no-os-process 服务端
>   证据）后**恰一次**续跑+任务一零新 run。**声明边界**：fresh-worker+恢复库状态模拟（进程内
>   文件库重开），非真实 OS 崩溃重启——后者留待后续批次补证。三个旧测试文件按新合同更新：
>   stopIntentGeneration/boardFormalStates 的「停止结算」（settleStop/恢复后跟进）补
>   recovery.reconcile executed 收口（确认继续≠退出证明，对账后才派发）；lateOutcomePath
>   并行 UNKNOWN 构造改用不同成员（mA/mB/mC 真实派发）。**860/860+主/hifi 双 typecheck 0 错**
>   （R56 的主 typecheck 4 错已随测试重写消除——此前「双干净」声明不实，已纠正）。
> - **[§2 DM 返工正式链（review-r56 §3）]** 旧实现返工传 `reviewComment`（服务端只收 `note`
>   →VALIDATION_INVALID 恒拒）。改为复用 `submitTaskReview` 适配器（note 字段）；失败原因
>   准确呈现+**意见文本保留**可修正重提（不再一律「交付可能更新」丢文本；真更版才作废）。
>   探针 TDM2 全链：返工意见入 domain_events（note 原文可查）→任务回 ACTIVE→新交付 v2
>   （fixture 注入+任务回 REVIEW）→再次验收 DONE。
> - **[§3 跨会话操作框（review-r56 §4）]** DmPage 重命名/验收框捕获**目标快照**
>   （conversationId+revision / 三重身份），切会话 effect 即作废+提交前双核对=零提交；
>   作废判定按**完整身份**（同 revision 不同交付也作废）+作废框可关闭重开。ThreadPage 验收框
>   同判（threadId 绑定+manifestHash 全比较+切线程作废）。探针 TDM3 双侧 DB 反例：A 开验收框+
>   重命名框→切 B→两框消失+**task.review/conversation.rename 命令零发出**+A/B 状态与标题两侧
>   DB 不变（不止断言弹框消失）。
> - **[§4 面板 DTO+失败反馈（review-r56 §5）]** 任务项 hint 映射 board.view 真实
>   taskStatus/runStatus 中文（探针断言无 undefined）；board.view 聚合失败显示错误行（不冒充
>   零任务）；locate 失败 toast 明确反馈（旧注释「全局 toast」不实已改）。
> - **[§5 首启（review-r56 §6.1/6.2）]** bootRemembered 成功读到**空记忆**=立即 boot ready+
>   欢迎面板（data-zs-welcome——探针 TW1：0ms 出现、侧栏无「失败」字样）；**演练包竞态兜底**：
>   欢迎态下 150s 有界后台观察（种子晚写 autoOpen 时自动进入，真实新装环境自然结束不冒充）；
>   记忆路径失效与未就绪分列（真实原因+可操作；不再被外层 catch 归类「连接中」空转）。侧栏
>   常驻「打开/切换项目」入口（folder 图标）。
> - **[§6 探针 r57 25 段 pass]** verify-hifi-h4-r57.cjs（r56 基线 22+TW1 欢迎/TPA 状态核/
>   TDM2 返工链/TDM3 跨会话反例）；**TA 时序修复**（v5 审计失败根因=fake turn 异步收口与夹具
>   UPDATE/INSERT 竞态——新增 untilTaskSettled 等真实终态后再注入，r0/r1 双夹具）；新截图
>   视觉 PASS（欢迎/跨会话两张）。产物 dist/desktop/review-r57/。
> - **[§7 交付 hifi-h4-win-v2]** buildId bld_cbd9f0c1cba4e22b（591/591）；README-H4 v2 短测
>   指南重写（具体前置：H3=「+Guide A 新建空闲会话」避免种子忙碌链、H7 关注未读需**离开后**
>   新回复且无回复=NOT_RUN、H8 日期区分截止昨天/今天+关闭放最后）。**verify-hifi-package-r57
>   三连 allPass r57-20261005121618**（首启/复用/重启——重启轮按真实恢复流：逐 UNKNOWN 对账
>   executed/no-os-process→确认继续派发→同成员排队意图按合同继续 runs≥1；bat=0×3、
>   real_calls=0×3、优雅停机/PID 归零/身份不变）。**过程记录（失败保留）**：候选一
>   bld_69c05a8bd26416f9 因欢迎分支终止 bootRemembered 使「窗口先于种子」竞态下永不入项目
>   （run1 失败 r57-20261005115629）；候选二 bld_cbd9f0c1cba4e22b 首验 run2/3
>   roomDispatch runs=0——**准入继承正确扣住重启后同成员派发**（r57-20261005120231），
>   验证器补真实恢复流后三连全过。另：验证器 procsOfCopy 守卫会误匹配**本会话 shell**
>   ——排除 bash.exe/cmd.exe（包只跑 bat/electron/node）。
> - **[坑（本轮）]** ①python 直写大文件碰 CRLF/引号嵌套易碎（lateOutcomePath seed 曾错序
>   FK+语法错——改用 Read+Edit 精准段）；②验证器 guard 自匹配会话 shell（见上）；③fixture
>   必须等真实 worker 终态再注入（untilTaskSettled）；④TDM2 返工后注新交付需同时把任务
>   回 REVIEW（pendingReview 只看 REVIEW 态）。
> - **[待办（R58）]** 用户 hifi-h4-win-v2 集中短测（README-H4 v2 H1–H8）收案；**真实 OS 崩溃
>   重启**的准入继承补证（进程树级）；多尺寸/缩放截图对照补充；G4/DEV-10/11/并行写入/价值
>   评价延期保持；Android v6 独立。

## 上一轮快照（2026-10-05 第五十六轮长批次，唯一权威快照）

> R55=反馈合并修复+三页归位+hifi-h3-win-v2；**R56=H4 收口长批次**：两确认缺陷修复+同成员排队
> 合同核清+命令面板/恢复界面/H4 外围+日常操作归位+独立候选 **hifi-h4-win-v1**。旧包
> （H2-v2/v6/H3-v1/H3-v2）与用户数据原地稳定；Android 用 v6。能力↔入口↔状态对应清单见
> `hifi-capability-map-r56-20261005.md`。
> - **[§1 两确认缺陷（review-r55 §2）]** ①搜索清空倒灌：runSearch 对空关键词/无效范围**先作废
>   在途代次**（genRef++）再 return——迟到旧响应不再写屏，同时清结果/错误/加载态；②收藏
>   「当前项目」范围：按收藏行 projectId 过滤生效；链接收藏（无项目关联）给「复制链接」动
>   作+计数说明（收窄时不静默消失）。
> - **[§2 同成员排队合同核清（review-r55 §3，换种子成员不能替代）]** 新增
>   `tests/integration/memberQueueContractR56.test.ts`（**受控短暂忙碌 600ms，不增并行/不绕
>   租约**）：①同 Agent 两房间任务——忙时第二项 `run.admissionDeferred{reason:'member'}` 留证
>   +outbox 回 pending+零 run/turn+startTurn 恰 1（真实等待非沉默）；释放后同 worker 领取续跑
>   （恰 2 次、两键各 done 一次、再泵零新增）；②「崩溃」重启（applyRecovery 同款）——在途
>   turn→UNKNOWN/run→INTERRUPTED/门禁落下，门禁期新 worker runOnce 返回 false 零领取，
>   `dispatch.resume{confirm:true}` 后排队意图继续，`task.redispatch` 对未对账旧意图按
>   RECONCILE 拒（不复活），UNKNOWN 不在派发路径改写；③同 DM 连续消息串行+恰一次入库。**机制
>   结论**：成员串行=DispatchAdmission 进程内存（生产单 worker 实例）；跨重启保护=UNKNOWN+
>   门禁+对账（不靠 admission 记忆）——r55 的「永久挂起」实为停机落停滞窗留 UNKNOWN→恢复
>   门禁等用户确认（合同行为），非排队缺陷；测试曾用「新 worker 实例」模拟重启反而绕开了
>   admission——以生产单实例+applyRecovery 组合验证为准。
> - **[§3 命令面板+快捷键]** 复用原型布局，正式数据：页面动作+房间/私信/成员（store）+任务
>   （board.view scope=all）+消息/线程（search.query 防抖 260ms，清空作废在途）；↑↓/Enter/Esc，
>   IME 组合态不触发（compositionStart/End+isComposing 双门）；Ctrl+K 仅 hifi 可见响应
>   （legacy-on 守卫）；**面板只导航/定位**（locate 深链），不承担确认执行/验收/解除保护。
> - **[§4 恢复检查界面]** recovery.status 只读事实（门禁+排队键/UNKNOWN turn 明细/待解除保护
>   retained/中断 run/未收口撤销/租约/上次停止记录）四类动作**分列**：确认继续=dispatch.resume
>   {confirm:true}（不接受空参）、对账=recovery.reconcile（verdict+note 必填+notStarted 风险
>   确认——租约保留）、解除保护=recovery.releaseProtection（服务端取证拒活体）、定位=深链；
>   侧栏常驻入口+有注意项首启自动弹一次（每启动一次）；中断恢复执行（task.redispatch）留在
>   任务自身上下文与对账分离。探针 TRC 全链（fabricated 崩溃→门禁→notStarted 对账 turn
>   FAILED→确认继续 gate open）。
> - **[§5 日常操作归位]** ①DM 头部操作行（重命名 revision CAS/归档恢复/停止三重绑定/继续队列
>   dm.resume 泵一条/待验收返工三重身份冻结框/中断恢复绑来源 run+不可恢复原因/导出
>   MD·HTML·DOCX+openPath exports 白名单开目录）；②线程关注/静音（thread.subscribe 人的阅读
>   订阅）+消息引用插入草稿（insertText）+表情 message.react toggle+导出 MD/DOCX；③预览
>   窄/宽(880px)/全屏展开（Esc 退出、面板/恢复弹窗打开时让位）+「引用到输入框」（按当前路由
>   定草稿键+固定版本+可见摘录，无输入页如实提示）；④搜索补作者/日期窗/会话筛选
>   （search.query 参数一一对应）+长历史定位补读（thread.history beforeSeq 每轮 100 至多 5 轮
>   ——**发现并修复：5s 刷新整表替换会冲掉补读历史，loadThread 改按 id 合并+seq 排序**）；
>   ⑤标题栏防护标识（runtime.status 扩 dispatchGuard 只读自述：fakeAllowed/realDispatchGuard
>   →「演练·模拟派发/真实派发」徽章 data-zs-dispatch-guard）。
> - **[§6 交付 hifi-h4-win-v1]** buildId bld_9505e0b4e980e83c（591/591）；范围=H3-v2 全部+本批
>   全部（README-H4+H4-TEST-template 入 make 脚本与白名单）。**探针 verify-hifi-h4-r56.cjs
>   22/22 pass**（r55 基线 15+TGU 防护标识/TPA 面板四态/TLS 筛选含确定性负例/TLL 补读定位/
>   TTH 关注静音引用表情/TDM 重命名→验收→导出→归档恢复全链/TRC 恢复全链/T8 宽度展开引用）；
>   全量 **857/857+3**（新增 memberQueueContractR56）+typecheck×2；视觉核验：13 张 PASS
>   （恢复弹窗截图=对账后 retained+解除保护状态——合同正确的分列中间态；设置双反斜杠=探针
>   夹具写入字面值非产品问题）。**verify-hifi-package-r56.cjs 三次运行 allPass
>   r56-20261005102739**（首启/复用/重启分列，在 r55 全链上新增：防护标识/面板开-选-关/
>   恢复入口；real_calls=0、优雅停机、run2/3 重启历史）。
> - **[坑（本轮）]** ①**probe 的 daemon.command 返回原始 envelope**（{ok,data}——不自动解包
>   ；conversation.create 取 conversationId 要 .data）；②toast 会顶掉前一条——验收 toast 出现
>   ≠busy 复位（finally 在 reloadAll 后）——探针等按钮 disabled=false 再点；③CompositionEvent/
>   Escape 须派发在焦点元素（window 派发到不了 React 目标）；④Electron probe 焦点键顺序：
>   palette 打开后 activeElement=输入框；⑤loadThread 整表替换冲掉补读（已改合并）；
>   ⑥TLL 目标要排除锚消息（锚块 id 同为 msg-<id>，初始可见≠补读证明）。
> - **[待办（R57）]** 用户 hifi-h4-win-v1 集中短测（README-H4 H1–H8，约 15–20 分钟；旧项不重测）
>   ；收到反馈优先处理实际失败。余项：原型设置/成员视觉细化、多尺寸/缩放截图对照补充（本轮
>   以 1440×900+900×620 为主）、G4/DEV-10/11/并行写入/价值评价按既定延期；Android v6 独立。

## 上一轮快照（2026-10-05 第五十五轮，唯一权威快照）

> R54=无边框标题栏+H3 收尾+hifi-h3-win-v1；**R55=合并用户短测反馈修复（T2 完整版/T4 发送前
> 提示/设置显示同步/附件呈现）+搜索与收藏/活动流/线程成果标签三处归位+独立候选
> hifi-h3-win-v2**。H2-v2/v6/v1/H3-v1 原地稳定（不重建）；Android 用 v6。
> - **[§1 T2 完整修复（页面级复证过）]** 旧正则只覆盖行首/空白后的末尾 @（用户实测「整理任务
>   要点@」中文紧邻残留）。新实现**按触发位置消费**：`mentionTrigger={index,draftKey}` 在
>   detectMentionTrigger（**光标前一位是 @** 即开候选并记下标——不再只认正文末尾）时记录；
>   insertMention 只删该下标处仍为 @ 的那一个字符；工具栏 @ 打开=null（选人不动正文）；Esc=
>   取消（保留 @）；IME 组合中不触发（composingRef 早退）、组合结束重判；切草稿/引用插入/
>   insertText 都清触发；正文其它 @/邮箱永不被全局替换。探针 TM 五例全过（中文邻接/工具栏/
>   Esc/IME 组合中关+结束开/邮箱不触发）；**包级**（真 app bundle）同样复证（t2m0Real）。
> - **[§2 T4 发送前提示（不开放 AUTO）]** M0 边界保持（mode_unavailable_in_m0 服务端合同不
>   动）；UI 在 room_root+ai+**route.mode≠DIRECT**（AUTO 未指派 / DELIBERATE 全体·多人）时
>   输入区上方常驻提示（`data-zs-m0-hint`，文案=服务端同款「M0 模式下房间任务需 @ 指定成员
>   （AUTO/DELIBERATE 未开放）——发送后任务会立即受阻」）+「@ 指定成员」「本次仅记录」两个
>   动作；**不禁发送、不静默改目标**；DIRECT 后提示消失、移除指派回来（探针 TH 三态全过）。
> - **[§3 附件呈现三修]** ①线程锚消息（根消息）附件芯片 kind 标签复用 MessageView 的
>   ATTACHMENT_KIND_LABEL（导出共享——此前只认 code/text，PPT/CSV 显示成「文本」）；
>   ②**预览头真实身份**：PreviewPane 新增 identity 状态，各格式子组件取到数据后上报
>   revision/hash，头部优先用上报值（已发消息无 hint 打开也显示 v1/sha256 真值，不再 v?/空
>   hash——探针 TA 断言头部含 v1 且无 v?/sha256=…）；③过期「R52」文案清除（ThreadPage 占位
>   按钮与 LEGACY_SECTIONS 重写——成果标签成真）。
> - **[§4 设置显示同步+标题栏断连]** saveSetting 成功回读后**当场更新对应控件**
>   （repoStatus.visible→setRepoVisible——此前只写库不更新页面，按钮/「当前」文字停旧值需手
>   动刷新，用户短测确认）；探针 TS 双向（显示→当前：显示+按钮互换；隐藏→复原）+库里
>   true/false 全过。标题栏连接态：store 新增 conn/connInfo，main.tsx 注册 zs.onDisconnect/
>   onReconnected（main 进程管道关闭/重连推送——既有事件，hifi 此前零消费，首启 ready 永远
>   「已连接」）；TitleBar 断线=「已断开——重连中」红点 data-zs-conn=offline，重连恢复（探针
>   TC 注入事件验证）；浏览器宿主收不到事件保持缺省（不假装）。
> - **[§5 review-r54 §5 收尾]** PendingPage 范围显式分列（默认**全部可访问项目**=§17.7 旧判，
>   「当前项目」为显式收窄+省略说明——此前静默 filter 当前项目，其它项目待办无提示消失）；
>   提醒行 key+确认忙锁=**occurrence 身份**（reminderId+scheduledAt——同提醒多项待确认分别
>   可见/可锁）；MembersPage runtime 四态分列（查询失败（留上次事实+原因）≠未绑定≠已绑定·
>   安装缺失≠正常——**installationId=null 不再显示「已绑定」**；房间名单失败≠装载中）。
> - **[§6 三处归位（真实接线）]** ①**LibraryPage 搜索与收藏**（/library，侧栏入口替换 legacy
>   项）：search.query（范围 当前项目/全部可访问项目、类型过滤、分页——附件随所在消息检索
>   如实注明；结果行=正式 locate 深链，「定位 ↗」可视提示）+saved.list（missing/forbidden
>   如实、取消收藏 saved.remove 原内容不动）+**线程回复书签→saved.add**（幂等，ThreadPage
>   onSave 接线）；②**ActivityPage 活动流**（/activity）：activity.list（默认全部可访问项目）
>   (created_at,seq) 双键游标「加载更早」、定位分列（task→#task= 服务端解析/DM→#dm=/房间无
>   任务→本地房间导航——**#conv= 不在深链族不用**、空 id locate 按长度过滤）；③**ThreadPage
>   「成果与附件」真标签**（替换 R52 占位）：会话附件=attachment.listByConversation（带真实
>   v/hash→预览头同源）+本任务交付=files.view 按 taskId 过滤（v2 待验收等）；「查看成果与
>   附件」从详情可达。**daemon 活动流 kindLabel 映射补全**（视觉核对发现 12/14 英文原键——
>   补 task.statusChanged/turn.statusChanged/run.created/thread.created 等约 30 条，纯显示层，
>   DTO 形状不变）。
> - **[§7 H3 短测前置（review-r54 §6）]** ①**种子房间任务卡**：seed-client.cjs regression 段
>   新增幂等种子（member.list 房间名单取**非 agents[0]** 的启用 agent=Guide B→message.submit
>   mentions=[{kind:'member',memberId}]——**必须是对象形状**，纯 id 串会被 discriminatedUnion
>   拒；只等线程出现（≤20s）不等终态；无合适成员=skipped 如实）；README-H3 v2：H1 **关闭放
>   最后一步**、H2 直接点种子卡（R55 短回归·看板房间任务样本）不需自建、H5 无待确认提醒记
>   NOT_RUN、H6 用「显示仓库状态」开关测保存回读（可恢复）+不要求填任意路径、结果明确填
>   **H3-TEST-template.md**。
> - **[§8 交付 hifi-h3-win-v2]** buildId bld_4658299eb53861b8（清单 591/591）；范围=H3-v1 全部
>   +本轮修复与三新页+种子任务卡（README-H3 列明）。verify-hifi-h3-r55.cjs **15/15 pass**
>   （T1 标题栏/TC 断连重连/T2 缩放/TM 提及五例/TH M0 提示三态/T3 成员/TP 待办范围/T5 设置
>   同步/T6 Files+Git/T7 看板 scope=all/TA 成果+预览头身份/TL 搜索收藏全链（saved.add→列表→
>   remove→原消息在）/TY 活动流/T8 预览 38px/T9 legacy；截图×10+原型×5 于 review-r55/，视觉
>   核验 PASS——首轮两 warn 已修：活动流中文映射、搜索行「定位 ↗」提示）。全量 **857/857**
>   +typecheck×2。**verify-hifi-package-r55.cjs 双轮 allPass（r55-20261005090723）**（在 r54
>   全链上新增：种子任务卡在板、真包 T2/M0 复证、搜索命中、活动流条目；run2 重启历史）。
> - **[证据/坑（本轮）]** 探针坑：**CompositionEvent 不冒泡=React onCompositionStart 收不到**
>   （组合态守卫假失败——bubbles:true 修复）；cpSync 参数序（recursive 是 options 不是目标）；
>   r54 复制时漏带第二无交付任务夹具/已补。**包验证坑（最重要）**：bat 的
>   ZS_FAKE_STALL_MS=60000 让每个 fake turn 先停 60s——种子房间任务若给 agents[0]（=恢复/远程
>   演练 owner+UI 短测 @Guide A 派发对象），其停滞 turn 会**按成员级互斥挂起同成员后续派发**
>   （验证器自己的派发 OPEN 永不领取），停机再落在停滞窗内还留下 UNKNOWN turn（run2 起被恢复
>   守卫按成员持有——outbox 永久 pending）。修复=种子选非 agents[0] 成员+不等终态（任务在种子
>   退出后 ~60s 自行 REVIEW）。诊断路径：outbox 表 pending 行+agent_turns UNKNOWN+workflow_runs
>   INTERRUPTED 三件套=成员持有。UI 坑：LibraryPage 搜索结果整卡可点但无可视提示（视觉核验
>   抓到——补「定位 ↗」）。
> - **[证据/坑（本轮）]** 探针坑：**CompositionEvent 不冒泡=React onCompositionStart 收不到**
>   （组合态守卫假失败——bubbles:true 修复）；cpSync 参数序（recursive 是 options 不是目标）；
>   r54 复制时漏带第二无交付任务夹具/已补。UI 坑：portal 静态（沿用）；LibraryPage 搜索结果
>   整卡可点但无可视提示（视觉核验抓到——补「定位 ↗」）。
> - **[用户手测状态]** H2-v2 七项已测（T2 修复入 v2 待用户顺手复证——探针已页面级+真包双证）；
>   **hifi-h3-win-v2 待一次集中短测**（README-H3 H1–H6 新六项，约 10–15 分钟；H2 七项与 H3-v1
>   六项不重测）。收到结果优先处理实际失败，不重复旧验收；用户结果不代记 PASS。
> - **[待办（R56）]** 用户 H3-v2 短测结果收案；原型设置/成员页视觉细化余项；G4 用户评分、
>   DEV-10/DEV-11、并行写入、价值评价与 G5 按既定延期；Android 继续 v6 独立推进。

## 上一轮快照（2026-10-05 第五十四轮，唯一权威快照）

> R53=三 P1 修复+h2-win-v2（复核确认收口，**用户集中短测进行中、结果未回填——不代记 PASS**）；
> **R54=无边框标题栏+H3 收尾+hifi-h3-win-v1 独立候选**。H2-v2/v6/v1 原地稳定；Android 用 v6。
> - **[§2 范围分清（复核 §2）]** H2-v2 的 renderer **不含** H3 三页/标题栏（其 T7 与该版本相
>   符）；H3 源码推进+截图材料=「源码已接入、随 hifi-h3-win-v1 交付」，不并称已随 H2-v2 发给
>   用户。
> - **[§3 无边框标题栏]** 主窗 frame:false（--no-hifi 保留原生框对照）；**窄 IPC zs:window**
>   （枚举动作+assertTrustedSender 同判+只作用可信主窗+状态推送 zs:window-state）；preload 暴露
>   zsWindow；关闭=标题栏关闭键→win.close()→window-all-closed→shutdownDaemon **既有优雅链**
>   （无 app.exit 绕过）。标题栏=**#zs-titlebar 独立挂载点**（index.html，在 #hifi-root/
>   #legacy-root 之外——legacy 接管不隐藏、样式由 hifi-flag.js 注入 <style data-zs-titlebar>
>   承担不随 app.css 禁用）；hifi-flag 先装**最小壳**（React 失败/看门狗兜底可重建——
>   __zsTitlebarMinimal），React TitleBar 经 portal 挂载后移除非 React 兄弟（portal 不清容器）。
>   状态行只用真实事实：项目名+daemon 连接态（boot）——原型种子计数不接。布局偏移：
>   body.zs-frameless 下 hifi-root/#app 下移 38px、preview-pane/.zs-legacy-exit 让位。
> - **[§4 H3 收尾]** MembersPage（member.list 项目/房间两级+coordinatorMemberId——**daemon
>   room.list DTO 补该字段**；setEnabled 往返+协调者正式链拒绝如实；member.runtime 绑定/认证
>   分列）、PendingPage（mine.pending 权威汇总：待验收三重身份/无交付如实禁用+定位**与验收
>   分离**/未读/阻塞/**待确认提醒确认执行**=reminder.confirm 正式链 occurrence→dispatched）、
>   SettingsPage 重组（应用/项目分区+「启动时打开的项目」「显示仓库状态」用户名称+**保存回读
>   核对**+诊断信息折叠层放工程键）、FilesPage（项目文本=**project.file.read 只读快照**；Git
>   标签 patch 全事实 change/stat binary·unknown/renamed/truncated/source/filesOmitted+
>   显示区截断显式标注+「在原界面执行 Git 操作」**直达按钮**）、BoardPage（范围 当前/全部
>   可访问项目+visibleProjectIds 合同）。全部页面**请求代次收口**（genRef——迟到响应不污染）。
> - **[§4 布局对照]** 原型同窗对照（hifi-prototype/dist 经本机 http 同尺寸截图 proto-tasks/
>   members/settings）：视觉核验结论=**同一布局语言/同一信息架构**（侧栏 IA 逐项对应、页面
>   头部三段式同构、密度正常）；可接受简化（看板一级范围选择/成员页无添加成员/38px 桌面壳）
>   已记录；原型截图含恢复检查模态遮挡两处（对照局限如实）。
> - **[§5 交付]** **hifi-h3-win-v1**（buildId bld_2e3982c95dba211f，591/591；README-H3+H3 模板
>   入 make 脚本与包；make 用户回填白名单补 H3 模板名）。verify-hifi-package-r54.cjs 双轮
>   allPass（在 r53 全链上新增：标题栏 React 版三键/拖动区/38px 偏移/真窄 IPC、**关闭走标题栏
>   关闭键→优雅停机链**、看板页 board.view 真内容；run2 重启历史）。h3 探针
>   verify-hifi-h3-r54.cjs **pass=true**（T1 标题栏+zsWindow 桩/T2 900×620 缩放/T3 成员往返+协调
>   者拒/T4 待办定位+确认执行 dispatched/T5 设置保存回读/T6 快照+Git 事实+直达/T7 scope=all/
>   T8 preview-pane top=38/T9 legacy 接管标题栏仍在+⌂可回；截图×6+原型×3 于 review-r54/）。
> - **[证据]** 全量 **857/857**、typecheck×2；**坑（本轮）**：bash heredoc 再次吃反斜杠
>   （join('
')→真换行=整文件语法错——frameless 一度未生效；改 String.fromCharCode(10)）；
>   **selector 返回新数组=useSyncExternalStore 死循环**（MembersPage 崩到 legacy——先取整份
>   再 useMemo 过滤）；portal 不清容器（最小壳+React 栏叠加 6 键——挂载时移除非 React 兄弟）；
>   http keep-alive 让 server.close() 永等（closeAllConnections+有界退出）；listen error 无处理
>   =启动挂死（once('error',rej)）；⌂ 按钮挂 body 不在 #hifi-root；mine.pending 无任务标题字段。
> - **[用户 H2-v2 短测已回填]** `hifi-h2-v2-short-test-record-20261005.md`（T1/T3/T5/T6/T7
>   PASS；T4 图片门 PASS+执行受阻=**M0 不支持未指派 AUTO 的模式边界**（mode_unavailable_in_m0，
>   如实不记缺陷）；**T2 提及呈现缺陷**：选 Guide A 后正文残留孤立「@」——R54 已修
>   （insertMention 剥离末尾孤立 @，仅 typecheck+构建验证，**页面级复证在 R55**）。
> - **[待办]** R55=短测遗留复证（T2 修复页面级+T4 模式边界的界面说明评估）+H3-v1 短测
>   （README-H3 六项）+H3 收尾余项（搜索/收藏、活动流、成果列表归位评估）。

## 上一轮快照（2026-10-05 第五十三轮）

> R52=H2 完成但**三处 P1 被复核证伪**（review-r52-next-round-20261005.md）；**R53=三 P1 修复
> +验证收紧+hifi-h2-win-v2 修正候选**。v2/v6/v1 原地稳定；Android 用 v6。
> - **[R52 覆盖更正（保留原报告）]** R52 报告中「P 六格式真渲染含 pptxVisual=rendered」与
>   「打包环境强制验证 PPT」**均不成立**：pptxVisual 用的宽松谓词（任意 min-height 容器）
>   实际命中预览面板滚动正文容器——PPT 视觉从未渲染（宿主死锁：舞台只在 rendering/done 挂载
>   而 effect 又等舞台存在才启动）；verify-hifi-package-r52.cjs **没有 PPT 视觉步骤**。
>   原 thread-r52-result.json/截图原样保留（thread-with-preview.png 中的「视觉页预览不可用」
>   框即死锁证据）；真实补证=**review-r53**（runId r53-20261005…，严格谓词）。
> - **[§2 PPT 死锁修复]** 舞台与控件行在 visualBytesAvailable 时**常驻挂载**（失败 display:none
>   但不卸载——同 Word 宿主策略）；打开/首页失败→真实 abort（signal 已传入 open）+dispose
>   已建 viewer（含 goToSlide 超时）；对共享 abortRef/viewerRef 的清理带「仍是本轮指针」守卫。
>   新增验证挂钩：data-zs-pptx-stage/data-zs-visual-state/data-zs-slide-page/count/controls、
>   data-zs-docx-host、data-zs-pdf-canvas、data-zs-image-decode（值=ok/mismatch/failed——
>   原 naturalWidth===d.width?'ok':'ok' 恒真已废）。PDF 补 render task cancel+doc.destroy()
>   归属；图片对账逐项宽高+如实 mismatch。
> - **[§3 移除幽灵引用]** store 新增 **settleUploadReady**（原子结算）：一次调用核
>   (draftKey,uploadId) 存在+未 removed+发起会话一致→通过才置 ready **并写草稿 ref**（同一
>   同步事务）；任何不通过=回执整体丢弃零草稿写入。Composer 不再自行写草稿（原无条件
>   setDraftFull 是根因）。页面实证（B3）：芯片消失之外——下一条真实信封 refs=[]、
>   message_attachments 零链接（artifact 保留=上传确实发生，如实）、切走再回不复活。
> - **[§4 清算收口]** settleForKey 不再「rev 变→整份 return 跳过附件清算」：**已发 refs 剥离
>   独立于正文保护**（无论等待期是否编辑，都只剥本次 sentIds 并 clearSettledUploads；正文/
>   提及仍按代次门）；retryUnknown 成功分支补剥冻结 attachmentRefs+清 store。页面实证：
>   B4（按住回执期间改正文+传新附件→放行：正文保留/旧芯片剥离/新芯片保留；下一条信封只带
>   新资源；旧资源恰落库一次不重带）；B5（丢回执→unknown→等待期新附件→重发成功：冻结 refs
>   剥离/新附件保留/下一条只带新资源/retry-1 恰一次）。
> - **[§5 构建/材料]** make-hifi-h1-package.mjs **构建门**：入口先跑 build-ui→pack-daemon
>   （退出码非零即中止，产物必须来自当前源码——R52 曾夹带缺 thread.get 的旧 daemon）。
>   README-H2 v2：T2 真实前置（干净种子 PPT 串=记录串，先 @Guide A 发任务再点新任务卡）；
>   T4/T5 先输入正文（仅附件不发送）；T5 真实表名 `CSV!A1:B2`+仅记录发送核落库；T6 改为
>   「复制定位链接」按钮（ThreadPage 详情——`#task=<实体ID>`，桌面无地址栏，跳转=工程验证，
>   用户核格式即可/NOT_RUN）。本轮把 make 脚本+r53 验证器+样本全部入库。
> - **[§6 交付]** **hifi-h2-win-v2**（buildId bld_398c8b90476b0ef9，591/591 清单一致，独立
>   目录）。verify-hifi-package-r53.cjs（独立副本双轮）在 r52 链上新增：PPT 视觉正常链
>   （真舞台子节点>0+done+页数=3——打包环境强制）、未知重试成功清算（带附件派发丢回执→
>   重发→芯片剥离+下一条只带新资源+恰一次）、就绪态移除负例（零链接+artifact 保留）。
> - **[证据]** 全量 856→858（新增 hifiSettlementRound53 1 项+hifiThreadRound51 拆 2？——以
>   本轮 vitest 实跑数为准）；verify-hifi-thread-r53.cjs 页面审计 **pass=true**（B1 死锁修复
>   实证：舞台/翻页签名变化 2144→1263/页数 3/模块请求；**B2 阻断负对照**：503 掉 pptx 模块
>   →failed+舞台零子节点——证明判据不能被降级冒充；截图 thread-pptx-visual-r53.png 经视觉
>   核验 PASS=真实幻灯片+页码 2/3 无降级框）于 dist/desktop/review-r53/。
> - **[H3 第一批已落地]** BoardPage（board.view 只读聚合：列位/退出未确认/受阻原因/待验收
>   徽标；卡→#task= 定位详情）、FilesPage（文件标签=files.view 四类分列：项目文件/托管附件
>   （→共享预览）/Agent 草稿/交付成果（→深链定位）；Git 标签=git.status 真实状态+git.diff
>   只读——写操作明确留原界面）、SettingsPage（app.settings.get/set 真实往返+
>   remote.config.get 实际事实只读+**打开定位粘贴入口**——T6 闭环；未换装项定向列出）。
>   侧栏三入口换真路由（/board /files /settings）；「复制定位链接」（ThreadPage 详情）→
>   「打开定位」（设置页）成对。探针 verify-hifi-h3-r53.cjs **pass=true**（真实命令计数+
>   卡片定位+Files→预览真内容+Git 分支/未跟踪+设置往返+粘贴 #task=→线程详情；截图×3 视觉
>   全 PASS：h3-board/h3-files/h3-settings-deeplink.png）。**无边框标题栏未动**（需改
>   Electron 窗口配置+拖拽区+托盘评估——R54 专题，避免本轮在交付窗体上冒险）。

## 上一轮快照（2026-10-05 第五十二轮——已按 review-r52 更正，原始结果文件未改动）

> R51=H2 开工（e07186a）；**R52=H2 完成+独立候选包**（review-r51 四反例全修+共享预览全格式
> +imageAck/ranges/重试冻结+**hifi-h2-win-v1** 交付）。v2/v6 原地稳定；Android 用 v6。
> **⚠ 更正（R53）：下述「P 六格式真渲染含 pptxVisual=rendered」的 PPT 视觉与「打包环境强制
> 验证 PPT」不成立（宽松谓词命中外层容器/打包验证器无 PPT 步骤）——真补证见 review-r53；
> 「上传中移除→回执即弃不复活」当时只证了芯片消失，草稿仍被写入已移除引用（幽灵引用）；
> 「成功清算按 refs 身份」在等待期编辑（rev 变）时被整份 return 跳过、重试成功分支完全不清
> 附件——三处均已在 R53 修复并页面实证。其余事实（A/B 归属/阅读门/字节合同/深链三修）经复
> 核保留。**
> - **[§2 附件归属]** store.uploadItems（draftKey+**uploadId**+conversationId）为唯一真源：
>   回执按 (draftKey,uploadId) 精确收敛——A/B 同名迟到回执不串（审计 A1 复证 copyText=B-ONLY）；
>   上传中移除→回执即弃不复活（**R53 更正：芯片层面成立，草稿 ref 层面不成立**）；A→B→A
>   芯片由 store 恢复；草稿只存 ready 引用；**成功清算按 refs 身份**（attachmentId 集合，
>   不再 name/size 匹配；**R53 更正：rev 变时被跳过**）。Composer 附件区全部 store 驱动。
> - **[§4 阅读门]** threadReadGate 要求 tab==='replies'+**容器实际存在**（缺容器=false）+
>   前台+贴底；详情视图/迟到 history 一律不推进（审计 A3：markRead=0、水位不变）；新增贴底
>   滚动主动推进（markThreadReadIfAllowed，节流 1.5s）。
> - **[§5 字节合同]** 文本上传=File.arrayBuffer+**TextDecoder('utf-8',{fatal:true})**——坏
>   字节明确失败零上传零 artifact（审计 A4：uploadDelta=0/artifactsDelta=0/失败芯片）；
>   File.text() 有损路径废弃。fileToBase64=arrayBuffer+btoa（双环境）。
> - **[§3 深链三修]** daemon `#delivery=` SELECT 补 conversation_thread_id；routeForResolved
>   未知归属不默认 DM（房间→/room/:id、DM 任务→/dm、查无→null 报错）；App 用完整 route 解析
>   query（此前 pathOf 已剥 query——tab/message 永远取不到）；ThreadPage 同线程 query 变化
>   同步（?tab= 深链/前进后退）+消息定位有界轮询（超窗如实说明）；**legacy 导航所有权门**
>   （legacyOwnsNavigation——hifi 在位时旧端 hashchange/popstate/深链恢复/标读全停）。
> - **[§6.1 共享预览]** preview/PreviewPane.tsx+renderers.ts（与旧界面同一随包渲染器与合同：
>   pdfjs ESM/pptx-renderer/docx-preview+JSZip；Shadow DOM+renderAltChunks:false+净化回退；
>   pptx=RECOMMENDED_ZIP_LIMITS+pdfjs:false+Abort/dispose+**withTimeout 有界**；代次在**渲染期**
>   推进——父 effect 自增会让子组件闭包误判迟到（R52 实测首轮全丢）；六格式+来源/版本/hash+
>   视觉与模型输入分列；表格注入范围写回草稿；消息芯片（线程+DM）/草稿芯片/锚块均可开。
>   **R53 更正：PPT 视觉宿主存在挂载死锁（舞台只在 rendering/done 挂载），从未真实渲染。**
> - **[§6.3]** imageAck=显式二选一 chip（仅发送文字/改仅记录——选择前不发送，一次性冻结进
>   信封）；attachmentRanges 从预览面板写入草稿→builder 冻结；未知信封重试含 refs 逐字一致
>   +恰一次（审计 A5 paramEqual/exactlyOnce）。各 upload* 首传 revision=1 合同事实补默认。
> - **[§6.5 交付]** **hifi-h2-win-v1**（buildId bld_ce1c059ab99a1df6，独立目录；make 脚本改
>   H2 文案+六类样本随包+README-H2/短测模板七项）。**坑：pack-desktop 用预构建 daemon 产物
>   （pack-daemon.mjs）——不改 daemon 只跑 make 会装进旧 daemon（首验卡锚块=thread.get 缺失
>   抓到）**（**R53 已治：构建门入 make 入口**）。verify-hifi-package-r52.cjs（独立副本双轮）：
>   真 bat→自动项目→线程卡→@Guide A 派发+丢回执重发恰一次→线程跟进零新任务→附件真实上传+
>   消息挂载→预览真内容（**仅文本——无 PPT 视觉步骤，R53 更正**）→图片门 imageAck→#task=
>   深链详情实际选中→window.close 停机 forced!=true→PID 归零→batExit=0→real_calls=0；
>   run2 重启历史。原型同窗对照（阅读空间/预览布局）+视觉验收完成。
> - **[证据]** 全量 **856/856**、typecheck×2；hifiUploadDeepLinkRound52 真实链 1/1（归属/坏
>   字节/分列/冻结/imageAck 端到端/范围/重试）；verify-hifi-thread-r52.cjs 页面审计 pass=true
>   （A1–A5 反例复证+P 六格式真渲染含 pptxVisual=rendered（**R53 更正：该字段谓词宽松，
>   PPT 实际未渲染**）+迟到覆盖+截图×2 于 dist/desktop/review-r52/——**原样保留**）。
> - **[R53 待做]** 打包验证器收尾结果落档（本轮后台运行中）+复核反馈；H3（设置/看板/Files
>   归位、Git/诊断、无边框标题栏）按 hifi-integration-plan 排期。

## 上上轮快照（2026-10-05 第五十一轮）

> R50=H1 证据收口（eecf0e2）；**R51=H2 开工（review-r50 四项全落）**：回复串真实页面链+
> 附件信封/预览骨架+深链规范化入口+验证器五项取证修复+补证三连+v2 版本口径澄清。
> v2（用户包）原地稳定；工程全部在源码/独立副本。Android 仍用 v6。
> - **[§4 回复串]** ThreadPage（`/thread/:id`）：主池 ThreadCard（room.pool 全字段）→
>   锚块（thread.get anchor）+回复（thread.history）+thread 目标发送（buildThreadEnvelope
>   ——**不另建根任务**）；记录串默认仅记录；详情=任务概况+停止（绑定 run/代次）+交付验收
>   （**打开即冻结三重身份**，目标变化作废）；关闭视图不停止执行；readGate=线程独立水位门
>   （不混 DM conversationSeq）。DTO 缺口补齐：新只读命令 `thread.get`（audience 核验）。
> - **[§4 附件/预览骨架]** 格式实际限幅（文本 256KB/图片 8MB/PDF、Office 20MiB/CSV 5MB——
>   不统一 20MiB）；Composer 📎 真实上传（uploadText/Image/Pdf/Office/Csv，回执绑会话进
>   HifiDraft.attachments）→ refs 进**不可变信封**（builder 可选字段）；成功只清已发资源；
>   图片+派发=能力门拦截（二选一文案）；消息芯片=真实附件摘要，点击 previewText 真内联。
> - **[§4 深链]** `lib/deepLink.ts`+App 分流：#dm=/#task=/#delivery=/#msg= → deepLink.resolve
>   （真实命令）→ 跨项目先 openProjectByPath → 内部路由（task/delivery→thread?tab=task，
>   msg→thread?message=）——刷新/前进后退走内部路由，实体身份保留。
> - **[§2 验证器五修]** verify-hifi-package-r50.cjs：①procsOfCopy 真路径匹配（反斜杠不
>   加倍——like 无转义义）+查询失败=未确认不冒充零+PID 身份捕获（procsBeforeClose≥1 才算
>   对照、capturedPids 逐一核退出）；②batExit 启动时订阅+pause 周期喂入+exitCode 判定；
>   ③负对照**实跑** waitFor 不可能条件（轮次/时长留档，不实跑则 exit5）；④run2/3 重启历史
>   按上一轮 messageId+taskId（conversation_threads）+UI 标记可见（主池 DOM id=root-<threadId>
>   非消息号——正文核对）；⑤仅记录核 thread.root_task_id NULL+outbox 前后差；DM 回复按
>   reply.messageId（DOM id=msg-<id>）核可见。**坑：spawnSync options 误入参数数组→argv
>   拼出 "[object Object]"（PS 位置参数绑定错误——逐字节比命令才发现）。**
> - **[§2 补证三连]** **r50-20261004160543 allPass=true**（同 v2 产物 bld_f152ca66662dc4ab
>   独立副本）：run1-3 各 batExit={code:0}+procsBeforeCloseConfirmed+capturedPidsGone+
>   residualZero+shutdown forced!=true+realCalls=0；负对照**实跑**超时（6 轮/2036ms）；run2/3
>   priorRunHistoryOk（上一轮 messageId+taskId+UI 可见）；仅记录 thread.root_task_id NULL+
>   outbox/runs 双零差（详见 dist/desktop/hifi-h1-verify-r50/；旧 runId 原样保留）。
> - **[§2/§3 边界]** 旧危险 verify-hifi-package.cjs 加硬拒绝守卫（默认 exit2，考古需显式
>   ZS_ALLOW_DANGEROUS_LEGACY_VERIFIER=1）；make-hifi-h1-package.mjs：独立输出目录（默认
>   hifi-h1-candidate-<stamp>，显式目录遇 RESULTS 用户回填=拒绝）、run-self-check.bat 改指
>   随包 h1-self-check.cjs、清旧残留 self-check.cjs；v2 版本时间线澄清
>   （dev25-h1-v2-version-note-20261004.md：bld_5f1b092fed6e6240→bld_f152ca66662dc4ab 原位
>   重建于用户开测前+外围文件后补写入如实登记；「零接触」口径=591 清单范围）+ 包外说明
>   （dist/desktop/README-v2-体验期间说明-r51.md）。
> - **[证据]** tests/integration/hifiThreadRound51.test.ts（真实链 1/1：线程卡→thread.get→
>   回复不另建根任务→记录串→水位门→验收三重绑定→附件信封+跨会话拒绝→深链映射）；scripts/
>   verify-hifi-thread-r51.cjs=**实际 React 页面×正式 daemon×fake worker** 页面链 pass=true
>   （T1 线程卡/T2 跟进/T3 记录串/T4 验收 DONE/T5 markRead 水位/T6 附件上传+挂载/T7 #task=
>   深链）+同窗截图×2（CDP Page.captureScreenshot——**坑：隐藏窗口 capturePage 返回首帧**）
>   视觉双 PASS。验证面：**全量 855/855**、typecheck+typecheck:hifi、hifi-shell 9/9（P1 选择
>   器随 H2 线程卡更新）、ui-hidden-layout 7/7。
> - **[R52 待做]** 共享预览完整版（PreviewPane+vendored 渲染器复用）、附件排队按消息输入
>   水位、imageAck 显式确认 UI、H2 独立候选包（新验证器需随 H2 UI 选择器更新——主池已
>   .root-card）。

> R49=可短测首包 v2 交付（bbb6a2d）；R50=review-r49 四项收口：**去假阳性三连（独立副本
> r50-20261004144010 allPass）+打包边界+H1 自检+H2 映射盘点**。用户可开始体验 v2；
> H2 已可开工（映射见 hifi-h2-mapping-20261004.md）。v6/Android 不动。
> - **[P1 验证器去假阳性]** verify-hifi-package-r50.cjs（独立副本 hifi-h1-verify-r50-copy，
>   交付包零接触）：恒真 `||true` 删除；**房间指定 @Guide A 派发**经
>   conversation_threads(anchor→root_task_id) 核任务+run/turn（房间根消息 messages.task_id
>   本就不落任务号——旧断言口径错误）；**仅记录**核该消息 task NULL+runsDelta=0；lose-once
>   移到房间步（先 banner→重发原信封→恰 1 条+无失败行内+锁释放后继续）；DM **新建空闲会话**
>   （+Guide B）正常发送核本轮 commandId→message→task→run→turn→agent 回复身份；全部子项
>   纳入 pass。旧 r49 run1/2/3 原样保留（覆盖范围已按复核更正）。
> - **[P1 停机]** window.close()（用户同型）→ desktop-shutdown.json 存在（forced 非 true）
>   → 副本路径进程树归零（CIM 按 CommandLine 匹配副本路径——**坑：junction 中文路径在 CIM
>   返回 mojibake，须按 ASCII copyRoot 前缀匹配且排除 powershell 自身**）→ bat 退出码留档。
> - **[口径]** 每轮记 launchDir（junction 成败如实+realpath）+BUILD/清单 SHA 前后一致
>   （同产物声明落事实）；新 runId 不覆盖旧档。
> - **[P2 打包/自检]** pack-desktop **退出码检查**（失败不拷旧产物）；模板 write-if-absent
>   （不覆盖用户回填）；PPT 种子**入库**（scripts/dev25-dual/回归幻灯.pptx——不再依赖 v6
>   目录）；随包自检=h1-self-check.cjs（文件+全量清单核对，替代旧远程导出脚本）；README/模板
>   明确入口（T2 @Guide A 步骤、T3 +Guide B 新建空闲会话、T4 未触发记 NOT_RUN 勿断网）。
> - **[三连事实]** r50-20261004144010：run1 junctionOk=true（中文+空格路径实跑）、buildId
>   bld_f152ca66662dc4ab 前后一致；房间 taskId/runs=1/turns=1+mentions member；仅记录
>   task NULL+runsDelta 0；DM 新会话回复带本轮 task/run/turn 身份；shutdown forced!=true；
>   residualZero；real_calls=0；负对照留档。全量 854/854、typecheck×2。
> - **[H2]** 映射盘点完成（hifi-h2-mapping-20261004.md）：回复串（thread.history/task.get/
>   readGate 复用）、交付定位（deepLink.resolve+pendingDelivery）、附件草稿
>   （uploadText/uploadOffice+信封 builder 扩展）、共享预览（PreviewPane+vendored 渲染器
>   复用——不重做解析器）；首版落点 replies+task 两 tab，其余原界面定向。

## 上一轮快照（2026-10-04 第四十九轮）

> R47=H1 合同/异步/接管/类型门（0b8dacb）；R48=首包时序收口+hifi-h1-win-v1 工程候选
> （b264a40——**复核认定未达交付门**：启动器缺 seed 依赖/未跑 bat/信封仍 UI 重造）；R49=
> 按review-r48 五项收口并交 **hifi-h1-win-v2**（可短测首包）。H2/H3 未开始；Android 仍用 v6。
> - **[P0 启动器]** make-hifi-h1-package.mjs 入库：pack-desktop 产物+seed（seed-client.cjs
>   **+回归幻灯.pptx**——缺件会静默跳过导致主池空，v1 的根因）+self-check+README-H1+
>   SHORT-TEST 模板（5 项约 5–10 分钟）+start-server.bat（**清父环境 ZS_\***，保留两个
>   注明的工程直通：CDP 端口/受控丢回执；种子失败 exit /b 1；调试端口尊重直通变量）；
>   清单逐件核对 591/591。
> - **[P1 信封]** loader 唯一正式 builder（buildRoomRootEnvelope/buildDmEnvelope——
>   projectId/conversationId 齐全，不从 ComposerTarget 重造）；页面**发送前**构建不可变
>   信封+unknown 时页侧 park（不再回读 commandIdRef——A 切 B 换号反例收口）；
>   retryUnknownSend=sendEnvelope（同号同参逐字重发）。
> - **[P1 测试去假阳性]** 冒烟 P7：重试信封与原发**全参数 JSON 逐字节一致**+无失败行内
>   错误+队列语义（第二条未知顶上属预期）；真实链用**产品 builder** 生成重放信封（不再
>   手工构造比产品更正确的参数）。
> - **[P2 生命周期]** 每键锁 Set（A 回执 finally 只删 A 键）；草稿编辑代次 rev（等待期
>   有编辑→整份保留不剥离）；连续 unknown 排队不覆盖；标读/刷新浮promise 全 catch
>   （未处理拒绝退出码 1 收口）。
> - **[P2 接管身份]** legacy 侧栏按钮带 data-room-id/data-conversation-id；locate 按
>   **机器身份**精确匹配（CSS.escape；房间缺属性才回退名称并标注）——同成员第二会话/
>   同名房间不再错开。
> - **受控丢回执钩子**：main.ts ipcMain `ZS_H1_LOSE_SUBMIT_ONCE=1` 丢弃首次
>   message.submit 回执（命令仍送达）——真包上验证「提交已成功、回执丢失」重试链。
> - **三连全链（最终冻结产物 bld_5f1b092fed6e6240，591/591 清单）allPass=true**：verify-hifi-package.cjs
>   每轮实跑 bat（run1 预杀+清数据根真首启、经「H1 验证 副本」中文+空格 junction 路径）：
>   首启自动项目→房间样本（150s 种子宽窗）→**丢回执→banner→重发原信封→消息恰一次**→
>   跨目标草稿→仅记录→DM 发送+回复→按会话 ID 接管/返回（hash 归一断言）→Browser.close
>   优雅退出→零残留→real_calls=0（直读包内 state.sqlite）。证据 hifi-h1-verify/run{1..3}.json+summary.json。
> - **视觉对照（vision-tester）**：原型（03/01/07）vs H1 同窗对照——两项明显空间问题已修
>   （h1-overrides.css 消息卡通栏对齐输入区；DmPage 会话列 flexBasis 224px 阅读区占 81%）
>   复核双 PASS；顶栏/房间 tabs/composer 状态行/侧栏分区等为 H1 范围裁剪，登记非缺陷。
> - 验证面全绿：全量 **854/854**、typecheck+typecheck:hifi、hifi-shell 9/9、ui-hidden-layout 7/7、
>   hifiFirstPackage 2/2（无未处理拒绝）。
> - **用户短测**：双击 hifi-h1-win-v2/start-server.bat → 按 RESULTS/SHORT-TEST-template.md
>   五项（约 5–10 分钟）；v1=v1 工程候选保留未删。

## 上一轮快照（2026-10-04 第四十七轮）

> 本轮=**H1 首包收口（review-r45-r46 全部 P1/P2）**：正式命令合同、异步发送、能力如实、
> 首启/归属/水位、定向接管、独立 hifi 类型门与真实链测试。R48 交默认新界面的可运行首包
> （回归+打包身份+真实启动器证据）；Android 仍用 v6。
> - **命令合同**：project.open `{path}`（反向对照 rootPath=VALIDATION_INVALID 已测）；
>   room_root target 补 `roomId`；房间名单=`member.list({projectId,roomId})` 逐房间装载
>   （room.memberIds=@ 候选唯一来源——Lab 式二成员名单不混项目全体）；mentions `all`→
>   `{kind:'all'}`（DB 事实）；history `created_at` 如实映射（未知=0 呈现层标注，不伪造）。
> - **异步发送（Composer 正式适配——保留视觉、行为走真）**：onSend 返回回执 Promise；
>   **成功才清空且只清本次发送内容**（等待期编辑/新 @/新附件保留）；确定失败保留草稿+
>   行内错误+换新命令号；**结果未知保留同 commandId 重试**（后端幂等恰一次）；同步锁到
>   回执才释放（双击/Enter 并发防重）；bridge 区分服务拒绝(failed)/传输失败或超时(unknown，
>   20s 窗)。Composer commandId 贯通信封（不再 Date.now 重造）。
> - **能力如实（formalLimits）**：附件/计划开关/权限档位点击前禁用+原因（附件指向原界面）；
>   仅记录入口保留可用；无成员房间派发前置拒绝（可仅记录）。
> - **首启/归属/水位**：bootRemembered 有界 60×1s+失败可见+重试入口；装载代次+请求时项目
>   双门（迟到响应丢弃——review 探针反例收口）；markRead 仅前台+贴底+页面判定；读取失败
>   保留旧快照+readErrors 就地呈现（不冒充空态）；可见时 5s 轻量刷新（隐藏/接管暂停）。
> - **定向接管**：takeLegacy(target) 按 legacy 既有控件定位（board/files toggle+复核、
>   search/project-settings/help details、pending 滚动）——已可见不重复点击（toggle 竞态），
>   连续 3 次稳定确认（boot 收起竞态）；接管时卸载 hifi/app.css（样式隔离）、返回恢复样式
>   +暂停旧端轮询（__zsLegacySetVisible/schedulePoll 门）+刷新数据；ErrorBoundary+8s 看门狗
>   （模块加载失败回退 legacy）。
> - **验证**：hifi 独立 tsconfig（DOM/JSX/bundler+strict，具体投影类型 Room.conversationId/
>   DmConversation.peerDisplayName/execState、ProjectMember.principalType）入 `check` 链；
>   **hifiFirstPackage.test.ts 真实链 1/1**（esbuild 打包交付 loader/store×真实
>   dispatchDaemonCommand×DispatchWorker：{path} 合同/房间名单/指定成员+@全体 DB 事实/仅记录
>   零 run/DM 派发→worker 回复→created_at 如实+作者映射/传输拒绝=unknown→同号重试恰一次）；
>   **verify-hifi-shell 升级为合同校验型 6/6**（桩按 zod 镜像严格校验+P1 房间名单 @ 候选/
>   P2 成功清已发+保留等待期编辑/P3 record_only/P4 受控失败保留草稿+行内错误/P5 定向接管+
>   样式隔离+返回恢复/P6 DM 合同）；ui-hidden-layout 7/7 不回退。
> - 遗留（R48）：双击/IME 的 UI 级专项断言（同步锁已实现）；legacy 顶层杂项命令
>   （renderRemoteSettings 等启动期单次读取）收口；msg-list 宽度/气泡与原型同窗对照截图；
>   首包候选打包（默认 hifi、--no-hifi 仅对照）+冻结/启动器证据。

## 上一轮快照（2026-10-04 第四十六轮）

> 本轮=**主线切换：原型界面接入正式客户端（H1 首包开工）**（用户补充优先级+
> hifi-integration-plan-20261004.md：接入顺序 H1 外壳/房间/私信/消息/输入（3 轮）→H2 线程/
> 共享预览（2 轮）→H3 设置/看板/Files 归位+**Git 与诊断不再常驻挤占聊天区**（2 轮）→H4 收尾
> （1–2 轮））。Android 仍用 v6 不重测；后端合同/用户数据/证据不动；未接能力如实呈现不 mock。
> - **R46 已落地**：react@18.3.1 入根依赖；esbuild 打包 `src/ui/hifi`（原型组件**原样拷贝**：
>   Icon/ui/NavMarks/MessageView/Composer+types/selectors/format/resource/router+四份 CSS）→
>   `dist/ui/renderer/hifi/app.mjs+app.css`（样式**挂载时注入**——不污染 legacy）；真实侧新增
>   `store.ts`（原型 store 同名 API：useStore/草稿/toast/recordLocalOnly——**无种子无 mock**）、
>   `bridge.ts`（window.zs 类型化）、`loader.ts`（project.open/room.list/member.list/room.pool/
>   conversation.list·create·history·markRead/message.submit 映射到原型视图模型；附件提交
>   **明确拒绝**——H2 才接）、App/RoomPage/DmPage、main.tsx。
> - **共存与接管**：默认 hifi 壳（body.hifi-on）；未换装入口（搜索/Git/看板/成员/待我处理/
>   设置）→「原界面」整体接管（body.legacy-on+首次点击才启动 legacy boot——不双装载双轮询）；
>   hifi 挂载失败自动回退；`?nohifi=1`/`--no-hifi`=工程逃生口（legacy 专项验证器用）。
> - **验证**：新 verify-hifi-shell.cjs（实际打包页面+传输桩，断言真实 envelope）**3/3**——侧栏
>   真实 room.list/主池真实 room.pool/房间+私信发送走真实 message.submit（room_root/dm）/
>   legacy 接管守卫；verify-ui-hidden-layout **7/7 不回退**（P0—U6）；视觉子代理双截图
>   **PASS**（三段式侧栏/消息卡片/输入区=原型样式；已修「未知成员」作者映射；输入区宽度
>   对齐与仅记录入口位置 R47 对照原型收口）。
> - R47 待办：仅记录意图真实闭环+mention 选择核实、房间/私信消息呈现与原型逐项对照
>   （msg-list 宽度/气泡）、refresh 轮询节奏、种子/欢迎页空态；R48：去尾+页面级验证扩展+
>   **首包交付候选**（含真实 daemon 冒烟）。tsconfig 暂排除 src/ui/hifi（esbuild 打包为主，
>   H1 收口时补类型门——如实登记）。

## 当前真实状态（2026-10-04 第四十五轮，唯一权威快照）

> 本轮=**v6 四项短回归收案+Android 就绪+两条工程边界**（review-r44-next-round-20261004.md、
> dev25-v6-short-regression-record-20261004.md）：R6/R7/V1/V2 按用户报告与补确认收案
> （正式记录 v6/RESULTS/SHORT-REGRESSION.md+七张原图；PPT 关闭重开/Word 关闭与颜色隔离/
> 三向切换均确认）。**Android 用现有 v6 推进，不换包不清库**；工程修复在源码，随最终候选
> 交付（Android 回填后一次必要的最终候选：冻结三连+清单+真实启动器+旧库升级验证；若复用
> 演练数据与 CA 先在副本证明迁移/回退）。
> - **Android 指南改实口径**（dev25-android-acceptance-guide.md 重写）：v6 运行中；前置=
>   V2 收尾的仅本机恢复 **LAN（0.0.0.0）**+LAN 自检+实际地址（192.168.1.100，端口以当前
>   面板为准）+**不用 198.18 虚拟网卡地址**；v6 CA SHA-256=`c7655e12c4102fad…`（已只读
>   重算核实）；后台恢复=**桌面代发唯一标记「仅记录」消息**（不依赖已消耗的种子 60s 窗）；
>   吊销放最后+其它设备顺带观察；手机/Android/浏览器版本必填模板。
> - **迁移 045（review-r44 §2 纯函数反例）**：044 把「probe 字段在但损坏」（null/[]/false/
>   字符串）折叠成「缺字段」→reason 兜底误放行。045=`classifyProtectionFactFinal`
>   （045-turn-probe-field-integrity.ts）：`Object.hasOwn(p,'probe')` 分离**真缺字段**（受控
>   旧兼容保留）与**结构损坏**（保守 retained）；完好对象 probe 按 result 判；完整 Job 证据
>   仍优先（含损坏 probe）；只降级修正，已应用 044 的库兼容收口。legacyProtectionUpgrade
>   **8/8**（44→最新含文件库重开同判；40→最新矩阵+corruptprobe1）。
> - **DM 返工目标固定（review-r44 §3 探针反例）**：打开意见框时捕获**会话身份+task/
>   delivery/revision/hash 快照**（旧残留输入框移除重建）；确认只审该快照——同会话刷新换
>   目标不换稿；期间版本更新由后端 STALE_REVISION 拒（UI 标注快照版本）；**跨会话切换明确
>   作废+零提交**。dmReviewContract 重写为五段真实 fake 链（常规/定位漂移诱饵/输入期间版本
>   更新→第 4 版零误审/跨 DM 作废零提交/accept 快照语义；全链审计 3 次正式记录）。
> - **材料纠正（review-r44 §4）**：dirty 对应计数更正（ab89219=21M+4A；二进制 docx/pdf
>   **8 件**全 M、文本 **17=13M+4A**；已证=**13 个修改文本文件** diff 逐字节一致；4 新增
>   构建时未跟踪无 diff 字节可比）+「不能完全重建」取代「差异仅可来自…」（appendix/
>   continuation r44 快照/review-r44 JSON 三处同步修订）；短回归指南 R6 删「表格页显示
>   网格」（随包样本 3 页无表格页——工程测试覆盖，不在样本中要求）。
> - 全量 **852/852**（105 文件；原始日志按 runId 留存 dist/desktop/r45-test-logs/
>   r45-20261004155706/full-suite.log）；typecheck 干净；零新增真实模型调用；**Android 期间
>   v6 应用/数据/证书/
>   既有结果稳定不动**；价值评价/DEV-11/并行写入维持原约定；**G5 按正式集成与兼容矩阵验收
>   （当前不宣布）**。

## 上一轮快照（2026-10-04 第四十四轮）

> 本轮=**review-r43 三条确定性工程边界+共用 review 合同+材料收尾**（review-r43-next-round-20261004.md），
> 用户同步以 v6 补测 R6/R7/V1/V2——**正在验收的 v6、数据与结果原件全程不动**，全部修复在源码
> 与独立目录完成；无新包（用户回填后集中处理实际失败再定最终候选）。
> - **迁移 044（review-r43 §3 纯函数反例）**：043 的 managedEvidence 只查「非空对象」、reason
>   兜底可覆盖已有相反 probe——空对象/数组/releasable:false/activeCount>0/null/缺字段/缺
>   managedJobId 的残缺证据都曾判 released。044 按真实 ReleaseEvidence 结构校验完整条件
>   （releasable/rootExited/handlesReleased 全 true+activeCount 数值 0+同事件 managedJobId 稳定
>   身份）；完整 Job 证据优先于落后的进程观察（probe alive 不否决）；**probe 存在时按 probe
>   判定，reason 兜底仅限旧事件缺 probe 字段**。043 已随 v6 发布冻结不改写——044 只降级修正
>   （V2 released ⊆ 043 released），不动 retained/NULL/预算/审计；幂等。legacyProtectionUpgrade
>   **6/6**（40→最新[+badmev/reasonover 两形态]/41→最新/42→最新/43→最新[已应用 043 的库兼容
>   修复+文件库重开同判]/043 纯函数/044 纯函数全分支）。
> - **DM 返工合同（review-r43 §4）**：dm-review-reject 确认分支补 manifestHash（此前漏传→
>   VALIDATION_INVALID）且改绑**用户所见快照**（currentReview 优先——待我处理定位时 pendingReview
>   可能指向另一交付）。调用方盘点：线程 reviewTask（accept/reject 共用，已带 hash）✓、DM
>   accept ✓、远程两处 accept ✓——唯一缺口即 DM reject，已修。新增
>   tests/integration/dmReviewContract.test.ts：**原样抽取产品 accept/reject 处理器**（与 r43
>   探针同锚点法——改源码即改测试对象）×真实 fake 链（message.submit→DispatchWorker→交付
>   pending→task.review）——返工带 hash/任务回 ACTIVE/意见入账/快照绑定诱饵不误审/旧版本与
>   错 hash 各返回 STALE_REVISION/redispatch 后第 2、3 版交付→accept DONE。
> - **显式工具入口（review-r43 §5）**：DM 视图下点看板/Files/动态曾被
>   `main[data-view=dm]>#board/#files/#activity{display:none!important}` 架空（handler 清
>   hidden 但 data-view 仍 dm）。统一视图状态：showToolPanel/hideToolPanel/resetToolPanels 唯一
>   维护三个布尔守卫+hidden 类+data-view；私信/线程视图下显式打开工具=暂离该视图（data-view
>   切 pool 侧），关闭返回原视图——**会话/线程身份、草稿、导航代次全程不动**；openDm/
>   showPool/openThread 入口一律归零（含修正此前「线程下开看板双区并显」的隐性不同步）。
>   verify-ui-hidden-layout 新增 **U6**：DM→看板显式可见（computed display≠none+尺寸+内容
>   渲染+DM 让位）→看板↔Files↔动态互斥切换→关闭返回 DM（视图身份+dm-input 草稿保留）→
>   侧栏切房工具归零——**P0-U6 七场景 allPass**（桩补 board.view/files.view/activity.list
>   最小数据）；lifecycle/word-isolation allPass 不回退。
> - **材料口径（review-r43 §6）**：打包模板 SHORT_REGRESSION/README 尾部改**四项**（R1—R5
>   沿用 v5 不重测、D1—D10 按 v2 收案）——随下一候选包生效，v6 包内 README 不动（指南已
>   四项化）；指南+模板补 **resize 手柄在面板右下角**（非任意下缘）与 **V2 收尾恢复 LAN**
>   步骤；尺寸口径统一**宽×高、最大高度与实际高度分记**（本轮起报告与 metrics 均按此，
>   R43 快照中「949×1680」已更正为宽×高=1680×949）。
> - **构建 dirty 对应（review-r43 §6；计数与措辞按 review-r44 §4 于第四十五轮修订）**：v6
>   BUILD.json 真实元数据（commit=8f49f5c、dirty=true、dirtyDiffHash=4fa3b1b0…）**原值保留
>   不改写**。只读重建核对（dist/desktop/review-r44/build-dirty-correspondence.json）：
>   ab89219 变更集=25（21 M+4 A；二进制 docx/pdf 8 件全为 M、文本 17=13 M+4 A）；重放脏路径
>   集 25=25（21 ' M'+4 '??'）；**13 个修改文本文件** diff 逐字节一致（cmp 首差异恰在二进制
>   fixture 段起点）；4 个新增文本文件构建时未跟踪（仅 ?? 行，无 diff 字节可比）。dirtyDiffHash
>   完整成分**不能完全重建**（构建时 diff/status 字节未留存；二进制 fixture 检出转换不可逆推）
>   ——「全部文本逐字节一致/差异仅来自二进制」不作已证结论；同源性另有 renderer 三源逐字节+
>   冻结清单 588/588+三连 buildId 佐证。
> - 全量 **850/850**（105 文件；原始日志按 runId 留存 dist/desktop/r44-test-logs/r44-20261004144908/
>   full-suite.log）；typecheck 干净；零新增真实模型调用；v5/v6 包与既有证据原地保留；
>   价值评价/DEV-11/并行写入/G5 维持原约定；**旧库兼容与正常操作合同收口前不宣 G5**。

## 上一轮快照（2026-10-04 第四十三轮）

> 本轮=**v5 用户回填收案+四类现场缺陷修复**（review-r42-next-round-20261004.md）：统一隐藏
> 契约（UI-01）·阅读空间与预览展开（UI-02/03）·监听显示（UI-04）+迁移 043 保守化+种子房间
> 绑定+首启自动装载。交付 **v6 独立候选包**；用户只补测 R6/R7+相邻视图切换+监听显示，随后
> Android。v5 包与其 RESULTS/截图=正式回填记录，原地保留。
> - **用户结果收案（不再等待）**：R1/R2/R4 用户确认 PASS；R3 重启自动恢复 PASS（私信被挤
>   细条的布局缺陷另列=UI-02）；R5 按已观察范围 PASS（监听选择框与运行事实不同步另列=UI-04）；
>   **R6 FAIL**（关闭预览无反应——原包 CSS 反例：.pool/.composer/.attach-preview 加 hidden 后
>   仍 flex/block 占位）；**R7 BLOCKED**（Word 内容已呈现但区域过小——max-height 300/320px
>   嵌套滚动）。原件=v5 包 RESULTS/SHORT-REGRESSION.md+shots/（Codex 按授权代整理，未改模板）。
> - **UI-01 隐藏契约**：style.css 全局 `.hidden{display:none!important}`（此前仅 .thread/.gate/
>   #stop-btn/.resume-info/.send-error 有局部规则）；JS 侧资源释放/代次保护不变。
> - **UI-02/03 阅读空间**：main[data-view=dm] 收起主池输入区（DM 自带输入行）+仓库/Git/看板/
>   Files/Activity（偏好开关不动，返回恢复）；.main.preview-open 预览打开时收起仓库/Git 行；
>   预览面板默认 max-height min(56vh,600px)+resize:vertical+「⤢ 展开预览」expanded 档
>   （min(82vh,1000px)，docx/pptx 视觉区 calc(82vh-210px)）；打开分支统一 showAttachPreviewPanel
>   （面板+工具条同显+preview-open）。
> - **UI-04**：监听编辑控件与已应用配置分离——刷新同步已应用值（运行事实），dirty 编辑不被
>   覆盖并标注「检测到未应用的编辑」；说明行新增「已应用配置：监听 …」。
> - **P0 首启自动装载**：renderer 服务端记忆回退由单次读取改**有界轮询**（60×1s，欢迎页不
>   阻塞、用户手动打开即停）——种子启动后才写记忆的窗口不再造成首启空白；启动器自测
>   assertAppFacts **删除 location.reload()**，首启可见/房间可见改为硬断言（reload 替代首启
>   成功的口径废止）。
> - **迁移 043（review §4 纯函数反例）**：保守分类 classifyProtectionFactStrict——同体矛盾
>   （released:true+protectionRetained:true）→retained；released:true 但证据不足（probe alive/
>   unknown/identity-missing/exited、缺 probe）→retained（**审计曾写释放≠当前合同的完整退出
>   证明**；reconciled executed+exitFact=exited 同不追认）；可信正例不误拦=managedEvidence
>   受管 Job 完整结束/probe no-os-process（旧版缺 probe 字段时按服务端 reason 串）。**已应用
>   042 的库**由 043 只降级 released→retained 修正（不动 retained/NULL/预算/审计；幂等）。
>   legacyProtectionUpgrade 4/4（40→最新矩阵+41→最新复现收口+42→最新降级修正+纯函数 22 分支）。
> - **种子房间绑定**：seed 显式选「默认房间」（找不到=失败不 fallback items[0]——v5 实际落
>   Lab Room 的顺序漂移），房间/线程/附件身份写 seed.json（rg.pptRoom/pptThread）；指南改
>   真实入口（默认房间→打开回复串→根消息📎芯片）。远程浏览器 openThread 补**根消息卡+
>   rootAttachments 只读芯片**（此前只渲染 replies——读取呈现缺口；不扩为远程视觉预览）。
> - **页面级验证**：新 verify-ui-hidden-layout.cjs（实际打包页面+传输桩——DOM/CSS/控制流全
>   真实；**computedStyle+尺寸断言**，1280×800+1920×1080 双档）P0 首启轮询装载/U1 隐藏契约
>   （pool/composer hidden 后 0 尺寸、DM 消息区≥55% 主高、返回恢复）/U2 关闭真正消失+工具行
>   让位恢复/U3 Word·PPT 展开实测（docx 视觉盒实际高度 353→448px；面板展开 maxHeight≈658px、
>   实际 h≈595px；resize vertical）/U4 监听
>   同步+dirty/U5 宽屏（DM 消息区宽×高=1680×949）——连续两次 allPass。lifecycle/word-isolation
>   allPass 不回退。冻结验证器 ATT 新增 4 项 R43 断言（展开/关闭计算样式/视图切换/监听）。
> - **v6 交付**：冻结三连（runId 见 vdr-runs 新记录）+同源核对+真实启动器自测（首启不 reload
>   断言）；包含 042+043、R7 样本、NOTICE 三件、README 修复、材料修订。**用户操作：对 v6 只
>   补测 R6/R7+相邻视图切换+监听显示**（R1—R5 按 v5 范围保留）；通过后 Android；不重复 D1—D10。
> - 全量 847/847（原始日志按 runId 留存 dist/desktop/r43-test-logs/）；typecheck 干净；零新增
>   真实模型调用；价值评价/DEV-11/并行写入/G5 维持原约定。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。

## 上一轮快照（2026-10-04 第四十二轮）

> 本轮=**review-r41 三块收口**（review-r41-next-round-20261004.md）：旧库升级 P1（迁移 042
> 回填）+Word 验证支架负对照补强+操作材料与真实入口对齐。**v5 包/server-data/RESULTS/截图
> 全部冻结不动**（用户以 v5 全新演练数据做 R1—R7）；工程修复全部在源码与独立目录完成，随
> **下一候选包（v6，待用户回填后决定）**交付。PPT A+Word/B 不集成的决定不变。
> - **P1 旧库升级回填（迁移 042 turn-protection-state-backfill）**：041 只加列不回填——旧库
>   已明确「保护保留」的 FAILED/refunded 无租约 turn 升级后 protection_state=NULL→呈现可恢复、
>   redispatch 放行、releaseProtection 无租约 no-op（复核反例已复现）。042 按
>   recovery.reconciled/recovery.protectionReleased **事件顺序（seq）**继承 retained/released：
>   只回填 NULL 行（041+ 正式写入的权威状态不改写）；keepUnknown 不产生事实；证据损坏/字段
>   缺失/矛盾→retained（不默认安全）；no-os-process/历史 exited（≤第八轮旧全释放路径，忠实
>   继承）/protectionReleased(released:true)→released；曾释放→更晚保留=按最新事实。不清预算、
>   不删数据、不改审计。**tests/integration/legacyProtectionUpgrade.test.ts 3/3**：40→最新
>   （文件库，七形态矩阵：保留/可靠释放/普通失败/executed 保留/keepUnknown/顺序反例/损坏——
>   呈现+守卫+恢复中心+无证据解除拒+none 解除后恰一次恢复+数据预算审计逐字节不变+幂等+重开
>   同判）+41→最新（先**复现漏洞**（redispatch enqueued=true）再同 row 收口）+分类纯函数
>   12 分支。既有 dev25FieldFixes 6/6+budgetGrantAccounting 3/3 不受影响。
> - **P2 Word 验证支架重写（verify-word-isolation.cjs，连续两次 allPass）**：W1 哨兵=实际泄漏
>   目标 `#host-sentinel>span`+**旧非隔离实现负对照必须变红**（rgb(255,0,0) 实测——旧支架
>   id=sentinel 裸按钮=假覆盖已修）+合法样式（zsred）shadow 内 **getComputedStyle 实测**变红；
>   W2 **真实 altChunk**（aFChunk 关系+包内 HTML 部件）：开启对照产生 iframe+srcdoc 含载荷
>   （消费证明）→产品 renderAltChunks:false 零 iframe+**产品 UI 如实标注**（app.js 新增
>   「嵌入 HTML（altChunks）首版不支持」用户可见说明行）；W3 **完整 wp:inline/pic:pic 结构**
>   +内嵌正对照（naturalWidth 320 实测=结构被消费）+外链**无拦截对照窗口**实测：组件把关系
>   目标按**包内路径**解析→不形成网络 URL（可达计数器零命中；缺件产生 src="null" 同源伪影
>   如实记录）；产品镜像窗口零命中+会话拦截兜底。W4 页眉文本实测（3 页眉含样本标记）+图片
>   naturalWidth 实测。metrics=dist/desktop/word-isolation/metrics.json。
> - **操作材料对齐（§5）**：指南/README 模板统一 **v5+七项**；R7 改真实入口「📎附件→选择
>   文件→点击芯片」（产品无拖放上传——wireAttach 只接 fileInput.onchange）；项目名=「DEV25
>   双机验收」；PPT=默认房间**已发仅记录消息**的附件芯片（非发送框）；README 防火墙路径
>   （v5 内被模板转义打成多行坏路径——成因 `\r`/`\n` 转义）模板修复+**生成后字节断言**；
>   R7 无隐私样本入库 scripts/dev25-dual/samples/word-r7-sample.docx（sha256 d66f6248…，W4
>   验证）随下一包；NOTICE 相对引用三件源材料（mtx-decompressor MPL-2.0/ECMA copyright
>   notice/ooxml source-manifest）自**同一钉版 tarball**（入口 sha256 与 PROVENANCE 核对一致
>   后）vendor 入库+逐件 sha256 记录（PROVENANCE.noticesMaterial）+随包 licenses-preview-
>   vendor/pptx-renderer-notices/。**更新说明=dev25-r42-materials-addendum.md（独立提供，
>   不覆盖任何用户回填；不要求重新导入 CA 或重复已完成手测）**。
> - **用户操作**：按更新后指南+补充说明对 **v5（全新演练数据）做 R1—R7**；通过后 Android
>   （记录系统/浏览器版本、包身份、物理 LAN 地址）；不重复 D1—D10；**旧项目数据不迁入演练包**。
> - **下一步（用户回填后）**：集中处理实际失败→决定下一候选包 v6（承载 042 迁移+材料修订+
>   R7 样本+NOTICE 三件+README 修复）→冻结三连+自测后交付。
> - 零新增真实模型调用；旧批次/通知/D1—D10 证据保留；价值评价/DEV-11/并行写入/G5 维持原
>   约定；旧库升级/Android/G5 各自按实际范围收案（不连带宣称）。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。

## 上一轮快照（2026-10-03 第四十一轮）

> 本轮=**第四十轮复核三缺口修复**（review-r40-next-round-20261003.md）：恢复保护独立持久化+
> 预览生命周期统一收拢+Word CSS 隔离（Shadow DOM）。预览选型已裁决并落地：**PPT=pptx-renderer
> 1.3.0（vendored 入库）+Word=docx-preview 0.4.1；B（libreoffice-kit）首版不集成/不下载**；
> Excel/PDF/Mammoth/模型输入链保持原合同。
> - **P1 保护状态独立持久化（迁移 041 agent_turns.protection_state）**：无租约的 notStarted
>   人工退款（FAILED/refunded+protectionRetained）不再凭「无 UNKNOWN+无租约」推导放行——
>   retained 一律拦（呈现/守卫/准入同源）；releaseProtection 无租约不再 no-op 冒充闭环（须
>   服务端证据，无登记=identity-missing 拒）；恢复中心 pendingRelease 改 protection_state 驱动
>   +无租约保留项独立行；跨重启同判。无租约反例链 6/6（拦/零 outbox/恢复中心可见/无证据解除
>   被拒/none 证据解除后恰一次恢复/文件库重开仍拦）。
> - **P2 预览生命周期（产品函数级）**：previewAttachment 入口统一 releaseActivePreviewResources
>   （abort+dispose——旧 viewer 不被新轮指针覆盖后遗失）；迟到首屏/最终 DOM 提交前代次门
>   （迟到轮只清理自身不动新轮指针/面板）。verify-preview-lifecycle.cjs（原样抽取产品函数+
>   受控延迟）S1 迟到首屏不覆盖 B/S2 打开中关闭不复活/S3 失败降级+指针空——allPass。
> - **P2 Word 隔离**：docx-preview 渲染进 **Shadow DOM**（真正 CSS 边界——复核 styleId 含逗号
>   选择器可命中预览外控件的反例收口）+显式 **renderAltChunks:false**（嵌入 HTML 首版不支持，
>   不建无 sandbox iframe）。verify-word-isolation.cjs：哨兵色不变/W1-W4 allPass（含 Word 外部
>   资源可达计数器零命中——不以 PPT 计数器泛化；word-rich 三节/表/图正例）。
> - **冻结口径（review §5 更正）**：bld_a1fcfa390ddeec46 的 156×3 中 lo0vku/p1hq4y 为旧断言
>   通过、gv7hdx 为修订后通过、an7ju9 失败留档——**不是最终验证器下连续三连**。本轮修复后
>   以最终验证器在同一冻结产物重新取得连续三次完整通过（见 vdr-runs 新记录）。
> - **v4 包事实**：增量 2.074MiB（588 文件字节总量差，vendor 五文件 2.053MiB）；启动器+种子
>   幂等自测通过（二启 newMessages=0——room.pool strictObject 参数+正文标记修复）。**下一包=v5
>   独立修复包**（含许可材料随包），不覆盖 v2/v3/v4 与任何用户回填。
> - **用户操作**：v5 就绪后仅做 R1—R6 受影响项短回归（正常预置 PPT 视觉失败≠R6 通过——
>   降级呈现另列），随后 Android；**不重复 v2 D1—D10（已收案）**。
> - 零新增真实模型调用；价值评价/DEV-11/并行写入/G5 维持原约定（未开放/未宣布）。
> 历史快照（第三十八轮起）见下文各节；工程坑与旧轮细节以各轮快照为准。
## 上一轮快照（2026-10-03 第三十八轮）

> 本轮=**D1—D10 收案（v2 范围通过）+现场八缺陷修复+PPT 缺口收口+v3 修复包**。
> 收案记录=docs/implementation/dev25-dual-acceptance-record-20261003.md（D7 支持事件与
> 「编码阶段零改动」分列——server-data 曾被正式命令修改；Android/缺陷关闭/G5 分别登记不连带）。
> - **现场修复（dev25FieldFixes 3/3+页面级）**：#2 防护拒绑真实 runtime（CAPABILITY_UNSUPPORTED
>   正式错误）+设置 UI 防护包 fake 正路径（member.runtime 带 environment 标志——正式部署不出现
>   该选项）；「审计缺事件」结论不实——turn.startupFailed 本就落库，缺口在呈现（三面上屏）；
>   #7 interrupted 呈现+「恢复执行」=task.redispatch 正式重派链（幂等/不复活已停止——反例全过）；
>   #1/#8 深链跨项目判定改 projectId（原路径字符串比较=二次 loadProject 候选根因）+渲染代次守卫
>   +同项目空结果保留旧列表+审计环 window.__zsNavAudit+启动有界重试+重连补载；
>   #3/#5/#6 远程继续队列+反馈+房间 DIRECT 指派（**mentions 合同={kind:'member',memberId}**——
>   裸 displayName 被 zod 拒）+会话标题区分；#4 statusReason 人话（board.view+mine.pending）；
>   可用性=侧栏可滚+设备列表限高+LAN 虚拟网卡段标注（198.18/169.254/100.64）不推荐+
>   selfcheck pkgRoot 修正+CA 指纹。
> - **PPT（pptxPages 9/9）**：重活进 parsePool（kind='pptx-pages'+outPath 文件——IPC 4MB 上限；
>   **worker 源码指纹已含 pptxPages/zipGuard**）；缓存命中先核原件（篡改副本→命中路径拒绝——
>   反例过）；写回前重读 artifact；五缺陷修+SVG 白名单 svgWellFormed+schema 2（旧缓存全废）；
>   页面深检：首页内容/坐标/图片内联、翻页换内容+实体解码、缩放 width 实变、图表页降级标注、
>   关闭后在途构建不复活、缓存命中复用。
> - **工程坑（四连中止教训）**：①`(await rs(...).includes(X))` 的 await 组把 .includes 一起包住
>   →落在 Promise 上——TypeError 文本会剥 await/括号，按括号计数脚本定位；②多段 python replace
>   一处 assert 失败=整脚本不写盘（前面替换全回滚）；③heredoc 反斜杠折叠——String.fromCharCode(92)
>   构造（JS 模板字面量内单反斜杠=
/ 转义）；④构造中断形态的 agent_turns.member_id 有 FK——
>   假成员使整事务回滚（execSql 要 throw 不吞）；⑤closeAttachPreview 只隐藏不清内容——「重开」
>   断言须等重新可见+新内容标志；⑥ZS_VDR_SESSIONS 缺省只 A–D，全量=12 会话。
> - **数字**：dev25FieldFixes 3/3；pptxPages 9/9；本地全量 **839/839**；冻结基线
>   **bld_f4d26d38592bb521——154×3 全绿**（7opdi7/vrd0jb/lpngj8，REMOTE=28/轮+4 新记录；
>   中止如实保留：bwxt1y=CDP 表达式瞬态/1lyo7m=停止点击零到达偶发（第三十五/三十七轮已知
>   稀疏渲染窗）/m3j81g=HARNESS·D1 时序；旧产物 bld_6ca139d08a85bd7a 双绿后因 remoteClient
>   mentions 合同修复重建）；零真实调用。**v3 包=dist/desktop/dev25-dual-win-v3**（README 已并入
>   第三十七轮补充说明更正：防火墙=daemon node.exe/监听两选项+LAN 列表选址/配对码时机/
>   ca.cer 文件哈希核对法；v2/server-data/RESULTS/截图原地保留）。
> - **下一步**：①用户受影响项短回归（继续队列/中断恢复/侧栏恢复/防护拒绑提示/设备列表可达/
>   PPT 页面行为）——不重复 D1—D10；②Android 实测按指南（适配≠实测）；③其余评论锚点 FULL-03
>   后批；④DEV-25/G5 发布结论待用户短回归+Android 后再出。

## 当前真实状态（2026-10-02 第三十七轮，唯一权威快照）

> 本轮=**验收版本保持稳定+操作补充/Android 指南+PPT 静态页预览**。v2 包（dev25-dual-win-v2，
> bld_4d7928368c7da46f）用户双机人工验收进行中——**不动该包/server-data/RESULTS**；回填后
> 工程侧只读核对（未执行/失败/未确认分记，不代宣称通过）。上一轮快照（第三十六轮）紧随其后。
> - **操作补充（dev25-dual-v2-addendum.md，不重建验收包）**：防火墙监听程序=
>   ZhongshuoDual/resources/app/daemon/node/node.exe（**daemon 监听 HTTPS——不是 electron.exe**）；
>   UI 仅「仅本机/局域网 0.0.0.0」两选项（无填具体 IP 入口）——多网卡从面板 **LAN 地址列表**选
>   实际地址+端口；**CA 核对=ca.cer 文件 SHA-256**（`Get-FileHash -Algorithm SHA256`）与面板
>   「信任根指纹」比较，服务证书指纹单独记录；**信任完成后再生成新配对码**（避免 5 分钟窗内
>   过期）；结果模板追加行（两枚指纹/防火墙规则/使用的 LAN 地址）——不覆盖已有回填。
> - **Android 指南（dev25-android-acceptance-guide.md）**：信任（设置→安全→加密与凭据→安装
>   证书→CA 证书，先逐位核对 CA 指纹）→配对（触摸/上传——图片门提示用文本类）→后台恢复
>   （切后台/锁屏 30—60s 回前台自动重连+检查点续传）→独立吊销（面板吊销手机设备→立即断流
>   终态横幅）；系统与浏览器版本记录模板必填；**「证书格式已适配」与「该 Android 组合已实测」
>   分开**——无任何 Android 实测记录前不记通过；私钥只留服务机/不用绕过开关；PWA/Push 后续。
> - **PPT 静态页预览（attachment.previewSlidesPages，src/daemon/pptxPages.ts）**：slide XML→
>   SVG **受控转换**——sldIdLst 真实页序（跳号正确）+当前页 SVG（形状 EMU→px/文本段落/图片
>   base64 内联/备注页脚）+缩放（SVG 矢量客户端）；**缓存绑定版本**（daemon_state 键
>   pages:slides:<artifactId>，值含 sourceHash——不符即弃；输入=readVerifiedBlob）；**与提取
>   文本分列**（previewOffice slides 通道不变）；预算（60 页/单页 SVG 220KB/图片 2MB+总量
>   6MB）超限 truncated 标注；版面近似如实（SmartArt/图表/主题样式不渲染）。UI 双通道+页导航
>   +缩放。pptxPages 4/4（含版本绑定重传/缺图占位/超页数拒绝）。
> - **工程坑**：①**zipGuard 迁出**——parseWorker 尾部 `process.on('message')+process.exit`
>   入口曾被 commands.ts import 带入主进程（vitest 1538 个 unhandled「process.exit unexpectedly
>   called」+全量 OOM）——safeUnzip 独立成 zipGuard.ts（参数化上限），worker 侧
>   safeUnzipWith(常量)+**ZipGuardError code 透传映射**（parseLifecycle 炸弹用例核对 code——
>   曾退化成 parse-worker-error）；②小盒子文本「装不下即跳过」是受控转换的真实行为——测试
>   样本盒子要够大（10px 盒子文本被截断是如实语义）；③停止点击循环加**零到达守卫**（audit 零
>   task.stop 立即失败留现场——不再空转 95s 等自然完成的假阴性）。
> - **数字**：pptxPages **4/4**；本地全量 **831/831**；冻结三连 **142/142×3**（bld_ad0857541002b79c：
>   created b2luaj+reused 4eovnu/xtpr0x；vcjtsv/0oyein 中止如实保留——旧 ATT 断言过时+停止
>   点击零到达偶发）；零真实调用。
> - **下一步**：①用户 D1—D10 回填→工程侧只读核对；②Android 实测（指南就绪）；③其余评论
>   锚点按 FULL-03 后批；④DEV-25/G5 发布结论待双机人工验收通过后再出。

## 验收支持事件（2026-10-02 深夜 D7，插记于第三十七轮快照后）

> 用户 D7 验收中「任务一直不完成」连续受阻，工程侧只读诊断定位+最小现场恢复。**D7 用户回填
> 通过；real_calls=0**。全量缺陷报告=**docs/implementation/dev25-acceptance-defects-20261003.md**
> （8+2 项：主根因=成员被绑定 claude 后真实派发防护静默拒绝；远程无「继续队列」入口；桌面侧栏
> 列表闪现被清空——根因未定位需 ZS_DEV25_DEBUG_PORT 取证；BLOCKED/失败无解释；继续成功无反馈；
> 侧栏不显示会话标题；停机中断任务永久卡 ACTIVE；启动恢复不重试）。
> - **现场已执行（走正式命令面，回执留 v2 包 RESULTS/）**：`member.setRuntime kind=fake`×2
>   （Guide A/B 原绑定 ri_claude_89ade9281c/deepseek-flash——用户在设置中自绑，防护拒绝所有派发
>   即「不完成」主因）；`dm.resume`×3（DM A 队列解锁重泵——「测试」SUCCEEDED、「测试A」FAILED
>   于绑定恢复前；DM B 无待泵）。**v2 包 server-data 已被修改（绑定+队列状态），续后回填核对
>   需以此为基线**；诊断脚本留 RESULTS/（diag-dm-state/diag-sidebar 只读；diag-resume-dma/
>   assist-fix-runtime 含上述写操作）。
> - **用户侧要点**：房间任务=远程页固定空 mentions→AUTO→M0 门禁 BLOCKED（预期，D 系操作走私信）；
>   每任务 60s 停滞窗（ZS_FAKE_STALL_MS）内勿点停止；D7 关的是**客户端浏览器**（关服务端窗口=
>   daemon 停机，任务 INTERRUPTED）。
> - **约束**：缺陷修复合入前双机包不重交；缺陷排期由评审 AI 依据报告裁定（矩阵已加指针）。

## 上一轮快照（2026-10-02 第三十六轮）

> 本轮=**真实双机验收入口受阻→修复+普通浏览器预检+v2 包重交**。D1—D10 未执行不记通过。
> 上一轮快照（第三十五轮）紧随其后。
> - **受阻登记**：docs/implementation/dev25-access-entry-blocked.md（用户原始描述逐字保留+
>   开发机取证）。根因：旧证书生成 PowerShell New-SelfSignedCertificate 未传 -Subject——
>   实际证书 Subject/Issuer 均空+SAN 非 critical（RFC 5280：空 DN 时 SAN 必须 critical）——
>   普通 Chrome 证书查看/信任流程走不完。
> - **证书两层（remoteIdentity.ts 重写，node-forge 纯 JS）**：本地 CA（CN=Zhongshuo Remote
>   Access CA；CA:TRUE+keyCertSign critical；10 年）=用户导入的信任根（remote/ca.cer）；服务
>   证书（CN=zhongshuo-remote；CA 签发；SAN **critical** 覆盖 DNS:localhost+IP:127.0.0.1/::1/
>   实际 LAN IP——CN 不代替 IP SAN；EKU serverAuth；3 年）。**IP 变化只重签服务证书——CA
>   不变（信任一次）**。复用按实际 DER 核验：空 DN/过期/SAN 不覆盖/非本 CA 签发（X509.verify
>   CA 公钥验签）/证书私钥不配→重签重生成；旧文件入 remote/old-cert-diagnostics/<ts>/ 留
>   诊断证据（业务数据/RESULTS 不动）。私钥/CA 私钥只留服务机；程序不自动安装信任根。
>   **forge 三坑**：IP SAN 必须传二进制字节串（点分文本=畸形 SAN「invalid length=9」）；
>   authorityKeyIdentifier 会被误写为**自身 SKI**（openssl 按 AKI/SKI 配链即「unable to get
>   local issuer」——不设该扩展）；Node X509 把 IPv6 SAN 打印为全展开（canonicalIp 双侧归一）。
> - **分层核验（remoteServer+commands+UI）**：仅本机模式提示「其它设备无法连接」；LAN 启用后
>   remote.config.get 回**实际监听地址+服务证书指纹+CA 指纹+Subject/Issuer+lanSelfCheck**
>   （verifyLanBinding：服务机本机经实际 LAN IP 的 HTTPS 探测——通过=绑定/TLS 层健康；跨机
>   失败需客户端错误码再分层，不预判定性）。README：证书提示=信任层/ERR_CERT_COMMON_NAME_
>   INVALID=名称层/超时=网络层+防火墙**程序或端口+专用网络**精准步骤（不关整墙）。
> - **普通浏览器预检（scripts/dev25-browser-precheck.mjs）**：系统 Edge 无任何证书绕过开关
>   （CDP 附着只读）。Phase A 未授信=net::ERR_CERT_AUTHORITY_INVALID 拦截（区别结构无效——
>   openssl 验链+Subject/SAN 核验先行）；Phase B 工程侧临时装 CA 至 CurrentUser Root
>   （thumbprint=CA DER SHA-1 留痕）→HTTPS 页面加载+配对+WSS 事件流；Phase C 卸载→回拦截态
>   （证明通过确实来自该信任根）。**冻结产物上 8/8 PASS**（dev25-browser-precheck/
>   2026-10-021242/evidence.json）。原自动化回归（remoteAccess 36/36 等）保留，但其证书信任
>   覆盖范围（Node 显式 CA/SPKI 钉选壳）不再代表普通浏览器入口已通过。
> - **v2 包**：dev25-dual-win-v2（**独立版本目录**，不覆盖正在运行的旧包）；README 重写信任/
>   分层排查/防火墙步骤；自测实跑 .bat 全链（证据 dev25-dual-evidence/2026-10-021242-ejx5b5）。
>   坑：--out= 与 --self-test 参数顺序（argv.includes 解析）；新 Edge profile 自带扩展欢迎页
>   抢 CDP target（按 URL hint 选页面）。
> - **数字**：remoteIdentity **5/5**+remoteAccess **36/36**（REMOTE 24/24 回归）；本地全量
>   **827/827**；冻结三连 **142/142×3**（bld_4d7928368c7da46f：5wsc56/1hyhsk/niwrb0——
>   63ztvw 的 E18 跨项目线程单项竞态中止如实保留，等待加固后过）；v2 包逐文件 583/583+
>   selfTest 全链+预检 8/8。零真实调用。
> - **下一步**：①用户用 v2 包执行 D1—D10 并回填（工程侧只读核对）；②Windows+Android 双端
>   （资源已确认）；③DEV-24 最小项编码（提取文本类行评论）。

## 上一轮快照（2026-10-02 第三十五轮）

> 本轮=**两类遗漏收口+数字口径更正**：恢复链读取贯通/自检看板真异步+冻结重交。上一轮快照
> （第三十四轮）紧随其后。
> - **恢复链读取贯通（问题一）**：refreshTargets/refreshTasks 返回 {ok}——conversation.list/
>   board.view/room.list 任一失败上抛（UI 侧保留旧 targets/选项/卡片+顶部「读取失败」标注——
>   不清空、不冒充「暂无任务」；空态「暂无任务。」=成功响应确实无任务，三态分开）；loadMessages
>   包 try/catch→renderReadError+**rethrow**（room.pool 失败不再吞成空线程表）；runSnapshotRound
>   检查 targets/tasks/loadMessages 全链——任一 {ok:false}/throw→pending+原检查点；**恢复轮内
>   restoring=true 抑制 switchTarget 自动 loadMessages**（fire-and-forget 的 catch 曾吞失败并把
>   恢复链的显式 await 挤成第 3 次——计数错位实证）；**项目枚举=DM ∪ board.view(scope=all) 获准
>   项目**（纯读零派发——旧实现只从 DM 推导，房间-only 项目永远不可见）。
> - **自检看板真异步（问题二）**：selfcheckBaseline/finishSelfcheck 改 async+await dispatch
>   （旧实现同步读 Promise.data 恒 undefined→boardGroups=-1，前后 -1 相等被误判 PASS）；查询
>   失败/结构不符→boardGroups=null——**未取得数据不计通过**（detail 标注「看板查询失败/未覆盖」）；
>   反例：正常路径 detail=boardGroups=1->1（真实组数）；前置失败（dispatch 对 board.view 恒抛）
>   与结束失败（首调成功后抛）均 ok=false（1->null / null->null）且整体失败；dispatch 不 reject
>   （错误转结果对象）+try/catch——无未处理 rejection。
> - **验证器（REMOTE）**：failCmdNth(method, nth) 第 N 次命中（boot 放行、恢复链中招——
>   conversation.history/room.list 是 5s 轮询不碰的确定计数命令）；**每页单一 Fetch 守卫**
>   （再 arm 先拆旧监听器——旧监听器会对新目标请求抢先 continueRequest 的多轮竞态实证）；
>   双面判定（conversation.list 的 #1 可能被 5s 轮询的任务面抢走——错误呈现在 #tasks）。
> - **数字口径**：三冻结 report（0gk5lr/d1vbiu/u7jnz1）REMOTE 条目均 **23**——第三十四轮报告
>   写 24 系**报告数字错误**（独立开发运行同为 23 PASS；24 不存在任何统计范围）已更正；
>   本轮 REMOTE=**24**（+1「读取三态呈现」新记录；快照全口径扩四轮）。
> - **DEV-24 M3 盘点**（详见 remaining-matrix DEV-24 行）：已完成有证据=七类上传/解析/预览+
>   文本/代码/Markdown 评论锚点+安全预览/导出；未实现=图片附件级锚点（区域模型留 FULL-03
>   后批）/OCR（先方案）/PPTX 页图；**最小可交付项=提取文本类（pdf/docx/sheet/slides/csv）
>   行评论**——第三十六轮编码。
> - **数字**：remoteAccess **31/31**（+2：自检看板真异步/空态对照）；REMOTE **24/24**；本地全量
>   **822/822**；**冻结三连 142/142×3**：新基线 bld_12d1f5aeeff6a37e（created pnyar8 + reused
>   jjzix5/zd6ppj 各 583 文件核对；首次尝试 uz3rs8 在停止演练中止——TTL 断流下渲染稀疏，
>   48s 点击窗无可点行（审计零 task.stop）——停止循环改「先刷新再点+25 次」后通过，中止
>   记录保留）；**双机包=该冻结产物逐文件核对生成**（583/583+selfTest 实跑全链+证据归档
>   dev25-dual-evidence/2026-10-021005-wc0av5/）。零真实模型调用。
> - **下一步**：①用户双机 D1—D10 回填（工程侧只读核对）；②DEV-24 最小项编码（提取文本类行
>   评论）；③移动浏览器组合（R11 独立范围——手机资源确认后）。

## 上一轮快照（2026-10-02 第三十四轮）

> 本轮=**三问题收口+证据补强**：跨项目安全检查点/快照恢复去假成功/自检不动用户偏好+同请求
> 中途吊销与崩溃/自测证据归档+冻结重交。上一轮快照（第三十三轮）紧随其后。
> - **跨项目安全检查点（问题一）**：服务端按项目投递（projNext latch）+浏览器持久游标**一致**——
>   持久游标=各跟踪项目水位 **min**（localStorage zs-proj-seq 存每项目水位；zs-last-seq=检查点）。
>   根因复现：P2 1—301+P1 302、订阅序 P1→P2：首泵发 P1 302 再发 P2 前 300（单泵页 300），
>   旧客户端存全局 max=302，断线重连后 P2 的 301 永远补不到。min 检查点重连从检查点续，
>   检查点以下重投由 eventId 去重吸收；订阅时新项目水位初始化=连接基线（__connFromSeq）；
>   事件先记水位再去重。反例集：交错/超单泵页/半批断线/重连逐条核对——合并 (project,seq)
>   键集恰 302 条无漏，重投仅检查点以下（P1 302）。
> - **快照恢复去假成功（问题二）**：轮次模型（snapshotRound/snapshotChain）——后续 stale 开
>   新轮、同轮并发合流、旧轮/旧连接迟到结果不覆盖；refreshTargets/refreshTasks 失败**不吞**
>   →pending；subscribeAll 重写：只数 subscribed（cursor-stale≠订阅成功，作为 needRecovery
>   返回 staleFromSeq）、按项目去重（'ack:'+pid）、绑定发起连接（close/readyState 变化即失败）、
>   确认不全即失败；全部确认+连接未换+轮次未过时才 recovered 并把**各跟踪项目水位**推进到
>   已恢复范围（检查点不越过未恢复范围）；失败保留检查点+有界退避（≤10 次）。页面验收=
>   **CDP Fetch.failRequest 按 postData 定点断响应**（activity.list 首枪失败——确定性非时序，
>   其余请求放行）：pending 时 zs-last-seq 保持 0→退避重试成功（recovered ls=29 acks=1/1）→
>   **连续第二次 stale** 同样完整恢复（旧实现在 recovered 后 return 不处理）→每轮恢复后提交
>   新消息核对新的 WSS eventId 到达。恢复期间连接翻换（TTL 8s 自然 churn）由 wsAtStart+轮次
>   守卫吸收。
> - **自检不动用户偏好（问题三）**：根因=visibleProjectIdsOf 取 viewer **最新行**
>   （ORDER BY revision DESC LIMIT 1——不分 client_id）→空 visibleProjectIds 探针行使全项目
>   看板归零。探针改**独立测试对象** remote.pairing.selfcheckProbe：写 daemon_state 专用键
>   selfcheck:probe:<commandId>（REMOTE_BLOCKED_METHODS 封 HTTP 面——runSelfcheck 经进程内
>   dispatch 同一幂等网关+审计写入器调用），finally 清理临时键（审计行保留）；自检**任何退出
>   路径**（成功/失败/中断——finishSelfcheck 统一收口）登记不变性：导航偏好行集/全项目看板
>   组数（经 dispatch board.view）/已配对设备（自检一次性设备除外，原有设备 revokedAt 不变）/
>   在途 run 数。实测：成功+连续执行+停服失败路径均不变、probe 键零残留。
> - **交付证据（问题四）**：①同请求中途吊销反例——export.create 异步等待窗口
>   （writeExport 后/复核前，__zsTestExportHook）内吊销：提交前 run() 门禁拒绝
>   （ok:false DEVICE_REVOKED）+零回执+零新导出目录+拒绝留审计（区别于「吊销后再调用」）；
>   **stopFlow(requestStop)/gitWrite(journal) 自包 runCommand 路径补 commitGate**（异步命令
>   提交事务前同过远程门禁）。②created 轮（v20261002062722-1uolgd）REM 渲染进程中止证据归档
>   crash-evidence/：stderr 零输出/无 Crashpad dump/无 WER(1000/1001)/无资源事件(2004)/daemon
>   正常推进——**原因未能定位如实登记**；退出码未取得（验证器先于退出收账中止）已注明；
>   完整三轮均为 reused（口径保持）。③包 selfTest 证据清理前归档
>   dist/desktop/dev25-dual-evidence/<ts>/（launch1/2 原始启动输出+种子+停机事实+real_calls+
>   summary）。
> - **数字**：remoteAccess **29/29**（+3：跨项目检查点/自检不变性/中途吊销）；REMOTE **24/24**
>   （快照恢复改全口径记录）；本地全量 **820/820**；**冻结三连 141/141×3**：新基线
>   bld_19d8863a997c70af（created v20261002081030-0gk5lr 本次即完整通过 + reused d1vbiu/u7jnz1，
>   各 583 文件核对）；**双机包=该冻结产物逐文件核对生成**（583/583+selfTest 实跑全链+证据归档
>   dev25-dual-evidence/2026-10-020837-69k9b3/）。零真实模型调用。
> - **下一步**：①用户双机 D1—D10 回填（工程侧只读核对）；②等待人工期间可推进 DEV-24 M3
>   无依赖项（评论锚点按 FULL-03 分批、OCR/新视觉渠道先方案）；③移动浏览器组合（R11 独立
>   范围——手机资源确认后）。

## 上一轮快照（2026-10-02 第三十三轮）

> 本轮=**第三十二轮定位缺口全收口+冻结同源双机包重交**：设备级授权代次/共享命令门禁/WSS
> 限额与收拢实装/事件泵按项目游标/下载三修/自检去明文/浏览器信封与清算语义/双机包从最终
> 冻结产物逐文件核对重交。上一轮快照（第三十二轮）紧随其后。
> - **设备级授权代次（迁移 040 remote_devices.auth_epoch）**：invalidateDevice 只递增该设备
>   代次+撤销该设备 token/票据/活连接——**B 的现有 token/票据/WS 继续有效**（旧全局 authEpoch
>   吊销 A 后 B 也 401——多设备互相误伤，双设备正反例实证）。checkToken/票据消费/deviceLive
>   均按设备行核对 revoked_at+auth_epoch；**设备事实优先于 token 检查**（不被联动删除掩盖成
>   TOKEN_INVALID）。
> - **remoteGate 共享命令门禁**：RemoteCallContext={deviceId,deviceEpoch,gate}——dispatch 进入
>   时+**run() 业务提交前**（commands.ts 共享 run——覆盖全部写提交）重查设备/代次/会话；拒绝
>   返回 {ok:false,code:DEVICE_REVOKED} 且**留审计行**；「同上下文吊销后提交→零提交」反例。
>   吊销≠停止（已授权运行任务不受影响）。
> - **WSS 实装与收拢**：每地址未认证限额按**真实来源地址**（2/地址+全局 32——第三地址拒/关后
>   可再连/全局独立小值反例）；closeConn=发起关闭→宽限（3s 可调）terminate→核实后释放计数
>   （连接真正关闭前留在 conns——不「先移除再 close 当已退出」）；daemon.stop 有界等待收拢
>   后强杀清场（不回握客户端+stop 截止均有界完成）。
> - **事件泵按项目游标（projNext latch）**：SQL 直接 `WHERE project_id=? AND seq>?` 按订阅项目
>   过滤（每项目每泵 LIMIT 300）——**600 条未订阅 P1 不再阻塞已订阅 P2**（旧全局 LIMIT 500
>   先取再跳过=卡死）。迟订阅从 latch/authBase 续发；积压超 resumeWindow→按项目 cursor-stale
>   +水位跳当前（不无限重扫）；取消订阅即停；重连续传只补增量。authBase=认证时全局水位。
> - **下载三修**：①主文件 sha256 核验可达（旧实现 bytes 检查后 continue——同长度篡改正文可过，
>   现 410 EXPORT_TAMPERED）；②**单次受控读取**：同句柄读出字节先核验再直接进 ZIP（不再校验
>   后另 readFile——ZIP 字节恒为已验证字节）；③**资产额度与元文件分离**：额度=manifest.files
>   （≤200），index/manifest 不占——200 件资产+正文+清单=202 文件完整下载、201 件明确 413；
>   发送前重查下载权限。
> - **自检去明文（第六组合同）**：remote.pairing.selfcheckExport **废除**（曾把配对码明文写
>   daemon_state——违 R11）。新 remote.pairing.selfcheck 仅 **ZS_REMOTE_SELFCHECK=1 隔离验收
>   模式**开放（双机包启动器注入；正式产品=CAPABILITY_UNSUPPORTED）：remoteServer.runSelfcheck
>   **进程内**执行错码 401（核对配对行 fail_count 递增——证明命中真行）/伪造 Host 403/伪造
>   Origin 403/无 token 401/正码配对→session→同 commandId 恰一次（replayed=true）+
>   **remote_audit_log 本次设备/命令号/成败/重放事实核对**→自检设备吊销清理（后续 401）。
>   明文码只在进程内使用结束即失效；appData/selfcheck-latest.json 无任何凭据（正则核对）；
>   self-check.cjs 只导出结果+脱敏核对（无网络、无码）。
> - **浏览器客户端语义收口**：cmdOnce 区分**明确拒绝**（e.status!=null——信封即删，允许修正后
>   新 commandId 重发）与**结果未知**（响应丢失——信封保留沿原号重试恰一次）；存在未知信封时
>   发送键先收口原信封（不与新草稿暗中混用——新草稿保留）。**按实际提交信封清算**（settleDraft）：
>   正文被修改保留、只移除已发送 refs、B 的上传不受 A 清算影响（pending 按钮重试成功同清算）。
>   停止/验收操作键绑 run/停止代次/delivery/revision/manifestHash（旧失败不劫持新版本）。
>   **房间线程读取入口**：房间目标列线程（room.pool）→点击经 thread.history 正式命令读取→
>   线程内发送（target=thread）。**快照恢复闭环**：cursor-stale→activity.list→refreshTargets+
>   refreshTasks（同范围事实恢复）→saveLastSeq→**subscribeAll 等确认**→snapshot-recovered；
>   失败保留旧游标+pending 态+有界退避重试（≤10 次）——不冒充成功；connectEvents 取票失败也
>   持续有界退避（不只 onclose）。token 续换记 __tokenGen、成功 HTTP 记 __lastHttpOkAt（验收
>   核对新请求事实）。
> - **双机包重写（make-dev25-dual-package）**：**源=最终冻结产物 dist/desktop/vdr-frozen**，
>   拷贝后**逐文件重算 SHA256 对冻结 MANIFEST 核对**（含 daemon.cjs——第三十二轮交付包系陈旧
>   构建 bld_aeba86865045ebbf（daemon.cjs b7aa81dd）而冻结基线 bld_d96713369ac153d0
>   （060e27ef）——「同源冻结产物」声明不实，已纠正；核对事实写 RESULTS/frozen-manifest-check.
>   json）；**RESULTS 永不重建删除**（build 只重建 ZhongshuoDual/seed/selfcheck；模板只在缺失
>   时写；自测含回填保护反例）；启动器管道名按数据根（server-data/pipe-name.txt 首启随机持久
>   ——两份包互不撞）；ZS_REMOTE_SELFCHECK=1 内置；自测钩子 ZS_DEV25_DEBUG_PORT/ZS_DEV25_DRILL
>   仅自测注入。**selfTest 实跑交付 .bat**（清父环境全部 ZS_*+中文空格路径）：窗口打开（CDP）/
>   合成项目经 ui.autoOpenProjectPath 自动打开链 reload 可见/模拟模式 runtime.status=fake 明确/
>   种子+**停止演练**（--drill 真发任务→轮询执行态→task.stop→run 收口）/优雅停机 Browser.close
>   正式关窗链（requestDelivered+exitCode0+complete+非forced+无残留——taskkill 不参与成功路径）/
>   real_calls 子进程成功+stdout 整数结构核验（空不当 0）/**二次启动幂等**（reused 标记+种子私信
>   恰 2+零新 message.submit）。seed-client 幂等（revision 取 project.open 当前行——不固定 0；
>   房间/私信按名查重；附件+种子消息仅首启；认证前 close 立即 reject；写 ui.autoOpenProjectPath）。
> - **验证器坑（本轮四次迭代实证）**：①evalJs 返回 **{value} 包装**——布尔比较必须取 .value
>   （包装对象恒!==true：点击已成功却判失败）；②验收等待只认 DM「待验收交付」行——房间任务
>   看板卡验收按钮会提前满足 ANY 断言；③停止循环在途口径必须含 WAITING/QUEUED/STOPPING——
>   run 排队（同成员前一 turn 未完）时只数 RUNNING 会**未点击先 break**（audit 零 task.stop 为
>   证）；④房间宿主任务要与 DM A 错开成员（同成员串行拖结算）；⑤停止终态等待要覆盖整个 60s
>   停滞窗（停滞脚本被中断不推进——结算等完剩余窗）；⑥任务区 5s 轮询清空重挂窗口内点击会
>   落空（点击自带短重试+每试刷新）。
> - **数字**：remoteAccess **26/26**（+7：设备级代次双设备/每地址限额/有界收拢/泵模型 600 条/
>   主文件同长度篡改+200·201 边界/提交前门禁/进程内自检）；REMOTE 会话 **23/23**（+3 新记录：
>   按实际信封清算·等待期编辑保留/门禁明确拒绝→修正重发·旧稿零提交/房间线程读取入口；快照
>   恢复改「订阅重建确认+新事件经 WSS 到达」、token 续换改 __tokenGen/__lastHttpOkAt 事实）；
>   本地全量 **817/817**（githubSandbox 同次 5/5）；**冻结三连 141/141×3**：新基线
>   bld_412ace063c00ca39（created v20261002062722-1uolgd 轮 REM 渲染进程偶发崩溃中止——
>   如实保留；完整三连 v20261002062951-61bdlm / v20261002063838-hl99h4 / v20261002064717-
>   0vxmjj，各 583 文件核对）；**双机包 dev25-dual-win=冻结产物逐文件核对生成**（583/583+
>   RESULTS 保护反例+selfTest 实跑 .bat 全链通过）。零真实模型调用。
> - **下一步**：①用户按 README 执行双机 D1—D10 并回填 RESULTS/RESULT-template.md（工程侧只读
>   核对——不代宣称通过）；②移动浏览器组合（R11 独立验收范围——手机资源另行确认）；③DEV-24
>   M3 缺口推进（图片/PDF/Office 评论锚点按 FULL-03 分批、OCR/新视觉渠道先方案）。

## 上一轮快照（2026-10-02 第三十二轮）

> 本轮=**DEV-25 收口**：认证与权限补齐（重复码/审计穿透/直查漏口/异步期吊销重查）→WSS 换
> 成熟库补完整合同→浏览器页可操作闭环（20 项页面验收）→设置面纠正→**双机包交付**。
> 上一轮快照（第三十一轮）紧随其后。
> - **认证与权限**：createPairingCode 近期重复检查修复（**用历史行自己的 salt 核验候选码**——
>   旧实现拿新 salt 的 digest 与历史比较，同明文也永不相等，形同虚设；实测 AUDITCODE8 两发
>   复现+修复反例）；迁移 039 remote_audit_log——dispatchDaemonCommand 包装层写审计
>   （remoteAudit={deviceId,authEpoch} 由 remoteServer 服务端构造注入；失败也记；重放记一行
>   不重复执行业务）；events.list（补 conversation_id 列）+task.get/task.stop 按 ID 直查
>   audience 修复（assertTaskAudience——他人 DM 任务拒读拒停）；/cmd 大体（2MB）读取期间
>   吊销→派发前重查 401（读取窗口不放过；吊销≠停止——消息零提交）。
> - **WSS（ws 8.22 成熟库承接握手/帧；应用层合同自持）**：票据完整绑定（device+**origin
>   消费比对**（合法 A 签发→合法 B 使用拒——不能只测白名单外）+sessionTokenHash+会话有效期
>   +authEpoch 授权代次（吊销即全票据/连接失效））；连接保存会话有效期到期关闭→客户端换新
>   token+新票据重连（协议级实测）；**消息结构验证**（null/数组/字符串/错型 type 只关该连接
>   ——旧实现 null 首帧 TypeError 冒泡）；maxPayload=64KB（认证前小消息上限）+订阅上限 200
>   +慢客户端 bufferedAmount>8MB 关闭 1013；**事件归属**：conversation_id 缺席沿 task_id/
>   thread_id 反查真实会话（解析不出不推——不自动视为公开）；**游标按订阅门控**：未订阅项目
>   事件不推进 nextSeq（订阅建立后仍可收到——不丢待续传）；每批 audience 重查不变。
> - **浏览器客户端（remoteClient 重写）**：认证下载（export.create→**认证 fetch→Blob→
>   objectURL 真实保存**——token 不进 URL；**下载端 origin 政策修正：同源 GET fetch 不带
>   Origin 是规范行为——携带才核对，缺席凭 Authorization**）；下载服务端 audience 重查
>   （manifest.conversationId）+realpath 实根+逐文件 sha256 对 manifest 双向对账+文件数超限
>   413 不静默截断+fflate 异步 zip（重活不阻塞）；**房间+DM 任务面**（conversation.list 执行
>   态+pendingReview 验收按钮（绑定 deliveryId/revision/manifestHash）+board.view 房间卡；
>   任务状态事件驱动刷新——thread.replyAdded/message.submitted 也触发）；附件有界 base64
>   （0x8000 分块——整份展开 RangeError）+**键控草稿**（A→B→A 不串；发送成功才清实际发送的
>   正文与 refs——图片门拒绝保留）；**失败信封**（cmdOnce→localStorage pendingOps——响应
>   丢失/刷新沿原 commandId 重试恰一次）；lastSeq/eventsSeen 持久+cursor-stale→activity.list
>   快照→再订阅；token 到期 401 自动续换（**renewSession 内 CREDENTIAL_INVALID 也要进终态
>   ——该路径不走 api 包装的漏修**）；吊销终态横幅（不重连）；history 渲染代次+会话核对。
> - **设置面（四）**：完整 64 位指纹（可复制）+实际客户端地址（可复制）+证书有效期/LAN 地址
>   列表；allowLan=false 拒非回环监听（反向 refine）；currentAddress 按实际监听事实（0.0.0.0
>   给 LAN 地址；stop 清 boundPort——停用不再显示运行中）；「自检码→RESULTS」按钮
>   （remote.pairing.selfcheckExport→daemon_state——双机包 self-check 读取）。
> - **REMOTE 会话 20/20**（真实用户链路）：双私信+验收策略→启用远程+完整指纹→SPKI 钉选壳
>   （**受控自动化证书例外——报告如实标注，正式双机入口不带此开关**）→配对→A→B→A 草稿→
>   真实附件上传+消息📎呈现→**CDP 离线断响应同号重试恰一次（before=0 after=1）**→DM 任务
>   发起/页面停止（run 收口）→页面验收（三重绑定→DONE）→**认证下载解包核对**（zip+正文+
>   附件随包）→关闭客户端任务继续+重开免配对（IndexedDB 复用）→刷新续传→游标过期快照恢复
>   （ZS_REMOTE_RESUME_WINDOW 钩子）→token 到期自动续换（ZS_REMOTE_TOKEN_TTL_MS=8s——
>   **TTL=4s 会把 WS 变成断连风暴的教训**）→吊销终态→壳退出（taskkill /T——electron 多子
>   进程 kill 不收树）→桌面停机+real_calls=0。会话清单含 REMOTE 纳入冻结序列。
> - **双机包（六）**：`node scripts/make-dev25-dual-package.mjs [--self-test]`→
>   dist/desktop/dev25-dual-win（ZhongshuoDual 拷贝+start-server.bat/run-self-check.bat
>   ASCII 启动器+seed-client.cjs/self-check.cjs+RESULTS 模板/buildId+README 双机步骤）。
>   内置 ZS_APP_DATA=server-data/ZS_RUNTIME=fake/ZS_ALLOW_FAKE=1/ZS_REAL_DISPATCH_GUARD=1/
>   独立管道 zs-dev25-dual/两 Agent/首任务 60s 停滞窗（D4 停止演练）；seed 经**正式命令**建
>   合成项目/房间×2/DM A（停止）+DM B（验收）/附件样本（**等 local.token 文件出现再读——
>   seed 先于 daemon 生成 token 的时序坑**；conversation.create 返回 {conversationId} 扁平）；
>   self-check 从 sqlite 读 remote_config/daemon_state 自检码执行错码/伪造 Host/伪造 Origin/
>   无 token 负例（better-sqlite3 从包内 node_modules require）；**自测口径：父环境剔除全部
>   ZS_*（全裸白名单 Electron 不稳——USERPROFILE 系变量必需要）+中文空格临时路径两连过**
>   （seed→优雅退出→real_calls=0）。交付说明=README（服务机/客户端步骤、指纹核对、系统信任、
>   D1—D10 模板；移动端按 R11 独立范围不混入）。
> - **验证数字**：remoteAccess 19/19（11 旧+8 新协议反例）；REMOTE 会话 20/20；双机包自测
>   两连过（清 ZS_* 环境+中文空格路径）；本地全量 **810/810**（githubSandbox 网络恢复 5/5——
>   上一轮间歇失败记录保留）；**冻结三连 138/138×3**（新基线 bld_d96713369ac153d0——
>   created v20261002042441-g3vcxy + reused v20261002043259-7thzqi/v20261002044114-p48rzw；
>   会话清单=A,B1,B2,C,D,E18,REM,FS,BOARD,ATT,HARNESS,**REMOTE**；旧 118/118×3 原样保留）；
>   零新增真实模型调用。
> - **遗留（迭代中修的坑）**：页面任务区冻结在 queued 旧渲染（停滞期无事件）→5s 轮询兜底；
>   fake 停滞脚本中断不推进脚本序（第二任务同停滞）→等待覆盖停滞窗；ATT 刷新后立即读
>   DOM 的空引用→表达式空安全；同源 GET fetch 不带 Origin 属规范→下载端缺席凭 Authorization。

---

## 上一轮快照（2026-10-01 第三十一轮）

> 本轮=**导出目标与完整性收口**+**DOCX 真实 Word 布局验收**+**Activity 稳定游标/看板可见范围
> /消息操作接线**+**DEV-25 远程访问服务端全量落地（HTTPS/WSS/配对/吊销/续传——LAN-01—08+RT-21
> 全反例）**+**本机浏览器闭环（REMOTE 会话）+双机验收材料**。上一轮快照（第三十轮）紧随其后。
> - **导出完整性（exportIntegrity 9/9）**：export.create 归属先于回执（「合法会话 A+其他会话/
>   项目线程 B」整笔拒绝零产物；快照在事务内核取；拷贝后事务复核归属/audience/引用版本
>   （id+revision+hash 不变——EXPORT_CONFLICT 清理））；**回执重放不绕过当前权限**
>   （网关 runCommand 加 replayGuard——旧回执在会话归档/audience 失效后重放同号同参=明确
>   拒绝；同号异参仍冲突；上传/导出/提交三入口接入）；附件不再裸 stat/copyFile——
>   readVerifiedStoreRaw（实根/实身份/受控句柄/实际字节 sha256；**按 kind 区分 .txt/.bin
>   扩展名——text_file 用 .bin 会误判越界的实测坑**）；out-of-store/损坏=整笔失败（不冒充
>   随包也不冒充缺失）；manifest.json 与最终 assets 字节一致（写后重读 sha256 对账）；同内容
>   多引用单随包文件；system 消息保留「系统」来源；预算（消息 2000/件数 200/总量 256MB）
>   超限 EXPORT_TOO_LARGE 提示收窄不静默缩小；重活异步逐件让出。
> - **DOCX 真实 Word 验收（docxWordValidation 5/5）**：OOXML 规范修复（`<w:color w:val=…>`
>   替换非法 `<w color=…>`；表格补 tblPr+tblGrid；styles 关系移 word/_rels/document.xml.rels
>   ——包级 .rels 只留 officeDocument；XML1.0 非法控制字符清洗）。**本机 Word COM 被 WPS 劫持
>   且自动化崩溃不可用**——绕行：spawn 真 WINWORD.EXE /automation → ROT GetActiveObject 附身
>   → 校验 app.Path 为真 Office（word-open-check.ps1）。固定样本实开：长中文 17 页/60 行表格
>   不丢行/特殊字符（&<>"'+vtab 清洗+中文标点保留）/缺失附件 ⚠ 行——全部打开无修复提示+
>   Word 导出 PDF 页图证据（tests/artifacts/docx-word-evidence/ 8 文件）。
> - **Activity/看板/消息操作**：activity.list 稳定游标（(created_at,seq) 双键决定性排序——
>   同毫秒 12 事件翻页无重无漏；渲染器「加载更早」带 beforeSeq）；nav.preferences 落地
>   （navigation_preferences.visibleProjectIds 首次被消费——scope=all 聚合面按可见集过滤、
>   显式 projectId 查询不受限；无偏好行=全量兼容）；**attachMsgActions 此前从未挂载渲染链
>   （第三十轮声称的消息操作组实缺——本轮在 attachSaveButton 接线+表情层跨轮询重绘保持
>   （openEmojiLayers 集合）+md 原文行结构化**；ATT 会话 36/36（新增 Markdown 恶意样本安全
>   （脚本转义/javascript 链不落地/远程图占位）、预览搜索+行引用入正确草稿、三格式导出+
>   打开目录、线程导出守卫、Activity 定位、表情刷新保持）。
> - **DEV-25（remoteAccess 11/11 + REMOTE 页面会话 10/10）**：迁移 038（remote_devices/
>   pairing_codes/config/attempts）；remoteIdentity（PowerShell New-SelfSignedCertificate→PFX
>   +DER+SHA-256 指纹；SAN 覆盖检查复用、覆盖变化重新生成；TextExtension 不能与 -DnsName
>   同用的坑）；remoteServer（HTTPS 强制；Host/Origin 白名单=本机配置推导；/pair 唯一免 token
>   入口——原子消费+加盐摘要+5 次失效+限速 429+Retry-After；/session Device→15min token 仅
>   内存；/ws-ticket 30s 单次票据；/cmd 同 dispatch 同权限同幂等+REMOTE_BLOCKED_METHODS
>   （配对创建/配置/吊销/关停仅本机）；/export/:id/download zip 获准下载；**手写 WSS**
>   （握手+掩码帧解析+分片+ping/pong——ws 包不在依赖；首帧认证 5s 窗口、未认证限额、仅事件
>   与订阅控制、写走 HTTP；事件泵每批 audience 重查（他人 DM 不推）；lastSeq 续传+游标过期
>   cursor-stale 走 HTTP 快照；吊销立即断流；**upgrade head 前导 CRLF 容错**）；命令面
>   remote.config.get/set·pairing.create·devices.list·device.revoke+entry.ts 生命周期接线
>   （配置启用才启动；启动失败=远程面不可用不降级不拖垮本机；stop 链收口）；**Electron 本机
>   可信 UI**：IPC sender 校验（zs:* 仅 zsres://app/ 帧——不以 loopback 替代来源校验）+
>   setWindowOpenHandler 全拒+will-navigate 非 zsres 拦截；设置面「远程访问」（启停/监听地址/
>   配对码一次性展示+地址+指纹/设备清单+吊销；展开即刷新）；remoteClient（同源静态页+严格
>   CSP 无内联脚本；IndexedDB 凭据+内存 token；消息/上传/任务停止验收/导出下载/WSS 订阅
>   feed）；**本机浏览器闭环**：便携包 Chromium 作纯浏览器壳（ZS_REMOTE_SHELL_URL 钩子——
>   无 preload+SPKI 钉选信任（appendSwitch 必须在 app ready 前+标准 base64——url-safe 无效
>   两坑））——桌面造码→浏览器配对→仅记录发消息→事件流→导出下载→吊销拒绝 10/10。
> - **双机材料**：docs/implementation/dev25-dual-machine-acceptance.md（服务机/客户端步骤、
>   证书指纹核对、D1—D10 人工项、留档模板、移动端如实未测）。**用户已确认另一台 Windows
>   同局域网可用**——下轮可执行双机实测。
> - **验证数字**：本地 **797/797**（排除 githubSandbox——本机到 GitHub TLS 间歇失败 schannel
>   SEC_E_ILLEGAL_MESSAGE：波动 2/5→4/5、期间直连 ls-remote 亦败、同窗口 git push 正常——
>   网络层间歇非代码层；待稳定重跑取 5/5）；新增 exportIntegrity 9+docxWord 5+activityCursorScope 2+
>   remoteAccess 11；ATT 会话 36/36；REMOTE 会话 10/10；**冻结三连 118/118×3**（新基线
>   bld_fd894004ea2b7e91——created+reused×2 各 583 文件 SHA256 核对；旧 112/112 报告原样
>   保留；+6 来自 ATT 扩项）；零新增真实模型调用。

---

## 上一轮快照（2026-10-01 第三十轮）

> 本轮=**解析池队列身份与子进程生命周期修复**+**进程总内存硬界（Job Object）+流式 zip 护栏
> +SheetJS 官方发行版**+**缓存强校验与 PPTX 真实性**+**共享预览完善/Markdown 安全预览/
> md·html·docx 导出**+**Activity 流/消息操作/表情**。上一轮快照（第二十九轮）见下分隔线。
> - **解析池重写（parseLifecycle 8/8）**：确认缺陷修复——waiters 只存 resolve、finally 以
>   当前任务参数出队（B 被当 A 解析）且 finally await 拖延原任务返回。现完整 job 队列
>   （每项自带 kind/blob/hash/options/入队时刻/截止/结算）+调度泵串行；**响应与退出分别
>   登记——并发槽在子进程 exit 确认后释放**；非法 jobId/超预算响应 kill 收拢后按错误结算；
>   成功后不退（2s 宽限 kill）；强杀未确认=parse-kill-unconfirmed（有界不虚报）；排队等待
>   纳入端到端截止（入队起算，耗尽不启动）；启动准备期 dispose 取消；dev worker 按源码
>   指纹重建（防新源码跑旧产物）。测试逐项断言内容/类型/sourceHash（不只 ok/计数）。
> - **限额与依赖**：--max-old-space-size 只限 V8 老生代（外部 Buffer 不受约束——旧「内存
>   硬界 320MB」表述撤回）→Job Object PROCESS_MEMORY 384MB+KILL_ON_JOB_CLOSE（整进程
>   提交内存硬界；**句柄存活到子进程 exit 再关**——Assign 后即关=当场杀子进程的实测教训；
>   非 Windows/附加失败=降级仅 V8 上限如实标注）；OOM 反例（allocMB=600 外部 Buffer——
>   收拢/分配拒绝、daemon 后续命令正常）。safeUnzip 单次流式解包（元数据预检+解压过程
>   累计实际输出——超限丢块不收集；解包结果定类+解析复用；resolveZipTarget 逐段栈解析——
>   字符串 replace '../' 会误伤其中 './'）；说谎 zip（声明 1KB 实际 40MB）+合计炸弹
>   （30×20MB）双反例。**SheetJS 0.18.5（npm 端点，官方已声明过时）→0.20.3 官方 CDN**
>   （固定 URL+sha256 留档；officeDependencies 3/3 锁安装版本/锁文件来源/留档；exports
>   封锁子路径——版本字面量常量）。公式/日期/合并/多 sheet/范围注入全复验（office 10/10）。
> - **缓存强校验+PPTX 真实性（cacheIntegrity 6/6）**：parserName/parserVersion 核对适用
>   解析器+真实版本（升级/换解析器=旧缓存作废）；pdf 逐页 bytes=实际字节数+总量=Σ；
>   伪造外壳（改版本名/塞超预算字符串）判无效——组装 fail-closed+预览重提回写；**迟到回写
>   防覆盖**（UPDATE 绑 id+hash+revision——重提期间资源升级=放弃回写用内存结果）。PPTX
>   页序按 sldIdLst（r:id→rels——插页/重排/删除后编号不连续仍真实顺序）；备注经该页自己的
>   slideN.xml.rels 定位 notesSlide（编号与页号无假定）；孤立未引用页排除；**备注计入总预算**
>   （此前只计正文）；样本 slide5→slide2+notesSlide3 错号+slide9 孤立页。
> - **共享预览完善（第三十轮四）**：project.file.read（只读快照：resolve 边界+realpath 实身份
>   +文本白名单+≤256KB+fatal UTF-8——不进模型输入）；Files 面板托管附件点击→统一预览+
>   项目文件点击→快照面板；复制引用（文件名+版本+hash）/预览内搜索（行高亮+行号）/行引用
>   点击入草稿（不发送）；**Markdown 安全预览**（mdToSafeHtml 先整体转义再生成受控标签——
>   脚本/事件属性无处出现、远程图片不加载、代码只展示）；**zsres 访问校验**（host 白名单仅
>   app+路径段 '..' 拒绝+非法编码 400——不以 standard+secure 注册本身当访问校验证明）。
> - **导出（sharedPreviewExport 5/5）**：export.create（md/html/docx）——范围快照+audience
>   逐项（他人 DM 拒；两 DM 互不含）；md 结构+附件 hash 清单；html 静态净化+assets 随包
>   离线可读；docx 手写 OOXML（mammoth 回读中文/表格验证）；附件按 hash 拷入（原件缺失
>   如实标注不中断）；失败清理半截目录；同 commandId 回执幂等；zs:openPath 仅 exports/。
> - **DEV-18/19 剩余首包**：Activity 流（activity.list——domain_events 只读聚合+DM 事件仅
>   本人可见+定位深链；侧栏「动态」入口）；消息操作组（复制/引用/表情 toggle+惰性计数，
>   迁移 037）；看板 scope=all 已有（visibleProjectIds 口径不变，无拖拽直改）。消息操作
>   全集/惰性表情其余形态、跨项目汇总增强仍剩。
> - 全量 **775/775**（新增 20：parseLifecycle 8+cacheIntegrity 6+officeDependencies 3+
>   sharedPreviewExport 5-2 重算；githubSandbox 网络间歇 schannel TLS——单跑通过如实记录）；
>   冻结三连 **112/112×3**（bld_0547e205c16b1171：created+reused×2 均带 SHA256 身份核对）；
>   ATT 页面会话 30/30（本轮无新增页面断言——沿用第二十九轮）。
> - 提交分组：解析池/限额/依赖（fd115ca）→共享预览/导出/Activity/表情（19d46b8）→文档。

---

## 当前真实状态（2026-10-01 第二十九轮，存档·原快照）

> 本轮=**PDF 解析迁入可终止子进程执行边界**+**上传幂等三层与缓存 schema v2**+**真实中文/
> CMap/扫描/加密样本与视觉页面渲染（zsres+canvas）**+**图片能力门（IMAGE_INPUT_UNVERIFIED）**
> +**DOCX/XLSX/CSV/PPTX 四类与表格范围注入**。上一轮快照（第二十八轮）见下分隔线。
> - **解析执行边界（parseWorker/parsePool）**：每任务独立子进程（pdfjs/mammoth/xlsx/fflate
>   只进 worker——daemon 主进程零解析依赖）；父进程墙钟截止 30s（覆盖加载/逐项提取/结果传输/
>   收拢——超时 SIGTERM→2s 宽限→SIGKILL，**exit 确认后才结算超时**）；并发=1（子进程
>   --max-old-space-size 320MB）+队列 4（超=parse-busy）；响应 4MB 防御；daemon.stop 同链
>   disposeParsePool（在途/排队 parse-cancelled、子进程杀净）。受控故障证明 parseBoundary
>   6/6：busyMs=Atomics.wait 同步阻塞子进程时 daemon 命令亚秒响应；exitCode 注入=
>   parse-worker-exited；dispose 30s 忙任务 <5s 收拢。**旧 Promise.race 计时器销毁竞态
>   （成功路径 10s timer 摧毁提取中文档）随之消除——截止由父进程统一管理。**
> - **上传幂等三层+缓存 schema v2（pdfCacheIdempotency 4/4）**：commandId 回执预查（重放
>   不重复解析——解析池 completed 计数为证）→同会话同 hash 去重（不新建记录）→跨会话缓存
>   复用（独立 audience 各建行、JSON 原样复用）；缓存 cacheSchema=2+parserVersion+budgets
>   （预算口径变化=旧缓存作废）+页码连续——预览侧无效即隔离重提回写，组装侧 fail-closed
>   不派发；解析期间归档→事务内重检失败（不留 artifact/半截缓存/错误关联——内容寻址孤儿
>   blob 不构成业务记录）。同 commandId 异参=IDEMPOTENCY_CONFLICT。
> - **托管存储实身份（storeLinks 3/3）**：readVerifiedCopy/readVerifiedBlob 三层——字符串
>   resolve 布局+**realpath 实际文件身份**（blobstore 根被换成指向外部的 junction（Windows
>   免特权）或文件级 symlink 都检出——外部同 hash 同内容文件也拒）+**受控句柄读取**
>   （open→fstat→fd 全量读→hash 实际字节——读取期间被替换=内容不符拒绝）。
> - **真实格式与视觉预览（realFormatDocuments 6/6+ATT 页面 30/30）**：真实中文样本改
>   Identity-H+ToUnicode 码位双射（**旧 makePdf latin1 中文已丢失——第二十八轮"中文可提取"
>   口径作废重立**；CIDFontType2 缺 FontDescriptor 会被 pdfjs 判坏字体走单字节回落——补
>   占位描述符）；CMap 样本=UniGB-UCS2-H+STSong（**随包 cmaps 真被消费**：CMapReaderFactory
>   走本地 fs（Node fetch 不支持 file://）；打包形态只认同目录 cmaps——隔离副本缺资源=
>   提取降级反例）；扫描件=FlateDecode RGB 图像页（文本如实空）；加密=Standard R2/RC4 40bit
>   真实 O/U/对象密钥计算（pdf-encrypted 分类）。**视觉页面渲染**：Electron 特权协议
>   zsres://（file:// 下 ES 模块被 CORS 拦——registerSchemesAsPrivileged standard+secure）
>   +渲染器加载随包 pdfjs ESM/worker/cmaps（build-ui 同步 vendored）→canvas 每页渲染
>   （data-state/page；翻页验证用**构造性色块指纹**（页1红/页2蓝——文本单字形差对采样指纹
>   不敏感的教训）；includeBytes 一次取原件、翻页/缩放本地；扫描件像素可见）。
> - **图片能力门+WebP 补全**：message.submit 引用 image_file 且将派发（DM 默认意图/主池
>   dispatch 路由）→IMAGE_INPUT_UNVERIFIED 拒发（不悄悄省略冒充成功）；imageAck=
>   'omit-images'（UI 门禁确认条：DM 区 dm-gate/主池 send-error——确认后发送）→注入
>   【图片附件未发送】+用户确认说明（hash 资源身份恰出现一次）；record_only/线程跟进不设门。
>   WebP 头解析补 VP8（同步码+宽高 LE14）/VP8L（签名+14bit 打包）；**像素解码以 img.decode()
>   Promise 为准**（规范失败即 reject——比元素存在/onerror 可靠；页面真实 WebP 由 canvas
>   编码产生、解码对账 naturalWidth=声明宽；仅头样本=VP8L 截断（VP8 有损头 Chromium 可容错
>   解码——选样教训）解码失败如实占位）。
> - **Office 四类（officeAttachments 9/9）**：定类在 worker 按解压后 [Content_Types]
>   （zip 条目已压缩——字面嗅探不可靠的教训）；DOCX=mammoth（段落/表格有序+白名单净化
>   HTML+宏/2003 拒绝）；XLSX=SheetJS（值缓存——公式不执行；<f> 无 <v> 的格 SheetJS 整格
>   丢弃→解析器在解压 XML 自查占位「公式无缓存值」+全表标注；日期 numFmt/合并/多 sheet）；
>   CSV=自研（UTF-8/BOM/UTF-16 探测+RFC4180+分隔符嗅探；GBK 字节流明确 unsupported）；
>   PPTX=fflate+XML（按页文字+备注；页图 unsupported 如实）。zip 护栏：条目 1500/单条目
>   64MB/总量 160MB/路径穿越拒绝（fflate 返回 Uint8Array——.toString('base64') 无效的坑：
>   工厂统一回 Buffer）。**表格范围注入**：attachmentRanges（提交时校验格式/越界/超窗口）
>   →迁移 036 message_attachments.range_spec→组装 renderSheetWindow（默认=首表 50×16 有界
>   窗口；窗口外无数据不以空串冒充）。
> - **共享预览规格**：attach-preview 面板视图全局化（存量缺陷：原埋 DM 区内，池/线程视图
>   预览写入但不可见）；预览代次沿用（A/B 交错/关闭/切会话迟到作废）；office/图片/PDF 预览
>   全部经正式命令面（audience+实身份+sha256）。
> - 打包：parse-worker.cjs（esbuild cjs——ESM 输出下 mammoth/xlsx 的 require 垫片炸）+
>   cmaps 随包（pack-daemon/pack-desktop）；build-ui 同步渲染器 assets/pdfjs（vendored
>   入 .gitignore）；选型说明 docs/implementation/office-parsing-choice.md。
> - 全量 **755/755**（+28）；冻结三连与新 build 身份见本轮报告；提交分组：解析边界/幂等与
>   实身份/真实格式与门禁/Office 与范围/视觉与文档。

---

## 当前真实状态（2026-10-01 第二十八轮，存档·原快照）

> 本轮=**通知人工验收归档**+**停止领取层意图代次**+**草稿/预览/评论准确目标**+
> **图片附件首包**+**PDF 附件首包（pdfjs 随包）**。上一轮快照（第二十七轮）见下分隔线。
> - **通知人工验收通过（归档 evidence/notify-manual-acceptance-20261001.md）**：
>   bld_14f26baeb5a8d656——用户回填全符（两条通知出现/点击定位正确/无重复/通知中心留痕/
>   无异常）；工程只读核对一致（10 提醒 fired、real_calls=0；用户顺带验证确认执行链×2：
>   2 dm_turn+reminder_calls settled×2）；范围仅该 build 与该机环境（不推广全部 Windows）。
>   **不再等待新回传，用户无需再跑通知包。**
> - **停止领取层意图代次（迁移 034）**：outbox.stop_generation_at_enqueue（六入队点快照：
>   房间 initial/DM initial+泵/提醒跟进/redispatch/修复）。领取判定按意图自身代次——
>   入队后无新停止（==）=合法：忙碌时释放租约回 pending 沿串行等待（drain busyDeferrals
>   同轮跳过+开轮清空重试），不静默丢弃；被新停止超越（>）=拒绝收口不复活；旧行 -1 回落
>   保守。**预占精确绑定释放**（releaseUnlinkedReminderReservationsForDispatch——按完整
>   身份键只放本派发预占，不按 task 一次释放）。stopIntentGeneration 4/4（历史停止后新 run
>   在途又有提醒=等待不丢终态后恰一次；被超越取消+合法执行+不复活；停止前入队被超越拒绝+
>   停止后新计划对照；重启归属/预占/队列保持）。
> - **草稿/预览/评论准确目标**：draftKey=projectId+roomId+threadId（同房间线程 A/B 不再串
>   草稿）；DM 键带 project/conversation；正文/附件/mention/上传回执/发送清算同键快照
>   （send/retry 按发起键清算）。previewGeneration 预览代次（两次 await 间 A/B 交错/关闭/
>   切会话迟到作废；切会话入口即关——受限资源不留面；来源会话+所见版本标注）。
>   评论 expectedHash/expectedRevision 必填+**事务内重读核对**（VERSION_CONFLICT 不悄悄锚
>   最新）；行锚点按提取文本实际行数；quote 必须存在于正文；stale 同比 hash **与 revision**
>   （同 hash 不同 revision 反例）。readVerifiedCopy 实根校验（storeRoot 注入 previewText+
>   turnInput 经 worker——外部同名 blobstore/链接越界检出）。
> - **图片附件首包（imageAttachments 4/4）**：uploadImage（magic bytes 内容类型+头部尺寸
>   限幅 12000px/40MP/8MB；损坏截断拒绝；内容寻址 {hash}.bin）+previewImage（实根+sha256
>   原件核对；dataUrl——渲染 <img> 浏览器沙箱；OCR=未实现/模型图片输入=未认证如实标注；
>   注入不含图片数据）。消息可带图引用；图片评论随分批归属拒绝。
> - **PDF 附件首包（pdfAttachments 3/3+打包产物独立冒烟）**：pdfjs-dist（纯 JS legacy）
>   打进 daemon bundle+pdf.worker.mjs 随包（pack-daemon/pack-desktop 拷贝；file:// URL
>   workerSrc——Windows 绝对路径动态 import 需 file URL）；uploadPdf（%PDF- magic+隔离解析
>   isEvalSupported=false；加密/损坏/超 200 页/超 20MB 拒绝；提取随上传缓存迁移 035
>   artifacts.extracted_text_json）+previewPdf（分页文本+扫描件空页如实+像素渲染/OCR 未实施
>   标注）+受限注入（[第 N 页] 标注+64KB 预算+缓存脱钩 fail-closed）。
> - 全量 **727/727**（新增 stopIntentGeneration 4+imageAttachments 4+pdfAttachments 3+
>   attachmentChannels 实根用例）；提交分组：归档/停止代次/目标准确/图片/PDF/文档。

---

## 当前真实状态（2026-10-01 第二十七轮，存档·原快照）

> 本轮=**通知验收入口启动器闭环**+**附件四通道正式链/草稿键控/完整性**+**代码附件与基础评论**+
> **看板状态映射修正与动作/Files**+**历史停止代次三层误拦修复**。上一轮快照（第二十六轮）
> 见下方分隔线保留。
> - **通知启动器闭环（关键缺陷两枚）**：①chcp 65001 下 cmd 解析**含中文的批处理行会字节
>   错位**（set 行劈成 "APP_DATA 不是命令"、start 行被吞=electron 从未启动——第二十六轮自测
>   走了自设环境路径未运行交付启动器，缺陷漏网）——启动器内容改**纯 ASCII**+包内目录改
>   ASCII（app/app-data/demo-project/results；中文只留文件名与 txt 内容）；②隔离环境在
>   cmd 顶层显式设置（ZS_RUNTIME=fake/ZS_ALLOW_FAKE/ZS_REAL_DISPATCH_GUARD/ZS_APP_DATA/
>   完整前缀管道/ZS_APP_MODE=fake-sim——seed 与 Electron 同源继承；清空开发终端遗留覆盖型
>   ZS_*）。seed 停机如实化（核对退出码+stop-result；超时=失败不打印已优雅停止；按 runId
>   留档 seed-*.txt 不覆盖 result.txt）；seed 等任务终态再停机（消除恢复横幅）。
>   **backgroundThrottling:false**（实证被遮挡窗口 1.5s 轮询被节流——提醒到点 2m11s 后才
>   通知；修复后 1s/14s）+fake-sim 标题防页面 <title> 覆盖。**干净环境实测全过**（清空 ZS_* 跑
>   交付启动器 auto×2：窗口+模拟验证模式标题+项目自动恢复+无横幅/通知五相+3.5min 去重恰一次/
>   **OS 层吐司显示视觉取证**（超出 Electron shown 事件的新证据）/real_calls=0/优雅关窗
>   electron+daemon 全退）。**待用户人工复核**：Windows 送达/点击定位（双击
>   通知人工验收/启动通知验收.cmd；结果写 results\result.txt）。
> - **附件四通道（attachmentChannels 10/10）**：主池/任务线程/记录线程/DM 共用
>   resolveAttachmentRefs（存在/kind/归属会话一致——不存在/跨会话/不支持明确拒绝+同事务
>   回滚零残留——此前主池/线程发送带 attachmentRefs 被**后端静默忽略**）；输入水位正确
>   轮次（房间=根+线程跟进消息附件随重派进第二轮不回溯已完成轮；DM=水位内全部历史消息
>   ——排队附件随其消息进下一轮不提前进在途轮）；完整性（src/daemon/attachments.ts 共享
>   读取路径：**读取核对 sha256(实际字节)==记录 hash**——损坏拒预览拒组装不以旧 hash 注入
>   新文本；路径限定内容寻址存储（{hash}.txt+父目录 blobstore）；**UTF-8 字节截断保留完整
>   字符**——中文 3 字节/字符，字符串 slice 按字符数截远超字节预算的缺陷修正，原始/提取
>   大小分别注明）；草稿键控（Map 按 room:view 与 dm:{conversationId} 键——A→B→A 恢复 A
>   （切会话不再清空）；上传异步回执**绑定发起时目标键**（file.text/网络期间切换不串草稿）；
>   发送成功只清信封内实际发送 refs（失败保留正文与附件）；**真实文件字节 fatal UTF-8 解码**
>   （File.text() 有损解码缺陷——坏字节明确失败不上传替换字符））；草稿与已发消息附件芯片
>   点击经 previewText 共享文本预览（thread.history/conversation.history 返回附件摘要）。
> - **代码附件+基础评论（codeAttachments 2/2）**：kindForFilename 按扩展名推导 code_file
>   （.ts/.py/.sql 等——同一上传/预览/引用/注入链路，startTurn 实际代码文本验证；其余五类
>   不冒充）；迁移 033 attachment_comments（行号区间+选区引用 quote+正文，**锚定评论时
>   artifact_hash/revision**——资源更新后读取比对当前 hash 标 stale（行号锚点不漂移到新版
>   不重算）；audience=归属会话（他人 DM 评论/列表均拒绝）；lineTo<lineFrom 校验）。
> - **看板映射修正（boardFormalStates 5/5 正式链六形态）**：DONE/FAILED=已完成列（旧实现
>   DONE 落等待）、CANCELLED=已停止、STOPPING=停止中、INTERRUPTED=中断列停止；
>   **exitUnconfirmed=run INTERRUPTED 且该 run 存在 UNKNOWN turn 的事实**（旧检查
>   run_status==='UNKNOWN' 恒假——workflow_runs 状态机无 UNKNOWN，那是 agent_turns 状态）；
>   **stop_generation 是代次不是停止证明**；看板动作行接已有正式命令（停止 task.stop——run
>   在途才出现；通过验收 task.review——绑定展示时 deliveryId/revision/manifestHash；闭包
>   钉死目标，刷新重绘不换目标；未有命令的动作不出现）；files.view 四类分列（项目文件=
>   目录一层条目/托管附件=audience 过滤+私信标注（他人 DM 不进集合）/Agent 草稿=change_sets/
>   交付成果=#delivery= 深链——逐项来源+hash+定位；纯读零运行）。
> - **历史停止代次三层误拦（产品级缺陷，正式链实证）**：停止不响应→崩溃恢复（run
>   INTERRUPTED/turn UNKNOWN/任务回 ACTIVE）后，stop_generation>0 **永久静默丢弃一切新派发**
>   （含第二十五轮已放行的绑定提醒跟进——调度器侧修了、领取侧漏网）：①领取层 stop_generation>0
>   一票否决→改生效判定（在途/停止中 run 或非终态 turn 存在才算停止仍在生效）；②
>   stoppingOrTerminal/迟到完成守卫/两处 INTERRUPTED 用户停止判定→**迁移 032
>   agent_turns.stop_generation_snapshot**（turn 创建时快照；current>snapshot=本次停止；旧行
>   -1 沿用保守旧语义）。正式链证明：恢复后绑定提醒到点跟进派发→新 run RUNNING 列执行中
>   （历史代次仍在、exitUnconfirmed=false）。
> - 验证器升级：ATT 会话改**真实 UI 上传路径**（DataTransfer 驱动 file input change 走
>   wireAttach 全链——旧手插 DOM 芯片不算数）+非法 UTF-8 拒绝+UI 发送键控清算+已发芯片
>   预览+评论区表单+主池通道（解析器.ts→线程芯片→代码标注预览）；BOARD 会话+已完成列+
>   Files 面板断言。
> - 全量 715/715（新增 attachmentChannels 10+boardFormalStates 5+codeAttachments 2）；
>   提交分组：通知入口/附件四通道/看板 Files 停止代次/代码评论/文档；冻结新 build
>   bld_e16fe07c7c47cb17（runs 见 dist/desktop/vdr-runs/）。

---

## 第二十六轮快照（存档）

## 当前真实状态（2026-10-01 第二十六轮，存档）

> 本轮=**提醒派发与预算的准确归属**+**通知修复与人工验收入口**+**搜索过滤一致性**+
> **DEV-19 看板/协作视图首包**+**DEV-24 文本/Markdown 附件首包**+**冻结身份核对**。
> - **准确归属（迁移 030）**：跟进派发键完整身份 `task:{taskId}:reminder:{rid}:{sat}`
>   （原键缺 rid——同任务同刻两提醒撞唯一键）；归属解析：跟进键直取/修复沿源 turn 调用
>   行/追加按未挂钩预占或最近调用行——**不再按 task 唯一推断**（reminderLinkageForTask
>   降级展示用）；acquireReminderTurnSlot 移入 createRun 事务首句（**原子收敛**——组装
>   失败/创建前崩溃/重领不留指向不存在 turn 的 inflight）；无预算也入账（审计）。
>   reminderOwnership 4/4（同任务两提醒不同预算——B 的修复沿源拒绝而 A 不受牵连；
>   同刻两键不撞；绑定前普通轮零台账；重启归属额度保持；组装失败 reserved 可恢复）。
> - **通知修复**：服务端返回**准确 locate**（DM/房间任务串/讨论串区分——点击只定位）+
>   notifyMuted（目标线程静音独立过滤——不用未读聚合过滤代替；待办保留仅禁通知）；
>   五相事实留痕 zs-notify-log（只证客户端各相——**Windows 已显示留人工**）。
>   **连带修复第二十五轮字段名回归**：renderer 仍读蛇形 reminder_id（服务端已驼峰）→
>   确认按钮静默失效+「回复到达」实为 system 唤醒消息渲染成 agent class 的假阳性——
>   驼峰修复+system 独立 class，REM 9/9 恢复（确认即 dispatched）。教训：**改共享
>   命令返回字段名必须同步 renderer 消费方**（本轮第二次踩同型坑）。
> - **通知人工验收入口**：dist/desktop/通知人工验收/（新构建 buildId/独立 appData/合成
>   项目/fake+ZS_REAL_DISPATCH_GUARD=1 **内置**——用户零配置零环境变量；seed 走正式
>   daemon 管道；开发机自测通过（项目自动恢复+两条通知 created+shown+去重+guard）；
>   **人工复核已通过（第二十八轮归档 evidence/notify-manual-acceptance-20261001.md；范围仅该 build 与该机）**
> - **搜索一致性**：线程/任务分支统一作者/会话/日期过滤（线程=锚消息列、任务=根消息
>   LEFT JOIN——无根任务设日期过滤如实排除）；日期**本机时区**（北京凌晨边界用例）；
>   dev18FollowSearch 7/7。
> - **DEV-19 首包**：board.view（只读聚合——列位/退出未确认/pendingDelivery 最高一条；
>   dm_turn 不进房间看板；打开零运行）+thread.collaborators（四列分列）+renderer 看板/
>   协作视图；boardView 3/3+BOARD 会话。剩余：看板动作接正式命令的快捷入口、跨项目
>   拖拽视图（不做状态直改）、Files 集合视图。
> - **DEV-24 文本首包（四能力）**：保存副本（内容寻址 {appData}/blobstore——不在用户
>   项目目录；迁移 031）/预览+提取正文（读获准副本；原文件修改不影响；跨会话拒绝）/
>   经授权交给模型（ContextBundle.attachments→模型输入含副本实际文本+hash/revision/
>   截断说明；副本不可读=组装失败）/上传入口（DM+主池📎；草稿隔离）。textAttachments
>   5/5+ATT 会话（注入断言以 **ContextBundle 服务端留档**为准——fake 回复不引用暗号
>   不冒充）。**文本首包≠DEV-24 完成**——其余六类/评论/共享预览/导出逐项保留。
> - **冻结身份核对**：ZS_VDR_EXPECT_BUILD_ID 运行前拒绝错包（exit 3）——上轮旧冻结
>   目录教训的可执行收口；本轮三连 86/86×3（bld_fbf9a457a7117f96：created+reused×2
>   **均带身份核对通过**；含 E18 17/17+REM 9/9+FS 10/10+BOARD+ATT+HARNESS 15）。
> - 测试：本地全量 **698/698**（+ownership 4+board 3+attachments 5+search 1）；E18
>   17/17；REM 9/9；FS 10/10。
> - 下轮顺序：①通知人工验收结果回收（Windows 送达/点击——用户侧）；②DEV-19 剩余
>  （看板动作快捷入口/Files 集合）；③DEV-24 其余六类附件+评论+共享预览；④真实批次
>   仅明确新认证目标时（不重复 r20-dm/r25-rem）。
> - 坑（第二十六轮）：**改命令返回字段名必须 grep renderer 消费方**（蛇形→驼峰漏改=
>   onclick 静默 undefined——两次同型坑）；Electron details 折叠面板 DOM 仍在但保险
>   展开；CDP 端 evalJs 里模板串 `\n` 是字面反斜杠 n（用 String.fromCharCode(10)）；
>   commandId 最短 8 字符（信封校验）；测试断言「回复到达」必须区分 system/agent
>   渲染 class（唤醒消息≠模型回复）。

---

## （上一轮快照，2026-10-01 第二十五轮）

> 本轮=**提醒预算接到实际调用边界**+**命令重放/取消/确认事务修复**+**目标与授权链补全**+
> **DEV-18 关注/搜索/收藏落地**+**桌面系统通知**+**真实小批次 r25-rem**。
> - **调用台账（迁移 028 reminder_calls）**：预算口径=**模型调用数**（一个任务≠一次调用——
>   修复/追加/重派都产 turn；dispatchedCountOf 的等式不成立，已废）。派发/确认创建时持久
>   预占（reserved）；worker 建 turn 前 `acquireReminderTurnSlot` 统一检查+挂钩（在
>   createRun 前置——初始/确认/跟进/修复/追加/重派全走此处，**不能通过新 run 绕开**）；
>   终态保守计数（casTurn 统一收口：FAILED→failed、UNKNOWN/CANCELLED→unknown 均计数，
>   **重启不清零**）；turn 前取消/成员停用→released（确定未花才归还）。**max_triggers
>   触发上限独立分列**（occurrence 口径）。反例全过（reminderBoundary 8/8，断言**底层
>   startTurn 次数**）：sum=1 首轮无效格式→修复派发被拒（恰 1 次调用+任务 BLOCKED+提醒
>   paused）；追加执行不绕额度（重启不清零）；两待确认 occurrence 争最后一格恰一条获准
>   （第二条 BUDGET_EXCEEDED——预占在确认事务内先占）。
> - **命令事务修复**：confirm/update/snooze 状态类前置移回**事务内重读核对**（并发取消/
>   额度变化不被事务外旧快照放行）——错误码靠**网关领域错透传**保住（commandGateway 识别
>   DaemonCommandError 形状保 code，不再一律包装 STORAGE_UNAVAILABLE）；授权校验（audience）
>   保留在网关外每次重检；**重放先命中持久回执**（runCommand 在 handler 前查
>   command_receipts——同号重试返回首次结果原 taskId，首次成功后的状态变化不阻塞）；
>   cancel 放宽：done+待确认触发可取消并**结算待确认项**（cancelled_by_user——待我处理
>   同步消失）；正式链测试：once→待确认→取消→确认拒（/已取消/）→零 turn。
> - **目标与授权链**：绑定 threadId/taskId 的房间提醒=**跟进既有任务**（线程 system 跟进
>   消息+`task:{id}:reminder:{occ}` 派发键——worker parseInitialTaskId 扩展；不把原串跟进
>   默默变成另一个无来源根任务；讨论串（无任务）schedule 即拒）；owner 检查扩为房间成员
>   （room_members）+任务冻结名单（route_json.frozenMemberIds）+DM 对端；**停止代次按绑定
>   快照**（bound_stop_generation——绑定后**新**停止才判停，历史停止不永久禁止新合法提醒）。
> - **DEV-18 三项**（001 预埋 thread_subscriptions/thread_agent_followers/saved_items 再立功
>   ——建表前 grep 的教训第三次兑现；saved_items 以 message FK 为主键装不下链接/交付→
>   迁移 029 saved_refs 四类引用，saved_items 合同位保留）：**关注/静音**（人的阅读订阅与
>   Agent 执行名单分列；零运行零预算零模型调用；muted 排除 room.pool/mine.pending 未读聚合、
>   followed 有未读进待我处理）；**搜索**（search.query：消息正文/线程锚/任务标题+附件**只随
>   所在消息文件名**检索（正文提取未实施不冒充）；scope=project/all（全部可访问=同
>   mine.pending 口径）；作者（显示名跨项目）/日期（含当日）/会话过滤；created_at+id 确定性
>   排序分页；他人 DM 消息/线程/任务零泄露；结果带 #msg=/#task= 定位）；**收藏**
>   （saved.add/list/remove：幂等 existed；取消不删原内容；missing/forbidden 如实呈现；深链
>   跳转；link 校验 http(s)）。renderer：搜索面板（范围/类型/作者/日期+分页）、收藏面板、
>   消息☆收藏（线程+DM）、线程头关注/静音按钮。dev18FollowSearch 6/6（中文/过滤分页/同名
>   跨项目/他人 DM/失效收藏/重启保持）；**FS 页面会话 10/10**（搜索定位/收藏幂等/取消不删/
>   关注→未读→待我处理/静音清零/零 real_calls/停机）。
> - **桌面系统通知（ATTN-05/06——不再「如需」悬置）**：新待确认触发→web Notification
>   （Electron renderer）：去重（localStorage 集+系统 tag——同 occurrence 恰一次）、点击
>   定位（window.focus+#dm= 深链）、onerror→页内提示（**送达失败不改执行授权、不重复派发**）、
>   权限 denied→页内如实；静音线程不产生通知（服务端聚合已排除）；状态未变无行动项安静。
>   REM 会话验：permission=granted+去重集恰 1；**送达/点击定位的真机人工面待用户复核**
>   （如实标注——不冒充已验）。Web Push 等远程通知单列未做。
> - **真实批次 r25-rem 全过**（持续授权内新目标）：system 来源提醒**自动触发一次**+**待确认
>   →用户确认一次**；恰 2 次 startTurn 全 succeeded（cap=4 未触）、请求/响应自报双向一致
>   deepseek-flash、reminder_calls 各恰一行 settled、owner/目标会话/模板字段（DEV-21-M3）/
>   暗号回流全核对、daemon 优雅退出 exit 0；台账 real-batches/r25-rem-ledger-real.json+
>   纪要 r25-rem-result.md；演练 ledger-rehearsal（fake 零调用）。不重复 r20-dm、不清旧账。
> - **processProbe 首败条件定位**（第二十四轮全量首跑 1 失败）：真身=杀孙进程后**固定 1.2s
>   等待**短于高负载下周期快照滞后——probe 读到的最新快照仍含孙→断言失败；复跑通过≠根因
>   解决。已改**条件轮询**（等孙身份 exit_confirmed_at 落库，上限 10s）。
> - 测试：本地全量 **685/685**（+dev18FollowSearch 6+reminderBoundary 8）；E18 17/17；
>   REM 9/9；FS 10/10。
> - 冻结三连（本轮新 build）：**76/76×3**（bld_e5a7b95968c8655f：afblyq=created →
>   2pf8b3=reused → wzuqxa=reused——逐文件 SHA256 复用核对；含 A/B2/C/D 同步点+E18 17/17+
>   REM 9/9+FS 10/10+HARNESS 15）。前置排障：首两次全序列在 E18「两线程未读」超时两连挂、
>   同构建单跑与 HARNESS+E18 组合全过——**真身=dist/desktop/vdr-frozen 遗留 round-22 旧冻结
>   产物**（bld_3b44ff…，commit ddc36bd，9-30 14:38——不含 23-25 轮 renderer 修复；FROZEN
>   复用逻辑见 MANIFEST 即用旧目录=与当前验收需求不符）。删除后以当前提交重建冻结三连全过。
>   教训：**冻结目录跨轮遗留必须先核 buildId/commit**（新旧源码差一轮以上时旧冻结必不符）。
> - 下轮顺序：①全序列若再现同处失败→专项取证（负载窗口内 room.pool 轮询时序）；②DEV-18
>   交付矩阵未做项如实保留（Activity 流/消息操作全集/惰性表情——不宣布全包）；③通知真机
>   人工复核项交用户；④DEV-19 看板/DEV-24 首类附件（矩阵新序）。
> - 坑（第二十五轮）：**DOM 持久陷阱**——hidden 容器的内容不消失，waitFor 断言必须看
>   classList 视图真伪（'thread' hidden+pool 可见）而非内容存在；**关注行测试时序**——关注
>   须开线程（顺带标读）→关注行只能测「关注之后到达的回复」（素材线程要在测前一刻发）；
>   网关事务内领域错不再包装（但**新命令**的前置校验放事务内才有并发安全——错误码靠透传）；
>   一个任务≠一次调用（修复/追加/重派）——预算必须挂在 turn 边界。

---

## （上一轮快照，2026-10-01 第二十四轮）

> 本轮=**E18 两项遗留收口+验证器缺陷修复**+**DEV-23 核心合同重做（提醒正式化）**+**一处
> 第二十三轮遗留回归修复**。三类错误分别登记（验证器/产品/迁移——不一概归验证器）：
> ①**验证器错误三处**：678 行表达式多一个 `}`（`} })()`→`}))()`——evalJs 报 error 被当空
> DOM 读成「渲染瞬空」；新增 `readStrict`（error/异常即抛——读取失败与空 DOM 分开报告，
> E18 断言读取全部换严格）；跨项目 fixture 用 `directory_identity='{}'` 直插项目（正式
> project.open 按目录身份去重→另建 vdr-fixture-b=跨项目切换必败）——改**段 1 末尾经正式
> project.open 创建项目 B**（真实 projectId/引导成员/默认房间；seed 只补业务数据）。
> ②**验证器环境语义**：段 1 三项失败（线程标读/多待验收计数/前台贴底）两连复现真身=窗口
> 被遮挡（Electron occlusion→原生 document.hidden=true→markRead 全程零发出——后台不标读
> 是**正确合同**；round-23 四连过时窗口恰好可见）——验证器显式声明前台（hidden 固定
> false+`__zsSetHidden` 开关），非产品缺陷。
> ③**产品回归（第二十三轮遗留）**：task.review 服务端必填 manifestHash 但 renderer
> `reviewTask` 未发送+task.get 的 pendingDelivery 未返回 manifest_hash——房间线程验收/
> 拒绝 UI 链路自二十三轮起必失败（A 会话自二二轮冻结全序列后首次重跑才暴露；DM 验收链
> 二十三轮已同步修，房间线程漏了）。双层修复。
> **E18 结果（同一次完整运行）**：17/17 全过（runId v20261001021358-k9k47q；两项遗留
> 收口：13 项可达 head=共 23+第 13 条存在；跨项目深链=正式 project.open fixture 下切换
> 来源项目+线程打开；刷新/前进后退/他人 DM 全形态拒绝/错 hash/重复验收/零 real_calls/
> 双停机事实/无残留）。另次完整基线 65/65（runId v20261001022443-gmvh5i，buildId
> bld_b5b3227bc6b68ed1：A/B2/C/D 同步点+E18+REM+HARNESS 逐次留报告）。
> **DEV-23 正式合同重做**（首包六处实质缺陷全修，调度器整体重写）：
> - **computeNextAt 任意分钟**：09:17/23:59 可达（原 15 分钟步进只能命中特定分钟——「每天
>   此刻」多数分钟必失败）；naive-UTC 起步+分钟差归一化修正算法；**DST 规则明确化**（不再
>   「交给 ICU」）：春季跳变不存在的时刻→当日跳过取下一计划日（gap 内振荡检测）；秋季回拨
>   重复→取较早实例——真实转换日断言（America/New_York 2026-03-08 02:30 无解→03-09；
>   2026-11-01 01:30=05:30Z 第一次出现）；validateSchedule（时分范围/IANA 时区/weekday/
>   once.at——25:99、Nowhere/Zone 拒绝）；weekly 按**本地日历日**星期判定；update 同步
>   timezone 列（旧实现改计划不同步列）。
> - **原子触发（崩溃窗口闭合）**：CAS 领取+计划推进+last_fired_at+唯一 occurrence+派发
>   意图（消息/任务/outbox 键）**同一事务**——原五段事务存在「领取后崩溃=丢触发」「occurrence
>   pending 无恢复路径」；派发中途抛错=整体回滚（测试：注入故障→零 occurrence/零任务/
>   next_at 不动→重试恰一次）；意图提交后执行结算前=worker 既有恢复合同（outbox 持久）；
>   首包遗留 pending occurrence 构造时收案 merged（不重发）。执行复用既有正式链
>   （DM→createDmTurn+`dmtask:` 键；房间→createRoomRootTask+`task:` 键）——不自建第二套。
> - **休眠错过推导**：missed=计划在 (last_fired_at ?? created_at, now] 的触发数-1——
>   countScheduledBetween 从实际计划推导（原实现依赖预插 pending 行=不能证明真实停机）；
>   测试无预插 occurrence 跨日停机→恰一次合并触发。
> - **预算 fail-closed+正确作用域**：作用域=**本提醒已派发 occurrence 数**（每次派发恰一
>   个任务=恰一次 startTurn 计数；与派发同事务=预占原子）——原实现统计**全库 real_calls**
>   （他项目调用消耗本提醒额度）；损坏 budget_json 拒绝派发+paused 取证（原 catch 放行）；
>   超限=paused+budget_exceeded occurrence（不冒充）。并发：独立连接写锁争用让出
>   （busySkipped）+预领取让出（lost-race）——恰一次派发（受控同步点+收紧 busy_timeout）。
> - **权限/幂等（REM-5/6）**：五命令统一 audience（他人 DM 提醒不泄露不可操作——
>   reminderId 不能绕过）；owner=项目成员+启用；**DM 只能唤醒该对话对端 agent**；taskId/
>   threadId 归属校验；sourceRef 字符串不构成授权（autoDispatch=显式授权位，创建时落库
>   冻结）；schedule 的 reminderId **事务内**生成+返回 r.data（重放返原 ID——原网关外
>   重生成=重放返回未持久化新 ID；同号异参=IDEMPOTENCY_CONFLICT）；snooze bump revision；
>   cancelled 不复活（update 显式拒绝）；前置只读校验移出 run()（网关会把事务内领域错包装
>   STORAGE_UNAVAILABLE——保住 FORBIDDEN/SCOPE_MISMATCH/VALIDATION_INVALID/REVISION_CONFLICT
>   正式错误码+状态未变断言）。
> - **正式执行（REM-8/9）**：**不伪装人类**（唤醒消息与任务输入 author_type='system'+
>   author_id=`reminder:{id}`；原实现插 author_type='human' 假冒用户发言却返回 dispatched）；
>   未授权=awaiting_confirmation+唤醒消息（DEV-21-M3 模板携带 occurrenceId/scheduledAt/
>   timezone/missedCount/sourceRef/预算/授权——消息与输入同源）→**正式确认入口**
>   reminder.confirm（确认时刻重查授权+预算；mine.pending reminderAwaits=待我处理可行动项；
>   renderer 确认按钮）；已授权=直接正式派发（DIRECT 只唤醒 owner）；**turnInput 根作者
>   扩展**（isAcceptableRootAuthor：human 或 system+reminder: 前缀——原组装拒绝非 human
>   根消息=提醒任务永远无法执行的产品缺口）；本地协议+fake 正式链验证：创建→到点→获准/
>   确认→恰一次执行（run SUCCEEDED+回复落目标会话+输入=模板体）→停止/重启可解释
>   （reminderFormalChain 4/4）。
> - **管理入口（REM-10）**：侧栏「提醒管理」面板（列表：计划/时区/预算/下次触发/状态+
>   暂停原因/最近 5 条 occurrence 历史；操作：编辑（once/daily/weekly+任意分钟+时区+
>   自动执行开关，revision CAS）/贪睡 1 天/取消/恢复（paused 显式继续——错过的批不补跑，
>   授权类暂停下次触发重查再判））；REM 页面会话 8/8（⏰ 创建→改 once 近未来→到点→待我
>   处理确认→执行回复落会话→面板 dispatched 历史→贪睡/取消→零真实调用→停机事实）。
> - **通知如实（REM-11）**：通知面=会话内系统消息+待我处理入口（**应用内**——不接桌面
>   系统通知，帮助文案如实声明）；状态未变无行动项安静；唤醒消息确定性 id 幂等=送达失败
>   不导致重复执行（执行按 occurrence 一次性）。
> - **daemon.stop**：第一步 reminderScheduler.close()+clearInterval（原只停普通 tick——
>   提醒定时器可能在收拢/关库后继续跑）；单实例调度器（原每 tick new）。
> - 迁移 027（reminders 增 auto_dispatch/last_fired_at；occurrence 增 task_id/confirmed_at
>   ——表 001 预埋，只 ALTER）；批次脚本 callsDetail 列名修正（request_model 不存在→
>   model AS request_model——022 实为 model 列；上轮 finally 静默吞错=callsDetail 恒 null）。
> - 测试：本地全量 **671/671**（+reminderScheduler 重写 20+reminderFormalChain 4；首跑
>   1 失败=processProbe 周期快照断言复跑两轮全过，如实登记）；**桌面完整基线 65/65**；
>   E18 17/17。
> - 下轮顺序：①DEV-18 关注/搜索/收藏（既定首版范围——不扩大完成声明）；②DEV-23 收尾
>   （桌面系统通知如需接入须实证送达/点击定位/失败反馈；真实 deepseek-flash 小批次仅在
>   有明确新认证目标时建立——不重跑 r20-dm）；③冻结序列在新 build 重取三连基线。
> - 坑（第二十四轮）：CDP 读取必须先查 error（readStrict——语法错误≠空 DOM）；验证器驱动
>   的窗口可能被遮挡（Electron occlusion→document.hidden=true）——测前台语义须显式固定；
>   网关 run() 内领域错被包装 STORAGE_UNAVAILABLE（前置只读校验移出去保错误码）；turnInput
>   根消息查询列清单要与校验字段同步（author_id 漏选=恒 undefined）；SQL 别名 AS 要对齐
>   真实列名（real_calls 是 model 不是 request_model）；整轮回归过的会话（A）改了共享
>   合同（task.review 必填参数）后必须同步**所有**调用方（renderer 房间链漏改=下轮全序列
>   才暴露）。

---

## （上一轮快照，2026-09-30 第二十三轮）

> 本轮=**runtime 路径回归修复**（executable 穿透：resolveMemberRuntime 返回实际可执行路径+
> adapterFor 传工厂（缓存键含路径）+resolveClaudeExecutable 显式路径一律按绑定执行**不静默
> 回落全局**（Windows 非 .exe 静默换默认的坑）；memberExecutablePath 3/3——本地协议 shim
> 零真实调用证明绑定 A 执行 A/切 B 执行 B/无效路径明确失败）+**DEV-18 补齐**（后端：
> thread.markRead（001 预埋 thread_read_states——曾误建 026 撞表，已改对齐既有列）+房间主池
> 线程未读聚合；deepLink #task/#delivery/#msg 全分支统一 audience（他人 DM 任何形态不可达）；
> mine.pending 不泄露（他人 DM 任务/未读/标题过滤）+blockedTasks 如实列出（可见≠审批）+
> 无 pending 交付=actionable:false（不因聚合成为可批准对象）；task.review **manifestHash
> 三重绑定**+DM audience；renderer：renderDm 每次 await 后三元组+代次核对（A→B→A）+视口
> 贴底标读（后台窗口/滚看历史不推进水位）+滚动位置保留；renderThread 线程标读；
> hashchange/popstate 统一导航（跨项目=deepLink.rootPath→project.open 切换来源项目——
> canonicalPath 比对）；待我处理全量渲染（无截断/总数头/条目带四重身份+来源项目/进入定位
> 对应交付）；dev18ReadPending 11/11）+**页面验收 E18**（新 build 零真实调用；两段式：
> 段 1=两线程未读/读 A 不影响 B/同会话多待验收/A→B→A/后台不标读+前台贴底清——7/7；段 2=
> 13+ 可达/错 hash 拒/重复验收拒/跨项目深链/刷新/前进后退/他人 DM 拒/零 real_calls——
> 结果见下）+**证据收口**（真实批次 journal 可追回：pid 级「重启共享额度」原始证明——
> 前 3 次 pid=15328/第 4 次 pid=64208；补充材料 real-batches/r20-dm-ledger-real-supplement.md
> （不可追回项如实注明：real_calls 明细/响应自报模型/正文——成功清理规则所致，登记为证据
> 缺口不默认等于请求模型）；批次脚本改清理前抓取 callsDetail/identities；冻结口径纠正
> **28/28**（上轮误报 29/29——report.json 恒 28 项）；全量首跑失败真身=githubSandbox「pull
> 快进」顺序依赖真实仓状态（writeFileSync 前 test/ 目录未建→稳定 ENOENT），已修自包含）+
> **DEV-23 首包**（026 增列（表 001 预埋——同坑二次避开：reminders/occurrences 全在 001，
> ALTER 加 title/paused_reason/owner_user/created_at/updated_at/fired_at/outcome/
> missed_count）；ReminderScheduler：occurrence (id,scheduledAt) 唯一+CAS 领取+并发/重启不
> 重复、休眠错过合并为一个触发（merged+missedCount 不逐次补跑）、触发时重查（会话归档/
> 任务停止/owner 移出→paused+suppressed，恢复不自动补）、预算拒绝（budget-exceeded 不派发
> 不冒充成功）、computeNextAt 服务端 UTC 化（ICU 步进匹配——不依赖模型）、时钟注入假时钟；
> 命令面 reminder.schedule/snooze/update/cancel/list（revision CAS）；entry 15s 接线
> （ZS_REMINDER_DISABLED 可关）；renderer 最小入口（DM 头部⏰每日提醒）；reminderScheduler
> 8/8——假时钟驱动 once/daily/时区/唯一键/重启/合并/停止竞态/预算拒绝/命令面）。
> - 测试：本地全量 **655/655**（+8 reminderScheduler+1 memberExecutablePath+4 dev18 补齐）；
> dev18ReadPending 11/11；E18 段 1 7/7；githubSandbox 网络抖动（TLS SEC_E）复跑通过如实登记。
> - **E18 结果（十一轮迭代后如实）**：段 1 **7/7 连续四次稳定全过**（两线程未读/读 A 不
>   影响 B/同会话多待验收全列/A→B→A 代次/后台 hidden 不标读/前台贴底清/停机事实）；段 2
>   4/6——错 hash 拒绝+重复验收拒绝 PASS、13 项待办渲染与跨项目深链切换**两项遗留**（现象
>   稳定复现、根因未定：13 项=waitFor 判定通过后瞬时读取为空【fragment 原子替换已做仍未
>   解——疑 mine.pending 二轮竞态】；跨项目=页面错误文本为空【deepLink.resolve 未抛——
>   疑 hashchange/loadProject 完成路径】；runId qzvf0h 现场保留）。前序失败均为验证器缺
>   陷逐修（计数挤爆/A→B→A 索引反/hidden 时序反/026 撞表致 daemon 拒启/heredoc 转义）。
> - 下轮顺序：①E18 段 2 两项遗留定位收口（活体诊断法已验证有效——同 appData 起实例直查
>   DOM）；②DEV-18 页面层剩余（关注/搜索/收藏仍保留）；③DEV-23 页面闭环（提醒管理页/
>   通知面）与真实通知；④冻结产物序列在新 build 重取基线。
> - 坑（第二十三轮）：001 预埋表清单要先进 grep（thread_read_states/reminders/
> reminder_occurrences 全在 001——026 两次撞表教训）；mine.pending/页面渲染的瞬时读用
> waitFor 稳定条件；E18 失败现场按 runId 自动留档（截图/进程/stderr 全保存）定位极快。

---

## （上一轮快照，2026-09-30 第二十二轮）

> 本轮=**C/A 间歇根因闭环**（早到点击静默丢失：CDP target 出现≠页面可操作——onclick 未绑定期
> 点击被丢弃；修=open-folder 初始 disabled+`window.__zsReady` 标志+验证器 waitInteractive；
> 另修**管道名形态**：裸名 daemon listen 自动补 `\\.\pipe\` 而 UI connect 不补=永远连不上）+
> 验证器重写（runId 目录留档=stderr 时间戳/截图/进程清单/元数据，报告永不覆盖；ZS_VDR_FROZEN=1
> 冻结产物逐文件 SHA256 核对复用——**同一产物连续三次完整 A→B1→B2→C+D 全绿**：首跑 nji19t
> 27/28（验证器探活时机缺陷，产品行为正确）→修复后 szzu9n/evqq6p/cur0jt 三连 **28/28**（每轮
> results 恒 28 项——上轮汇报"29/29"为口径错误，本轮据 report.json 核实纠正）+D 同步点
> 真窗口（D1=真正 listen 之前延迟（beginStartup 重构）；D2=daemon 侧响应延迟钩子+ZS_DAEMON_
> LOG_COMMANDS 按**实发 commandId** 核对回执恰 1（contextBridge 只读——页面 patch 不可行）；
> D3=ZS_UI_SHUTDOWN_DELAY_MS 受控退出延迟+新旧实例共存探活）+HARNESS 零真实调用自检 12/12
> （fetch/WS/evalJs 死循环全截止、exitWithGuard 已退出 child、三同步点时间线因果）+
> **abort 语义修复**（readyAbort 认证后移除监听——关停不再销毁已建立连接=不再被迫强杀）+
> DM 收口（统一解析层 resolveMemberRuntime：kind/model/installation/**permissionMode**/cwd 一
> 份事实，worker 与 adapterFor 同源；身份冲突 observedSessionIds——init=Y/result=X/resume=X
> 不冒充续接+dm.sessionIdentityConflict；settle 失败明确重试 retryFailedDmSettlements+重启收案
> recoverAbandonedDmVerdicts+取消路径释放 pending；**generation 撞键修复**（结算失败轮行缺
> 失→计数退化→唯一键冲突——代次=行数+在途未结算数））+批次脚本收口（spawn 引用+正式停止链+
> 演练同款断言去 rehearsal||+B 独立性=身份+输入水位+输出归属+报告分列 r20-dm-ledger-{mode}+
> 崩溃注入 a2mid 验证即停与收拢）+**DEV-18 首包落地**（markRead commandId 幂等+未来水位拒绝+
> UPSERT 房间首标+固定目标防 A 迟到标 B；mine.pending 权威汇总——同会话多 REVIEW 逐任务不漏+
> 交付绑定 deliveryId/revision/manifestHash（pending 优先/最新回退/null 如实）+DM 未读；
> deepLink.resolve dm/task/delivery/msg 真实归属+矛盾明确报错；renderer 待我处理区+通用深链+
> 导航代次防护——全部纯读零新增运行）。
> - **真实批次 r20-dm 已执行：17/17 全部通过**（A1 暗号回流+真实 provider 身份持久→A2 原生
> 续接（resume 请求=上报，真实 UUID 一致）→B 独立（身份互不相同+输入水位属 B+回复落 B+不含
> A 暗号）→重启 A3 resumed=2；startTurn 恰 4 次全 succeeded、护栏 reserved=4 未触 cap=8、双
> daemon 优雅退出 exit 0；台账 real-batches/r20-dm-ledger-real.json）。
> - 测试：本地全量 **640/640**（+7 dev18ReadPending；首跑 1 失败复跑两次未复现——第二十三轮
>   定位真身=githubSandbox「pull 快进」用例顺序依赖真实仓状态（writeFileSync 前 test/ 目录
>   未建→稳定 ENOENT），已修为自包含 mkdir——失败记录不因后续通过而抹除）；dmDirect 19/19；
>   claudeResumeFacts 4/4；
> 批次演练 15/15+崩溃注入即停收拢验证；全量首跑 1 失败复跑两次未复现（偶发，如实登记）。
> - 下轮顺序：①DEV-18 首包 renderer 层验证（页面待我处理区/深链/阅读水位实测——本轮 daemon
> 层 7/7 已过，页面层 e2e 待做）；②DEV-23 提醒首版；关注/搜索/收藏仍为 DEV-18 剩余项（不扩大
> 完成声明）。
> - 坑（第二十二轮）：contextBridge 注入对象只读（页面 patch 不可行——用 daemon 命令日志钩子
> 取实发 commandId）；node `replaceAll` 不支持字符类正则语法；CDP target 出现≠load 完成；
> SQL SUM 空集=null；冻结复用模式下验证器自身改动不影响冻结核对（核对的是产物文件）。

---

## （上一轮快照，2026-09-30 第二十一轮）

> 本轮=renderer 无反馈挂起根因修复（IPC handler 先注册+去 alert 阻塞+第十九轮静默丢失的
> dm-create 成员选择器/dm-review 按钮绑定补齐；B2/C 从"验证器内打不开项目"到全链通过）
> +DM 续接身份链终态结算制（空 ID 回填/空串不作候选/openSession 返回≠接受/按安装身份/
> Claude 真实时序 fixture 6/6）。本地 dmDirect 15/15。
> - **独立机回传已归档通过**（第十八轮：bld_c2f364d06ff0014e，daemon 11/11+renderer 9/9+
>   人工 6/6；docs/implementation/evidence/bld_c2f364d06ff0014e/）——**不再等待用户操作**，
>   旧包不作废声明、用户无需再跑旧包；新包=新 buildId。
> - renderer 验证器：ZS_VDR_SESSIONS 会话选择（单独 B2/C 与完整序列分别出报告）；会话 D=
>   受控同步点（daemon 延迟就绪/首命令延迟/上一实例退出延迟）。
> - 下一步：①最小真实 DM 批次（deepseek：A 首轮→A 续接→B 独立→重启续接；经第十九轮
>   fail-closed 护栏记账；身份/协议/预算问题即停）；②DEV-18（待我处理/阅读水位/未读/深链
>   正式闭环——房间/线程/私信+交付版本）；③DEV-23 提醒首版。
> - 坑（第二十轮）：python 文本替换必须 assert 命中（第十九轮两处静默 MISS=按钮无绑定/
>   prompt 残留，验证器 C 卡两轮）；两个验证器实例并发会互相 rebuild/抢端口——自造失败。

---

## （上一轮快照，2026-09-30 第十九轮）


> （历史快照——独立机已于第十八轮回传归档通过，「等待回传」不再有效）
> 本轮=独立交付包重构（最终包 buildId bld_c2f364d06ff0014e/commit 0b99979 clean，开发机自测
> daemon 11/11+renderer 9/9+故障 2 路径）+**真实派发硬隔离 ZS_REAL_DISPATCH_GUARD**（R15 事故
> 收口：spawn 前拒绝真实 runtime；配置读写不受影响；生产不设=正常）+成员启停设置（协作参与
> 闭环）。本地 565/565、零真实调用。**旧独立包作废——用户复制 dist/desktop/独立交付/ 本版**。
> - 协作限制/文件修改策略**均无后端命令**（前快照「后端就绪」有误已修正：单写者硬编码+只读档
>   硬编码）——需设计先行；本轮真实闭环=member.setEnabled（含 UI/校验/持久化）。
> - 坑：run() 内抛领域错被幂等网关包装成 STORAGE_UNAVAILABLE（校验移事务外）；主池 ORDER BY
>   created_at DESC=最新在前（等新卡按数量增加判定）；task.get 增 lastStartupFailureMessage→
>   UI 状态行显示启动失败原因。
> - 下一步：①等待用户回传独立包结果（不阻塞）；②协作限制/文件修改策略设计任务书；③后续真实
>   批次改 **startTurn 级计数**（deepseek-flash 持续授权内自行立批）；④交付矩阵依赖已满足项。

---

## （上一轮快照，2026-09-30 第十五轮）

> 本轮=便携 renderer 真实用户链路验收（17/17）+启动/停机修正（verify-desktop 9/9）+设置交付组
> （成员 runtime 绑定真实闭环）+真实批次 R15（正常链+停止链全过）+独立 Windows 交付材料。
> 授权更新：**Claude Code+deepseek-flash 持续授权**（用户原话「批准，deepseek 的预算很多，可以
> 随意使用」——仅该渠道；旧价值批次 30/33 原样不追改；逐批写目标/上限/停止条件）；**用户有另一台
> Windows 机**——独立交付已备（dist/desktop/独立交付/：MANIFEST+自足 verify-local（开发机自测
> 8/8）+一页说明），待用户回传结果。
> - 数字：本地 562/562（60 文件，githubSandbox 未重跑——远端链未动）；verify-desktop-renderer
>   17/17；verify-desktop 9/9；real-batch-r15 11/11；independent verify-local 8/8；lint/tsc 0。
> - **renderer 验收**：CDP 真实页面操作全链（任务提交/验收经按钮——main 演示仅作宿主 smoke）；
>   残留检测控制组=decoy 先证检测有效；leftover 修正=QUERY-OK 尾标（失败≠0）+排除自身+任意名载体。
> - **停机事实**：desktop-shutdown.json（送达/退出码/超时/强制/未确认/stopRecord）+daemon 尾行
>   stop-result；window-all-closed 先发命令再关管道（否则 requestDelivered 恒 false）。
> - **设置组**：成员 runtime 绑定（读 member.runtime/写 member.setRuntime/校验/失败提示/能力分列/
>   重开保持）；既有=任务验收开关、仓库状态显隐。未接 UI 但后端就绪=协作限制/文件修改策略（下一批）。
> - **真实批次 R15**（台账 docs/implementation/real-batches/r15-ledger.json，脚本硬顶 2 次先记后发）：
>   ①正常链 DONE（受管 job+资源回收+暗号回流+deepseek-flash $0.039）②停止链（RUNNING→task.stop→
>   CANCELLED+零交付+进程收拢）。**事故记账**：renderer 首版 2 笔真实 turn（绑定持久化未隔离——
>   $0.145）；已修复：fake 场景前置/绑定后不发送/停止场景独立 appData。教训=默认验收与真实入口必须隔离。
> - **坑**：contextBridge 对象不可 monkey-patch（CDP tap 无效→全 DOM 信号驱动）；PS -File 参数含空格/
>   中文被拆（pattern 走环境变量）；electron 池卡片第一张=最旧任务（点最新）；并发单例拒绝的退出可能
>   发生在等待 listening 期间（runDaemon 内挂 exit 监听才不丢事实）。

## 当前下一步（历史·第十五轮——已被上方第二十轮快照取代）

1. **无需等待直接开工**：设置页下一组（协作限制/文件修改策略——先补后端命令面）；交付矩阵依赖已
   满足项；真实能力补证（持续授权内按批次台账执行——受管链已过，可扩至依赖已满足且有明确验收
   目标的项：如真实 push 前置检查/git 只读链）。
2. ~~**等待用户**：独立 Windows 环境回传~~（**已完成**：第十八轮归档通过——证据
   docs/implementation/evidence/bld_c2f364d06ff0014e/，用户无需再跑旧包）。
3. **价值评价（用户决定暂缓）**：不放回待办；旧批次剩余 3 次不动用；真实 lateEvents=unsupported；
   写档入口关闭；并行写入延期。

---

## （上一轮快照，2026-09-30 第十四轮）

> 本轮主线=环境块纠正（一）→jobId 正式绑定（二）→打包验收 v2（三）→DEV-15 桌面便携产物（四）→merge 多父 diff（五）。
> 提交：9caa4c3→118effc→262ffa2→dc9e1d9→bb12344→文档组。数字：本地套件 **562/562**（60 文件，
> 排除 githubSandbox 5 例——远端链未动未重跑，最近全绿=十二轮 5/5）；verify-pack **17/17**、
> verify-desktop **6/6**、g3 fake 回归 1/1；零模型调用、零真实认证。
> - **环境（9caa4c3）**：第十三轮「非空块恒 87=koffi 缺陷」**撤回**——根因=缺
>   CREATE_UNICODE_ENVIRONMENT（UTF-16 块被按 ANSI 解释）。规范块（大小写不敏感去重/排序/双
>   NUL/undefined=删除）+真实子进程回读全过；「关闭受管开关绕行」建议已删。
> - **jobId 绑定（118effc）**：迁移 020（managed_job_id 正式列）；登记/adapter 契约
>   （AdapterProcessIdentity.managedJobId）；probe/reconcile/releaseProtection 按 jobId 查找核对
>   （PID 仅辅助——复用/错位/他人 job 拒绝）；retireManagedJob 收尾闸门（per-turn=终态/证据
>   消费后；shared=daemon stop；有共享 open 登记保留）；桥轮询定时器实际 clearInterval+
>   pidIndex 复用守卫+close 时释放根句柄（生产证据链无需手动放句柄）。managedIdentity 3 用例
>   （worker 全链/复用反例/shared+stop）。
> - **打包 v2（262ffa2）**：假通过修复（严格退出码/nmOverride/负例 SQLite 佐证/koffi 版本实际
>   解析）；**daemon.shutdown IPC 正式停机命令**（打包验证与 UI 宿主同路径）；bundle 内受管全链
>   （claude 成员绑定 .cmd shim fixture→受管真实进程 turn DONE→task.stop→CANCELLED→截止
>   UNKNOWN→reconcile/probe/releaseProtection→shutdown 退出 0→无遗留）。顺带修 3 产品缺陷：
>   esbuild cjs import.meta.url=undefined（createRequire 双形态锚定）/管道裸名 EACCES（统一
>   \\.\pipe\ 前缀）/probe 受管观察 rootExited 句柄释放后误报（生命周期备忘优先）。
> - **桌面便携产物（dc9e1d9）**：dist/desktop/众说-便携-win-x64（Electron 全量+resources/app+
>   随包 node.exe——daemon 不依赖开发 PATH；受管默认开=缺失即明确失败 exit 1）。UI main 布局
>   判定（app.isPackaged 在便携 exe 未改名时不可用）；优雅停机（shutdown→有界等待→kill 兜底）。
>   verify-desktop 6/6（首启/正常退出/重复启动/移除断言/负例/无残留）。未验=安装器/签名/独立
>   Windows 机。
> - **多父 diff（bb12344）**：git.commitDiff 增 parentOid——多父未选=parentsMeta+注记；选定=必须
>   本提交的父（跨对象拒）→diff-tree 两树（差异=相对该父实际变更）；UI 父选择行绑定 OID。

## 当前下一步（唯一·第十四轮）

1. **无需等待直接开工**：设置页剩余真实项（协作限制/文件修改策略——先补后端命令面；多父
   diff UI 视觉走查可并入下一 UI 批）；**受管实战补证方案已成文**（round-20260930-round14 §7
   ——两次各 1 turn 上限+停止条件，**待用户批准后执行**）；DEV-15 剩余（安装器/签名/独立
   Windows 机验证——见报告四「未验证」节）；koffi 上游无需跟踪（缺陷结论已撤回）。
2. **价值评价（用户决定暂缓）**：不放回用户待办。
3. **补证（另批）**：真实 CLI 实战按 §7 方案逐次执行；剩余 3 次真实调用额度不动用；
   真实 lateEvents 维持 unsupported；写档入口维持关闭；并行写入维持延期。

---

## （上一轮快照，2026-09-29 第十三轮）

> 本轮主线=受管桥完整化（一）→恢复证据正式链（二）→push 目的地绑定（三）→DEV-15 早期打包（四）。
> 提交：736dddc→1aec264→3635a38→58374bf→文档组。数字：563/563 全量（含 githubSandbox；
> TLS 偶发=环境敏感单跑即过）+managedBridge 6/6+pack 4/4；零模型调用。
> - **桥（1aec264）**：stdin EOF（final→endStdin；EOF-consumer fixture）；**句柄继承修复**
>   （SetHandleInformation 清父侧——否则子进程持自己的 stdin 写端，EOF 永不到来）；字节流输出
>   （1MB 背压+终拍 push(null)+close=排空判定非固定延迟）；koffi 异步写=fn.async 形态（事件循环
>   不挂死）；argv=MSVCRT 约定逐位回读；**环境实证边界**：koffi CreateProcessW 非空 lpEnvironment
>   恒 87（A 变体有效/原生块亦 87）=FFI 缺陷——支持=继承父环境，真实覆盖显式报错。〔十四轮已撤回：根因=缺 CREATE_UNICODE_ENVIRONMENT〕
> - **证据正式链**：lifecycle 分立（rootExited/stdioClosed/evidenceReleased/consumed/finalized）；
>   根退出后保留可查询 job（close≠证据消失）；jobId 稳定身份；正式链验收=spawn→登记 managed-job
>   →UNKNOWN→probe→releaseProtection（managed-job-evidence）→租约解除→排队任务可继续→重复幂等。
> - **push 目的地（3635a38）**：pushUrl=get-url --push --all（pushurl 优先；多目的地拒）；
>   insteadOf/pushInsteadOf 改写拒绝（get-url 不在改写生效面——实证）；远端头核对走显式 URL
>   ls-remote（经远端名会读 fetch URL——核对同源修复）。
> - **打包（58374bf）**：daemon.cjs（esbuild）+verify-pack 4/4——中文+空格安装目录/clean env
>   启动；sqlite+koffi（@koromix 平台包带出）可加载；精确移除 koffi=拒绝启动不降级。
> - **flake 归因修复（736dddc）**：supervisor 两项满载失败=测试等待条件不可靠（sleep 竞态）→
>   grandson.pid 就绪信号+waitAlive 轮询+快照 ack；原失败组合全量 563/563。
> - **四层证据**：底层模块/本地正式链/打包产物三层已验；**真实 CLI 层未验证**（受管 claude/codex
>   实战、真实 lateEvents）——归补证窗口。

## 当前下一步（唯一·第十三轮）

1. **无需等待直接开工**：merge 多父 diff 视图+设置页剩余真实项（本轮未动——如实列首项）；
   受管 Claude Code + deepseek-flash 最小补证方案成文（逐次目的/停止条件——本地收口已具备，
   方案待用户过目后执行）；DEV-15 主体（Electron 壳/安装器/资源目录策略）；koffi env 缺陷
   上游跟踪。
2. **价值评价（用户决定暂缓）**：不放回用户待办。
3. **补证（另批）**：受管 runtime 实战/真实 lateEvents/崩溃现场取证——优先 Claude Code+
   deepseek-flash 单独列目标与上限；剩余 3 次不动用。

---

## （上一轮快照，2026-09-29 第十二轮）

> 本轮主线=Git 执行对象收口（一至四）→REC-LIFE-1 正式实施→真实 GitHub 补证（新授权）。
> - **已实现+本地已验（第十二轮）**：提交绑定显式 refs/heads（同 OID 切分支竞态反例——未批准
>   分支绝不动）；push 推不可变 OID refspec+目的地三重绑定+force-with-lease 严格旧头+输出脱敏；
>   pull 合入固化 OID；commit.undo 弃 reset --mixed 改 ref 级 CAS 软回退（索引/工作区零接触，
>   A/B fixture 无损证明；重叠/merge/崩溃重试三态）；hooks/gpgsign 检测阻塞（不静默绕过）。
>   REC-LIFE-1：koffi Job Object（挂起纳管窗口为零/KILL_ON_JOB_CLOSE 兜底/releaseEvidence
>   句柄语义/纳管失败不降级）；adapter spawnFn 注入（边界不感知）+迁移 019 managed-job +
>   releaseProtection 受管证据分支；ZS_MANAGED_RUNTIME=1 启用（未设=第九轮保守口径）。
>   真实 GitHub：授权沙盒仓 384615666/zhongshuo-git-e2e-sandbox（私有），5/5（命令链/并发反例/
>   ff pull/test/* 分支——全部经众说正式命令）。
> - **未完整确认**：受管路径的真实 CLI（claude/codex）实战未认证（fixture 全绿；真实调用归
>   补证窗口）；electron-builder 打包含 koffi 的可加载性待 DEV-15 首次打包。
> - **真实 unsupported/未验证**：真实 CLI lateEvents；崩溃现场进程树取证；研讨轮迟到收口语义。

- 提交：`727c835`（Git 一至四）→`4fb450e`（REC-LIFE-1）→文档组。数字：550/552（2 个 supervisor
  满载时序 flake 隔离 11/11）+managedLifecycle 9/9+githubSandbox 5/5+e2e 30+3skip+lint 0+tsc 0，
  零模型调用。报告：reports/round-20260929-round12-git-binding-rec-life1-github.md。
- GitHub 沙盒：owner=384615666，name=zhongshuo-git-e2e-sandbox，URL
  https://github.com/384615666/zhongshuo-git-e2e-sandbox.git，main 基线 1d78626；test/* 分支保留
  供复核；清理待指令（不自动删）。github.com 偶发 TLS 握手失败=环境敏感（单用例重跑即过）。

## 当前下一步（唯一·第十二轮）

1. **无需等待直接开工**：设置页其余真实项（协作限制/文件修改策略——先补后端命令面）；
   merge 提交多父 diff 视图；受管路径真实 CLI 补证（ZS_MANAGED_RUNTIME=1 × claude/codex，
   归真实调用窗口）与 DEV-15 打包可加载性；研讨轮迟到收口语义定义后实施。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/受管 runtime 实战——优先
   Claude Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第十一轮）

> 恢复与修复链按能力分列口径不变；本轮主线=Git 写操作收口（内容绑定/归属保护/互斥与恢复）+RT-24 剩余。
> - **已实现+本地已验（第十一轮新增）**：提交内容绑定（索引 tree+commit-tree+update-ref CAS、
>   预览一致快照、目标分支绑定、提交后核对含外部竞态 consistent:false 不回滚）；仓库级写互斥
>   （同工作树两项目不绕过、undo 双向协调、目录身份失败拒绝）；stageTask 双向保护（after 冻结
>   核对/多集定型序裁决/链式归属/撤销与跨项目门）；持久意图与崩溃重试（迁移 017；stage 遇新内容
>   拒同号/commit 三态裁决/同号异参数全分支拒绝）；RT-24 剩余（迁移 018：branch/checkout 不自动
>   stash、commitDiff 关联、push/pull 两端头绑定+快进 only+AUTH 语义、conflict 三方+手动解决、
>   commit.undo 软回退）。
> - **未完整确认（工程欠项）**：有子进程 runtime 自动解除路径仍关闭——REC-LIFE-1 已出实施排期
>   （rec-life-1-plan.md：原生依赖/挂起纳管/句柄差异/崩溃事实/失败拒绝五点落实），Git 收口后独立成批。
> - **真实 unsupported/未验证**：push/pull 真实远端凭据路径（本地 bare remote 验证）；真实 CLI
>   lateEvents；崩溃现场进程树取证；研讨轮迟到收口语义。

- **一（内容绑定+保护）**：indexDigest（XY/path 摘要）→ **indexTree（write-tree 内容身份）**；
  执行链=write-tree 复核→commit-tree（预览 tree 直接构造）→update-ref HEAD CAS（旧值期望）；
  空仓库 unborn=ZERO 期望、detached 拒绝；CAS 后外部推进→consistent:false+headAfterActual、
  不把别人 HEAD 记为本次、审计留痕人工核对；反例=暂存 A→预览→暂存 B 拒绝+HEAD 不变、同 HEAD
  切分支拒绝、_between 注入竞态被超越。互斥=工作树身份键串行（6 并发深度≤1）+两项目同树+undo
  双向协调+PROJECT_MISSING 拒绝。**坑**：锁不可重入——嵌套持锁死锁，预览拆持锁包装+内部快照。
- **二（批量暂存双向保护+意图）**：after 冻结核对三反例（改产出/改新增/重建删除）零进索引；
  多集按 rowid 定型序裁决+multiSet 注记+链式归属（基线 dirty=更早定型集 after→任务链不误判）；
  reverted 跳过/partial 与撤销未收口冲突/跨项目拒；pending 意图（017）+重试裁决（stage 新内容
  拒同号——MM 断言/unstage 幂等/commit HEAD 未动续跑·尾标记恢复·外部推进人工核对/无行窗口保留
  尾标记/同号异参数全分支拒）。
- **三（RT-24 剩余，018）**：branch.list/create/checkout（HEAD+分支绑定、不自动 stash 改动随行
  计数）；commitDiff（parents/关联仅操作日志、merge 注记、diff-tree --no-commit-id）；remoteHead/
  push/pull（两端头绑定、快进 only、推送后核对、崩溃重试按远端既成事实、AUTH 语义不改配置不回显
  凭据、分叉拒）；conflict.content/resolve（三方查看+手动内容，无一键覆盖）；commit.undo（mixed
  软回退、仅当前 HEAD、根提交/detached 拒）。UI：分支/远端/冲突/历史 diff+撤销入口。
- 四（REC-LIFE-1 排期）：rec-life-1-plan.md——五点落实（N-API/prebuildify+DEV-15 ABI；CREATE_
  SUSPENDED 挂起纳管窗口为零；per-turn/shared 句柄差异+registry 归属标记；KILL_ON_JOB_CLOSE+
  重启对账；纳管失败拒派发不降级）；普通进程组≠Job Object 跨平台等价，矩阵按平台分列。
- 数字：**539/539**、e2e **30+3skip**、lint 0、tsc 0、零真实调用（未跑 real*；跨进程预算护栏未
  受影响未重跑）。报告：reports/round-20260929-round11-git-binding-rt24.md。上轮 55 次偏差记录
  独立保留。

## 当前下一步（唯一·第十一轮）

1. **无需等待直接开工**：REC-LIFE-1 实施批（排期已定：spike→实现→ADR §3 六条验收→矩阵分列，
   零真实调用）；设置页其余真实项按任务书逐项（协作限制/文件修改策略——先补后端命令面）；
   研讨轮迟到收口语义定义后实施；merge 提交多父 diff 视图（列项，不虚构）。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/push 真实远端凭据路径/文件发现真实
   有效性——优先 Claude Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第十轮）

> 恢复与修复链继续按能力分列（口径不变，不写「已收口稳定」总括）：
> - **已实现+本地已验（第十轮新增）**：Git 只读协议重写（raw/numstat -z 机器身份、字面
>   pathspec、采集期容量控制、未跟踪内容视图、外部 diff/textconv 不执行-标记程序反例）；
>   Git 写闭环（stage/unstage/stageTask 跳过 userPreExisting、commitPreview/commit 预览绑定
>   +尾标记崩溃恢复、history 任务关联、git_operations 日志、租约/冲突/身份/范围四类前置）；
>   项目验收开关（CAS+持久化+仅影响新任务）与正式验收/返工 e2e 闭环（不经补库）；返工
>   第二轮交付守卫修正（按 run 创建先后判定）。
> - **未完整确认（工程欠项，ADR-0010 已立）**：有子进程 runtime 的自动解除路径仍**关闭**——
>   Job Object 首选候选已评估（归属/解除/回退/验收六条），承载 DEV-05 子项 REC-LIFE-1，不阻塞。
> - **真实 unsupported/未验证**：真实 CLI lateEvents 未实现（泵如实 unsupported）；真实 CLI
>   崩溃现场进程树取证/文件发现真实有效性归补证窗口；研讨轮 UNKNOWN 迟到收口语义待定义。

- **一（只读协议）**：文件身份全部走机器格式（`--raw -z` 重命名**先旧后新**/`--numstat -z`
  二进制 `-`、重命名=计数后空路径+旧/新两条——od 实测），删除 diff 头正则；查询固定
  `GIT_LITERAL_PATHSPECS=1`+`--no-textconv --no-ext-diff`；容量在采集阶段控制（超限 SIGKILL：
  单文件 64KB/整体 512KB/文件数 50/status 256KB）；numstat 失败→stat=unknown 不冒充文本；
  未跟踪文件按新增语义读内容；子目录项目显式返回工作树根+项目外条目标注。gitProtocol 9/9
  （含标记程序反例：控制组普通 git diff 确实执行驱动，正式命令不执行）。平台事实：NTFS 禁
  `"`/`*`/TAB 文件名（实测），fixture 覆盖 Windows 允许的全部特殊字符。
- **二（写闭环）**：迁移 016 git_operations（id=commandId）。批量暂存分区=纳入任务改动/
  跳过 userPreExisting（基线 porcelain -z dirtyPaths，第十轮起入 manifest）/混合文件=冲突
  不自动分离；旧捕获回退=before 前像 sha vs HEAD blob 逐文件核对。提交=预览绑定
  expectedHead+expectedIndexDigest（变化即拒绝）；`Zhongshuo-Command-Id` 尾标记——崩溃窗口
  （git 已提交、回执/日志未落库）按尾标记+父提交核对既成事实恢复，不重复 commit；重试链=
  回执重放→日志重放→尾标记→执行。前置=租约（执行保护中拒绝写）/冲突（U*/AA/DD）/身份
  （缺失如实报错不代改配置）/范围（子目录项目外路径拒绝）。提交不改 application_status/
  验收状态；history 关联仅来自操作日志（外部提交不虚构归属）。gitWrite 9/9+e2e 写操作闭环。
- **三（验收开关+正式闭环）**：project.reviewPolicy.set（CAS+事件+同值 unchanged+仅影响新
  任务）；「要求修改」必填意见；UI=项目设置面板（开关真实持久化、写入并发如实显示不可点）、
  返工意见行、「追加执行」按钮（task.redispatch 正式派发链——此前 UI 无再执行入口）；
  **修复**：交付守卫「存在其他 run 交付→不交付」挡住返工第二轮——改为按 run rowid 先后
  （旧 run 迟到仍不覆盖新交付，返工新 run 正常递增 revision）。e2e 正式闭环：设置开→重开
  保持→任务→REVIEW→返工（意见记录）→追加执行→第 2 版→验收→DONE（无补库）。
- 四（ADR）：adr-managed-process-lifecycle.md——Job Object 首选（内核归属无盲区、挂失败即
  拒绝派发）/ETW 增强候选/受管启动器不成立；验收六条；承载 DEV-05 子项 REC-LIFE-1。
- 数字：**524/524**、uiE2e **29+3skip**、lint 0、tsc 0、零真实调用（未跑 real*；跨进程预算
  护栏未受影响未重跑）。报告：reports/round-20260929-round10-git-protocol-write-review.md。
  上轮 55 次意外调用偏差记录独立保留，不抵销不复证。

## 当前下一步（唯一·第十轮）

1. **无需等待直接开工**：RT-24 剩余精确列项——git.branch.create/checkout（不自动 stash+带入
   改动数）、git.push/pull（AUTH_REQUIRED、仅临时本地 bare remote）、git.conflict.resolve
   （三方+手动）、git.commit.undo（reflog 软回退）、单提交聚合 diff；项目/应用设置按任务书
   继续逐项；REC-LIFE-1（ADR-0010）排期在全功能交付验收前、实施前出任务书（不需用户重新
   拍板方向）；研讨轮迟到收口语义待定义后实施。
2. **价值评价（用户决定暂缓）**：不放回用户待办、不反复请求。
3. **补证方案（另批）**：真实 CLI lateEvents/崩溃现场取证/文件发现有效性——优先 Claude
   Code+deepseek-flash，单独列目标与实际调用上限；不动用剩余 3 次。

---

## （上一轮快照，2026-09-29 第九轮）

> 恢复与修复链**不写「已收口稳定」总括**——按能力分列（用户令第九轮五）：
> - **已实现+本地已验**：进程树观察/追加式历史身份/盲区如实（真实 node 子进程+正式命令链）；
>   迟到泵同 daemon+重启双路径（fake 持久化会话记录）；版本绑定验收+返工输入注入；
>   git.status/git.diff 只读；设置持久化（repoStatus.visible）；帮助面板（START-07/09 首版）。
> - **未完整确认（设计边界）**：有子进程 runtime 的服务端解除路径**关闭**——周期快照只产生
>   「未观察到存活后代」观察，不构成完整退出证明；受管生命周期机制（Job Object/ETW）另批评估。
> - **真实 unsupported/未验证**：真实 CLI lateEvents 未实现（泵如实 unsupported）；真实 CLI
>   崩溃现场进程树取证/文件发现真实有效性归补证窗口；研讨轮 UNKNOWN 迟到收口语义待定义。

- **一（进程树保守判定）**：probe 对 per-turn/shared **不再返回 exited**（第八轮「全树核对
  无存活=完整退出」表述撤回）；reconcile 的 exited 释放分支删除；releaseProtection 仅凭
  no-os-process（升级前 exited 记录防御性拒绝）。历史身份修复（迁移 014 追加式
  process_tree_identities：按 pid+started_at_ms 代次，从不删除未确认身份——旧 012 快照
  DELETE+INSERT 会丢父链已断的后代）。反例×2：历史身份不覆盖（后续观察只见占位仍发现孙）；
  盲区如实（两次观察之间派生+中间父退出→未完整确认，不凭空声称能发现）。测试
  processTreeSupervisor 11/11+恢复三件套按新语义改写。
- **二（迟到回执原子）**：迁移 015 重建回执表（作用域键 source_scope+turn+eventKey，
  eventKey 不假设全局唯一；outcome applied/ignored 可区分）；**回执与 applyEvent 全部效果
  同一事务**（失败整体回滚、无「有回执无效果」态、可恢复）；归属校验（不认领未归属事件）；
  **泵收口不释放写入租约**（业务结果确定≠执行载体停止——仍走 probe/releaseProtection）。
  lateOutcomePath 9/9（异常回滚→重放恰好一次/同键异 turn/错归属/响应丢失）。
- **三（验收绑定版本）**：task.review 必带 deliveryId+deliveryRevision；事务内条件更新+影响
  行数核对；冲突区分（被替代/已处理/版本不符/跨任务/事务内变化）；同 commandId 重放=原回执、
  不同命令号不重复生效。UI：task.get.pendingDelivery 展示与提交同源、按钮带版本号、新交付
  刷新新对象。返工闭环：changes_requested 说明注入后续派发输入（关联被退回版本；accepted 后
  消失）；不自动派发。dev14Commands 10/10+uiE2e（v1→v2 错稿防护）。
- **四（DEV-14 深化）**：git.diff 只读正文（暂存/未暂存、重命名/删除/二进制/超限截断、路径
  越界拒绝、不改索引/工作区）；变更详情前像可用性汇总+恢复中心未收口撤销行+「继续撤销」
  入口（changeset.undo）；app.settings.get/set（白名单 kv 持久化，重开生效）+仓库状态显隐
  开关；常驻帮助面板（发送/仅记录/DIRECT/研讨/验收/恢复/迟到/Git/未开放边界）。AUTO 按
  闸门未开放并如实标注。
- 数字：**502/502**、uiE2e **19+2skip**、lint 0、tsc 0、零真实调用（未跑 real*）。报告：
  reports/round-20260929-round9-conservative-late-review-dev14.md。

---

## （上一轮快照，2026-09-29 第八轮）

- **supervisor 进程树=全树归属分析**：单层 ParentProcessId 枚举不再是判定来源——单次
  全表 CIM 快照（行标记协议；空输出/残缺行/CIM 错误=failed，**查询失败≠空结果**）+
  现存树 BFS（父退子活/存活中派生）+**活跃期快照历史归属核对**（迁移 012：worker
  startTurn 后首拍+消费期间 5s 周拍；中间代际退出后历史父子边消失，孙进程靠快照锚点+
  创建时间时序核对——排除复用家庭、时间缺失保守计入）；exited=「根退出+现存树空+快照
  代际核对无遗留」，**无快照=unknown（未完整确认）**。三代 fixture（父→子→孙，父子先退
  孙活）经 probe/reconcile/releaseProtection 正式链全拒绝、孙结束后才放行；
  processTreeSupervisor 9/9（含 worker 生产接线用例）。能力边界如实：最后快照之后新派生
  且父链已死的深层链不可发现（能力矩阵已收窄）。
- **迟到成果正式接收路径**：`RuntimeAdapter.lateEvents?`（事件来自 adapter 正式通道=
  fake 持久化会话记录，**不是命令参数**）+`recovery.pumpLateEvents`（entry 接线
  worker.pumpLateEventsForTurn；迁移 013 eventKey 回执）。「谁继续接收」=该泵（正常消费器
  退出后的唯一入口；同 daemon 与**重启**（新实例读同一持久化记录）同实现）。applyEvent
  新守卫：重复终态（含 SUCCEEDED 交付主键保护）/停止代次（stop_generation 事实承载，
  不复活已停止任务）/refunded 冲突留痕（不自动改账，纠正走 correctToExecuted）/被替代
  run 不覆盖新交付（superseded 留痕）；幂等=eventKey 回执+终态 CAS 双层闸。lateOutcomePath
  7/7（实际派发→截止 UNKNOWN→迟到输出→正式泵→收口；含重启路径）。真实 CLI lateEvents
  未实现=泵如实 unsupported（待补证）。
- **真实测试预算护栏（机械硬上限）**：`tests/util/realCallGate.ts`——配置全必填（缺一
  open 即拒）、超限**请求前拦截**、sent/failed/timeout/uncertain 如实落**文件账本**（跨
  进程/跨文件共享额度，账本既定额度为准不得改限）；realCodex 三文件全部 startTurn 过闸
  （gatedStartTurn）；「用例数≠startTurn 次数」旧口径废除（vitest.real.e2e.config 注释
  重写）。realCallBudget 5/5（含跨进程并发子进程实跑）；testIsolation 增护栏层断言→5/5。
  环境变量门禁≠预算硬上限，分别验收。
- **DEV-14 主体起步闭环**：`git.status`（只读真实仓库数据，暂存/未暂存/未跟踪严格区分，
  保留用户未提交内容；非 git 目录明确拒绝）/`task.review`（RT-25：按创建时策略快照处理
  唯一 pending 交付；accept→DONE、changes_requested→ACTIVE；Git 提交不等同验收）/
  `runtime.status`（运行能力真实状态，未验证项如实标注）/listByTask 撤销详情增强；UI：
  主池仓库状态区块（30s 缓存）、REVIEW 验收操作（状态变更后入口收起）、恢复面帮助
  （START-07 首版最小）+运行能力小节。dev14Commands 5/5（临时 git fixture）+uiE2e 新
  2 用例（**19 过+2 skip**）。写档未认证入口保持关闭。
- 数字：集成/单元 **493/493**、UI e2e **19+2skip**、lint 0、tsc 0、本轮零真实调用
  （未运行任何 real* 测试）。报告：reports/round-20260929-supervisor-lateoutcome-dev14.md。
  上轮 55 次意外调用偏差记录独立保留，不抵销不复证。

## （第八轮下一步，已执行完毕）

1. **无需等待直接开工**：按交付矩阵推进依赖已满足的工程包——DEV-14 继续（Git diff 正文
   视图/写操作接入、设置页真实状态深化、START-07/09 完整帮助）；correctToExecuted 的
   恢复面 UI 入口可选；研讨轮迟到输出收口待定义。
2. **价值评价（暂缓中）**：恢复与修复链已稳定（本轮收口 supervisor+迟到链）——可提请
   用户集中安排一次（不重跑实验、证据保留）；DEV-11 仍不开放。
3. **补证方案（另批）**：真实 CLI lateEvents（会话文件回放）/真实崩溃现场进程树取证/
   文件发现真实有效性——优先 Claude Code+deepseek-flash，Codex 专项单独列目标预算。

---

## （上一轮快照，2026-09-29 第七轮·补）

- **上轮核账纠错（重要）**：上轮「零真实调用」声明**错误**——test:e2e 全量收集无门禁的
  realCodex*.test.ts，调试循环中实际发生 **45 会话/55 真实 turn（gpt-6-luna，token in
  4.80M/out 42K，费用=渠道账单 unknown）**；逐次登记+防复发见
  reports/round-20260929-isolation-protection-outcome.md §一。防复发已实施：fake e2e 配置
  排除 real*+独立 `npm run test:real` 入口+三文件 `ZS_REAL_E2E=1` 双层门禁+
  testIsolation.test 4/4（子进程实跑证明隔离）。不从批次剩余 3 次抵销。
- **保护收口**：`recovery.releaseProtection`（预算已处置+保护未解除的遗留租约按服务端
  取证解除——alive/unknown/复用拒绝保留；不改预算/不改写人工声明；重启可续；钩子失败
  DB 事实保持）+`recovery.correctToExecuted`（事实矛盾纠正 refunded→settled U+1，原声明
  事件叠加不改写）；protectionRelease.test 4/4 全链。
- **supervisor 进程树**：父 PID 退出**不再**单独构成完整退出证据——probe exited 追加存活
  子进程枚举（win32 CIM；有子→unknown 保留；枚举不可用→未完整确认）；pre-launch 登记
  （迁移 011：model=unknown/source=pre-launch——startTurn 前占位，崩溃窗口与「从未启动」
  区分）；processTreeSupervisor.test 4/4（真实 node 进程树，工具子 detached 构造孤儿）。
  能力矩阵新增「进程树取证能力」节（真实 CLI 崩溃现场=未验证）。
- **成果一致性八项**（outcomeConsistency.test 7/7）：**发现并修复洞**——已收口
  （FAILED/CANCELLED）turn 的迟到 completed 原会走交付路径复活任务；现改为不复活不交付
  +lateCompletion（refunded 附 factConflictHint）；UNKNOWN 未收口=迟到合法输出收口为确定
  成功（lateOutputResolvesUnknown）；回执丢失重放/交付重领不重复/resultKey 幂等与异载荷/
  停止后不复活/DEV-12 半程续跑均复证。
- **恢复 UI 闭环+DEV-14 前置**：遗留保护行（预算已处置·保护待解除）+「继续核对并解除
  （服务端取证）」正式入口（拒绝行内如实+保留）；`changeset.listByTask` 只读命令+任务串
  「变更记录」区块（状态中文+文件前像/后像+撤销进度；无变更不渲染；只读）。uiE2e 17/17
  （反例全链扩展+DEV-14 前置新用例）。
- 数字：集成/单元 **470/470**、UI e2e **17/17**、lint 0、零新增真实调用（隔离证明固化）。
  报告：reports/round-20260929-isolation-protection-outcome.md（含上轮核账勘误与
  round-20260929-process-evidence-repair-budget.md 顶部勘误注记）。

## （七补轮下一步，已执行完毕）

1. **无需等待直接开工**：按交付矩阵推进依赖已满足的工程包（DEV-13 剩余真实样本归补证
   窗口；DEV-14 前置已起步——变更记录区块可扩展 Git 视图/验收流；correctToExecuted 的
   UI 入口可选）。
2. **价值评价（暂缓中）**与补证方案（另批）口径不变；真实补证优先 Claude Code+
   deepseek-flash，Codex 专项单独列目标预算。

---

## （上一轮快照，2026-09-29 第七轮）

- **OS 退出证据服务端化**（第七轮，迁移 009）：`RuntimeAdapter.processIdentity()`
  可选能力（per-turn=Claude CLI 每 turn 独立子进程/shared=Codex App Server 常驻/none=
  fake 内联）；worker startTurn 成功后登记 `runtime_process_registry`（PID+OS 启动时刻
  3s 短超时；失败=pid-only 如实降级），终态非 UNKNOWN 标 closed；新命令
  `recovery.probeProcess`（只读：按已登记身份 OS 核对→写 `recovery_exit_probes` 服务端
  证据）；`recovery.reconcile` 参数重写——**调用方不能再自报 alive=false**（旧
  exitEvidence 参数层删除），退出释放按 probe 结果矩阵（exited per-turn/shared、
  no-os-process=none 程序事实→释放；alive/unknown/identity-missing/复用→保留）；
  probeId 引用校验（turn 归属/登记一致/≤10min）；notStarted 人工分离（manualRiskAck
  必填：退款+FAILED 但租约/准入保留、recordedAs=manual-claim）。Windows 查询错误分类
  修复（仅 ObjectNotFound=exited；权限/StartTime 失败/解析失败=unknown）+epoch 计算修正。
- **逻辑输出+预算授权账目**（第七轮，迁移 010）：`format_repair_workitems` 重建为
  UNIQUE(task_id, logical_output_id)——修复轮继承根逻辑输出身份，**禁止修复套修复**
  （被拒请求零副作用：无工作项/outbox/启动计数）；refunded turn 豁免（无逻辑输出不挡
  资格）；预算单一真源=逐 turn 处置事实（非退款计数；旧 SUM 快照重复计反例已锁定）；
  budget_run_id 参与授权链校验（断裂=损坏阻塞）；修复轮上限强制（超限=closed+
  repair-budget-exhausted+BLOCKED）。
- **文件清单回授权合同**（第七轮）：`projectScopedFileListing`（§13.4 项目源码默认可读
  ——不再按 change_sets 归属排除[共享源码不永久隐藏]；§6.3 命名排除清单：VCS 内部/依赖
  缓存/构建产物/常见凭据，.env.example/.editorconfig 等可见；大小写归一；上限按过滤后
  计数——排除项不耗名额）；「评分答案在项目外」不再作为通用产品权限保证；两模式一致。
- **恢复 UI 事实分层**（第七轮）：程序观测/人工说明（草稿不丢）/无法确认/保留保护四层；
  「服务端取证」「人工声明未启动（退款·保留租约，confirm 风险确认）」操作精确绑定
  turnId；人工声明后遗留租约行如实显示；alert→行内错误行。renderer e2e 新反例：人工声明
  后保护仍在+界面说明原因；服务端核对完成才按条件收口；executed+identity-missing 不
  提前收口。
- **总账口径（用户已决定）**：价值评分=**用户决定暂缓**（待恢复与修复链稳定后再集中安排
  一次，不再每轮列为阻塞项）；实验原始证据/评分包 v2/已知偏差保留不动；价值闸门未通过、
  DEV-11 不开放；剩余 3 次保留，补证另批（优先 Claude Code+deepseek-flash）。
- 数字：集成/单元 **451/451**、UI e2e **16/16**（+1 恢复面对账反例）、realCodex 4/4、
  lint 0、零真实调用。报告：reports/round-20260929-process-evidence-repair-budget.md。
  realCodex B6-2 曾在一次全量连跑中偶发失败（真实渠道计划档行为漂移），单跑/全文件/
  改动前后均通过——既有真实认证偶发敏感，非回归。

## 当前下一步（唯一）

1. **无需等待直接开工**（用户已决定先工程后评分）：DEV-13 剩余（成果一致性专项用例；
   进程身份与 DEV-05 supervisor 衔接——registry/probes 表已就绪可被 supervisor 消费）；
   DEV-14 前置 UI 工作；按交付矩阵推进依赖已满足的工程包。
2. **价值评价（暂缓中）**：等恢复与修复链稳定、具备可操作用户体验后**集中安排一次**
   （评分包 v2 与证据保留现状，不重跑）；价值闸门未过 DEV-11 不开放；补证方案
   （round-20260928-recovery-repair-final.md §4）待另批——本轮未自动执行。

---

## （上一轮快照，2026-09-28 第六轮·下）
- **格式修复持久工作项**（`768b51a`，迁移 008）：修复用户指认四缺陷——kv 读后即删→
  pending/consumed 与 run/turn 创建同事务；任务级最后一条→同轮精确绑定（源 turn 自身
  outputInvalid+thread.replyAdded 消息+resultKey 与 run.created 核对）；每任务一次→每
  逻辑输出一次（(task,source) 唯一+派发键 task:<id>:repair:<sourceTurn> 版本化）；
  后缀判定→工作项结构化（普通 redispatch 失败=ACTIVE 非 BLOCKED）。损坏上下文→
  blocked+审计不花调用；修复轮预算沿用任务既往累计（repairConsumed.budgetCarryoverUsed）。
- **恢复事实分离**（`a4e8ada`）：reconcile 三事实（执行 notStarted 退款/executed 结算；
  退出 exited 须 osProcessCheck 结构化证据——userManual 拒绝；alive/unknown 保留租约与
  占位；executed 二次=补证不重算；settled→notStarted 矛盾拒绝）；budget_mark 逐 turn
  幂等；keepUnknown 非 UNKNOWN 拒绝；同 daemon releaseAdmission 联动（全链验收：占位→
  reconcile→解除→排队可派发；executed+alive 不放行反例）；processCheck.ts 真实进程
  取证（alive/exited/unknown+PID 复用判 different）。
- **文件授权过滤+恢复面 UI**（`f8f83b0`）：清单排除隐藏项与**其他任务 change_sets 归属**；
  两模式同一规则；不构成沙箱认证如实。恢复中心面板（UNKNOWN 明细+精确绑定操作+
  未确认退出无一键清空）；e2e 崩溃-重启链断言。
- **补证口径纠正**：旧批次 DIRECT 二次=无反馈重派——不能证明新修复机制相对效果；
  围栏规范化=1 次即验；修复全链≥2 次；文件发现=另一目标。最小方案上限 4-12 次**另行
  申请**（批次剩余 3 次只限价值对比，保留不动用）。
- 数字：435/435、UI e2e 15/15、lint 0、零真实调用；报告
  reports/round-20260928-recovery-repair-final.md。上半天（第六轮：台账/评分包 v2/
  修复链 v1/DEV-13 首片）快照见再下一节。
- **批次证据已修正（唯一台账=真源）**：`scripts/value-ledger.mjs` 从六侧原始库生成
  `evidence/value-batch/per-call-ledger.json`——全批 **30≤33**；**A-DELIB 10>9 单侧超限成立**
  （全批余额不抵销）；DELIB 合计 24（23 成功/1 失败）；**全批 FAILED=6**（初版报告「17/17」
  「4 次 FAILED」两处手写数字已勘误）。**A 组=带预算执行偏差样本**（内容/诊断保留，不构成
  符合预算条件的有效配对）；B/C 组内条件分别陈述；三组不汇总为「研讨更优」；预算修复表述=
  「B/C 实测无争议路径未超限；事故分支依赖本地回归证据（cap=9 用例已落地：先断言争议+修复
  真实发生→startTurn 实计数=9、第二 DIS 竞争落选留审计、账目闭合）」。C 组原目标未达成如实
  记录（受阻处理=附加维度）；C 根因四层取证（CLI 声明 observed/运行时清单 unknown/模型侧
  定义 unknown/实际调用仅 Read——根因保持 unknown）。
- **证据包持久化**：`evidence/value-batch/evidence-pack/`（逐 turn/输入输出全文含被拒字段/
  bundle hash/预算事件/版本）+`evidence-classification.json`（observed/reported/claimed/
  unknown 四级）+`direct-repair-path.json`（二次调用取证：三次均 redispatch 新 run/turn——
  输入未绑定原输出/错误=修复绑定缺陷，已修）。
- **评分包 v2（现行口径）**：撤回「可靠盲评」→**已披露实验背景后的人工可用性评价**；
  `evidence/value-batch/scoring-pack-v2.md`+materials-v2/（模式明示、双视角：产品交付
  （A/B DIRECT 无正式交付如实标注）+原始内容诊断（被拒 conclusions 全文保留、可读版仅
  pretty print）；不重新编号不删实质内容。**待用户评价**——价值闸门未通过、DEV-11 不开放。
- **DIRECT 修复链落地**（`15f81d2`）：formatRepair 正式通道（守卫=上 turn FAILED+
  outputInvalid、每任务一次结构化强制；kv 修复上下文→组装注入原输出全文+校验错误+指引
  「结论完整并入 changeSummary 不删短」）；输出合同字段用途强化（修复 A 组「conclusions
  无归属字段」机理）；单层围栏规范化（仅剥整文本包裹的一对围栏→同一严格 schema；
  outputNormalized 审计；C 组形态将直接通过）；修复耗尽→BLOCKED 收口（direct-repair-
  exhausted——A/B DIRECT ACTIVE 悬挂的产品侧答案）。
- **文件发现能力**（后续版本，不倒改批次）：authorizedFileListing（经授权清单：项目根内/
  排除 .git/截断与破口如实）→DIRECT 信封 fileDiscovery+渲染；DELIB IND 首轮同款（两模式
  一致）；root 缺失不加键不阻断。
- **DEV-13 首片实装**（`6a2d0ad`）：recovery.reconcile 三事实处置（notStarted=退款
  refundReservedTurn+租约释放+FAILED 留证；executed=结算；keepUnknown 全不动——不清空
  UNKNOWN 放行）；recovery.status 扩展（UNKNOWN 明细/stopRecord/activeUndos=DEV-12 崩溃
  窗口续跑指引/租约+「daemon 死≠子进程死」如实注记）；applyRecovery 快照扩展；故障注入
  测试 2/2（含 DEV-12 未记账样本经恢复面→changeset.undo 三向续跑联动）。
- **剩余 3 次授权不动用**（不用于探活/凑分/补跑/产品验证）；全套 **427/427**、lint 0、
  零真实调用。
- 上一轮（第五轮·下：批次执行/预算缺陷修复/DEV-12 四项加固）快照见下节——结论不变。

## 当前下一步（唯一）

1. **等待用户**：①评分包 v2 评价（已披露背景的人工可用性评价——材料含模式标签）→价值
   闸门结论；②真实补证方案批准与否（最小具体方案见最终汇报：建议另行申请，不动用批次
   剩余 3 次）。
2. 无需等待直接开工：DEV-13 剩余（进程身份 OS 层取证=DEV-05 supervisor 衔接；成果一致性
   专项用例）；DIRECT 修复链真实补证（围栏规范化+formatRepair 全链在真实渠道各 1 turn——
   待批）；UI 层呈现 BLOCKED/恢复面入口（DEV-14 前置）。

---

## （上一轮快照，2026-09-28 第五轮·下）

- **价值对比批次已执行（授权 33 上限，实耗 30）**：A/B/C 六侧全部经 real-delib harness
  （value 批次模式：成员正式绑定 claude/deepseek-flash、manifest 全字段、逐侧 verify/ledger/
  export）。逐侧：A-DIRECT 2/2（两次 outputInvalid：附加键 conclusions——内容好但严格 schema
  拒绝）；A-DELIB 10（**超限 1=预算缺陷已修**；9+1 修复；qualified 共识交付）；B-DIRECT
  2/2（两次纯散文）；B-DELIB 7/9 unanimous；C-DIRECT 2/2（围栏 JSON→修复后 DONE，本批唯一
  DIRECT 正式交付）；C-DELIB 7/9 unanimous（阻塞如实上报）。全部 usage 响应模型=
  deepseek-flash（零回退）；est 合计 $8.66（渠道账单为准）。版本配对：A 两側=6064529、
  B/C 两側=915f0db（组内配对有效；组间跨版本注明）。**主要观察**：①DIRECT 严格输出合同
  系统性合规失败（三种形态）/DELIB 阶段合同+修复全通过；②C 组文件名不可发现性两侧对称
  受阻（模型自述无 Glob 而 adapter 配置含——工具面认知差）；③争议分支真实出现并触发
  预算缺陷。材料：evidence/value-batch/{anon/*.md, scoring-sheet.md, anon-mapping.json,
  batch-ledger.json}；报告 reports/round-20260928-value-batch.md（含模式标签——评分后再看）。
  **待用户匿名评分（scoring-sheet）→ 揭示映射 → 价值闸门结论（此前不宣布通过、不进 DEV-11）**。
- **预算超发缺陷修复**（A-DELIB 实发 10>9）：前置阶段派发不设占用预留——双成员 DIS 并行
  领取读旧账（TOCTOU）。修复=occupyFrontForDispatch（`915f0db`）+回归（detached 争议+修复
  cap=6：≤cap、终态占用 0、budgetSkipped 留审计）；B/C 两轮 DELIB 实发 7≤9 证实。
- **DEV-12 四项修复完成**（reports/round-20260928-dev12-hardening.md）：①扫描完整性
  （ScanResult failedDirs/rejectedEntries；进入前物理核验；空目录合法基线；不完整→缺失判
  unknown）；②三态 probeCurrent（unknown 拒绝覆盖）+最近存在祖先 realpath 重核（父链换
  junction 拒绝、外部零写入）；③崩溃窗口注入+三向判定（已执行未记账=补记不重执行不误判
  冲突；failed 续跑重置 pending）；④PhysicalWriteRootRegistry 统一物理写入占位（撤销全程
  持有；B6 派发写档共用约束点；跨进程仍靠单实例锁+租约表——保护范围已如实标注）。
- 本轮上半天（准入生命周期/退出收口/工具审计 CDP/DEV-12 主体）见上一快照与
  reports/round-20260928-admission-exit-hardening.md——结论不变。
- 数字：全套 **412/412**、UI e2e **15/15**（真实档 2 例按 env 跳过）、lint 0。

## 当前下一步（唯一）

1. **等待用户**：①匿名评分（evidence/value-batch/scoring-sheet.md——评分前勿看工程报告）；
   评分后揭示 anon-mapping → 价值闸门结论；②可选最小预算：resumeSession 真实续接、
   restrict* 拒写对照（B6 前置）、双任务真实隔离。
2. 无需等待直接开工：**DEV-13 恢复与故障测试**（RT-03 重领对账/崩溃恢复语义系统性用例化
   ——本轮 stopRecord/UNKNOWN/三向恢复现场已备素材）；批次后产品改进评审（DIRECT 输出
   合同容错围栏/字段引导；输入合同明示工具面——修复 C 组认知差）；E4 detached 真实研讨
   复跑准备（价值闸门结论后再跑）。

---

## （上一轮快照，2026-09-28 第五轮）

- **准入占位完整生命周期完成**：DIRECT/DELIB 的 openSession（原来在 try 之外——上轮报告
  「均回收」超出证据，已收口）纳入统一 try/catch/finally；启动失败两分类——确认未启动
  （记录/提示词失败、会话记录失败且关闭确认）=FAILED+释放占位+outbox 完结；不确定
  （openSession/startTurn 抛错、关闭未确认）=UNKNOWN+**保留占位**+租约重领对账（RT-03）；
  detached 启动失败 live 遗留修复；standing 失败 turn 悬挂修复。
- **退出状态机收口**：`startingTurns` 登记（晚返回 openSession 不再对 stop 不可见）+
  `awaitSettlement`（starting∪consuming）；drain 挂起计入 incomplete 判定（drainPending）；
  晚返回 openSession 检查 shutdownStarted→不启动 turn、有界关闭、CANCELLED 清理；force 路径
  **核对后**关库（全收敛={complete:true,forced-closed}；否则 forced-incomplete 不关库不释放锁
  ——崩溃语义现场保留，不声称已杀完/已落库）；`boundedDisposeAll`（dispose 挂起不无限等待）；
  stop 记录实际持久化（daemon:stop:last 四态落盘；applyRecovery 快照 stopRecord 可读）。
  上轮报告「已杀进程/零后台写库」超限表述已加更正注记。
- **工具审计收口**：thread.toolCalls 合并键=turnId+toolCallId（作用域；同名跨 turn 不错并）；
  completed 结果与时间取自同一条选定事件；eventKey 去重；身份不完整=未归属条目（不按时间戳
  合并）；「零泄露面」改为准确字段范围说明；CDP 级 UI 断言 2 例（显示/去重/进行中/失败/
  unknown/切线程/刷新——ZS_FAKE_TOOL_EVENTS 首个-turn 编排钩子，仅 ZS_ALLOW_FAKE=1）。
- **DEV-12 主体完成**（daemon 层 preimage.ts+changeset.ts+迁移 007+changeset.* 四命令；
  domain 只许依赖 contracts——两模块因此归 daemon 层，六边界 lint 强制）：三态基础数据模型
  （unknown 不推导增删改/不自动撤销）；内容寻址前像存储（回读核对+撤销前再核对+大小上限
  contentUnavailable 提前呈现）；Git 基线（HEAD+porcelain+未提交/未跟踪内容前像——不
  stash/reset，撤销不动 Git 历史）；非 Git 整目录扫描（排除 .git、截断如实；扫描完整时基线
  无行=变更前 absent，截断=unknown）；非破坏撤销（逐步执行前重验当前==after、冲突不覆盖、
  撤销新增先确认仍是本次产物、单文件临时+回读+rename、多文件逐步持久化+中断续跑幂等、
  reverted/partial 如实）；单写者（重叠活跃/expired 租约拒绝并列持有者+同项目撤销互斥）。
  验收映射+反例见报告 §4（临时 fixture 含临时 Git 仓库，正式命令路径 9/9+前像单元 6/6）。
- 认证范围保留不扩大；零真实调用、零探活；价值对比 33 未动用；M1/DEV-11 闸门不变。
- 数字：全套 **402/402**、UI e2e **15/15**（真实档 2 例按 env 跳过）、lint 0。
  报告：reports/round-20260928-admission-exit-hardening.md。

## 当前下一步（唯一）

1. **等待用户输入**：① 价值对比 33 批准与否；② 可选最小预算：resumeSession 真实续接（1 turn）、
   restrict* 拒写对照（B6 前置）、双任务真实隔离。
2. 无需等待直接开工（按交付矩阵依赖已满足且零真实调用）：**DEV-13 恢复与故障测试**
   （不确定窗口/进程核对/成果一致性——RT-03 重领对账、崩溃恢复语义的系统性用例化；
   本轮 stopRecord/UNKNOWN 现场已为它备好素材）；或 DEV-12 任务侧接线预备（B6 写档接入时
   派发自动 capture/finalize 的设计落点）；E4 detached 下真实研讨一组复跑准备（价值闸门
   过前不跑）。

---

## （上一轮快照，2026-09-28 第四轮）

- **统一派发准入完成**（admission.ts：global4/project2/provider2/member1+writeRoot 接入口；
  占位覆盖 openSession/startTurn 窗口；UNKNOWN 保留占用；预算与并发不混用；泵必经准入）——
  7 组反例全过；顺带修三真实缺陷（DIRECT 截止中断误判 CANCELLED→UNKNOWN；requestStopAll
  hangInterrupt 死锁；关库后 settle 抛无人接拒绝）。
- **退出状态机完成**（stop→DaemonStopResult：incomplete 不关库不释放锁；force 路径另行定义=
  杀+abortConsumers UNKNOWN 收尾后关库；standalone 退出码 0/3）——本地反例全过（未确认不关库
  锁保留、强制后 UNKNOWN 持久化、关闭期完成事件落库、重复 stop 同结果、关库后零写入）。
- **harness stop 闭环**（real-delib doStop：正式 task.stop 绑定 runId/停止代次→观察至可解释终态；
  taskkill 仅 ZS_CRASH_INJECT=1 崩溃注入）。
- **线程工具审计呈现**（thread.toolCalls 命令：domain_events 真源/线程隔离/toolCallId 去重/
  member 归属；renderer 线程尾只读区块；集成 4/4——CDP 级断言随下次 UI e2e 批次）。
- **DEV-12 起步**：src/domain/preimage.ts（前像捕获/diff 纯函数+临时 fixture）——撤销执行与
  Git/非 Git 基线为主体实施项。
- 认证范围保留不扩大（usage=0=未收到用量报告非零扣费）；零真实调用、零探活；价值对比 33 未动用。
- 数字：全套 **384/384**、lint 0。报告：reports/round-20260928-admission-shutdown-tools.md。

---

## （上一轮快照，2026-09-28 第三轮）

- DEV-10 受控中断真实认证通过（预算 1/1：进程证据后 2ms 停止/CANCELLED 全链/无孤儿/重启不复活）
  →interrupt 按证据 supported；能力逐项修正（resume/restrict*/isolation=unverified）；只读档
  正式机制组合；tool 事件落库审计；E4 调度解耦实装（detached+成员互斥+两缺陷修复）。
---

## （上一轮快照，2026-09-28 深夜·二）

- deepseek-flash 真实认证：意外探活 1 次（settings env 优先级事故）+ turn1 全链成功
  （暗号回流/resultKey/usage 20,875+53,760cache+11,822/$0.4268 est/55.6s）；成员级
  runtime 生产接线完成（member.setRuntime→registry→worker adapterFor）。受控中断当时未
  执行——**本轮已补并全部通过**（见上）。

---

## 刚完成（修复轮 6 + G3 收口）

- **证据口径修正**：ZS_UI_DEMO=宿主内命令链路（main 直连 pipe），不再称等价人工点击；发现并修复正式 renderer app.js 从未成功执行的问题（顶层 const 与 contextBridge 非配置全局冲突 → IIFE 包裹）。
- **R1-R5 renderer 全量接通**（src/ui/renderer/app.js 重写）：停止按钮（点击时快照绑定，切线程不误停）；恢复入口（recovery.status 只读 + 显式 dispatch.resume{confirm:true}）；主池 room.pool + 线程 thread 目标（不新建根任务）；双视图草稿独立/在途去重（同 commandId 重试横幅）/IME/仅记录一次性复位/M0 模式诚实实现（仅 DIRECT，恰一名 agent 时预填 mention）；重载/重启按上次项目恢复（localStorage + userData 隔离）。
- **B1/B2**：管道 commandId 关联+迟到响应丢弃反例（2/2）；daemon 生命周期 drain 收敛/重复 stop/关库后零写入（3/3）。
- **UI e2e（CDP 真点击）**：tests/e2e/uiE2e.test.ts fake 11/11（发送→DONE→线程回复/跟进/草稿/仅记录/双击双 Enter 去重/IME/重载恢复/UI 停止→CANCELLED/SIGKILL 崩溃→重启→门禁→确认→中断任务不重跑+新调度恢复）；**真实 codex 1 turn（UIE2E-CODEX-6666，24.7s）**。
- **隔离**：同成员两任务先排队再派发用例（串行完成/各一 run/顺序正确/会话不因同成员合并）。
- **架构**：IPC 协议共享层下沉 src/contracts/daemonIpc.ts（ui→daemon 边界违规清零）；task.get 补 stopGeneration；recovery.status/room.pool/thread 目标服务端合同；ZS_PIPE_NAME/ZS_FAKE_STALL_MS/daemon.pid/pnpm build:ui 配套。ADR-I41/I42。
- **数字**：pnpm check 全绿 276/276；lint 0（此前 24）。详见 reports/round-20260927-fix6-ui-e2e-g3-closeout.md（五段）。

## 当前故障 / 待停止进程

- 无遗留进程（本轮 electron/daemon 均清理）。

## M1 第一批（已提交，本轮内完成）

- **contracts/deliberation.ts**：§6.4 报告/互评/立场/检查点/整合/确认 payload schema（schemaVersion 字面量，模型自报身份字段一律程序赋值）；E12 预算推导（6N+1+C / 7N+2+C）与尾部账目（M/U/I、S=1/Q=N、R/T/F、stageAvailableTurns、occupyTail/settle 纯函数）。
- **domain/deliberation/stageMachine.ts**：INDEPENDENT/CROSS_REVIEW 屏障（E4 缺席不默认完成、全员无输入 BLOCKED）；争议派生（同 claim 合并、无争议跳过讨论）；第 3 轮检查点资格（host 专属）；共识聚合（unanimous/qualified/disputed/unconfirmed，缺席不覆盖反对）。
- **persistence/stores/deliberation.ts**：artifacts 落 appData 管理目录+hash；synthesis_claims 冻结；RATIFY 矩阵初始化/提交事务（claim 全覆盖且无重复、非预期成员/阶段不符整份拒绝、同 resultKey 重放、已确认不可自然语言覆盖、关屏障 pending→missing 不伪造 turn_id）；issues/positions。
- **DEV-21-M1 模板**：DELIBERATE 六阶段指令（(mode,role,stage,turnPurpose) 选择表扩展，checkpoint host 专属）+ 精确 JSON 输出契约（ADR-I39 口径）。
- 测试 +19：预算 4 / 阶段机 10 / 持久化 5（含 prompts 表更新）。默认 295/295。

## M1 第一轮（已提交）

- **四缺陷收口**（迁移 004 payload_hash / 005 stage_started_at）：屏障冻结参与集合、互评三元组+run 范围 issueId、RATIFY 同键同规范化载荷幂等/异载荷冲突+全前置核对+行数校验、成果发布协议（不可变版本/失败恢复/完整性校验）。零额度反例齐备。
- **DELIBERATE 编排**（deliberationRunner+worker 集成）：PREPARE→IND→CR→（争议）ISS 轮次+第3轮 checkpoint→SYN→RAT→PUBLISH 全链；确定性 dispatch_key；服务端输入隔离+ContextBundle hash；E12 预算单一账（占用/结算/退款/尾部保证/耗尽兜底）；E4 假时钟缺席；停止作用于运行；一次格式修复。集成 9 用例。
- **研讨 UI**：run.progress/report.get 命令、@全体芯片、进度条（成员状态可见）、逐结论共识报告；门禁按证据开放（entry 默认；worker 级默认关，m0Fixes 语义不变）。UI e2e fake 12/12。
- 数字：默认 323/323、lint 0。

## M1 收口轮（2026-09-28，已提交）

- **取证**：三次历史真实尝试 WAL 字符串取证定论（1/2=截止中断误判用户停止缺陷已修；3=CODEX_ERROR 正文未存档）；e2e 失败保留证据目录已修。
- **调度/E4/迟到/身份**（331/331）：时钟注入；排队≠缺席、成员级缺席（截止中断/UNKNOWN 不杀 run）；迟到三分支（未冻结纳入/停止不复活/发布后只展示）；dispatchKey 带 runId（二次运行不复用旧键、旧 run 遗留零执行）；RATIFY 确定性收口；ContextBundle 全文+hash。
- **真实研讨一组完成**：预算 7/9 精确、无争议跳过讨论、unanimous、29/29 逐项审计（scripts/real-delib-audit.mjs）；提交-观察分离 harness（scripts/real-delib.mjs）。

## 下一步（直接开工，无需再确认）

1. **真实补证（按需小额）**：一组带真实分歧的任务（讨论轮+checkpoint 真实路径）、一组真实迟到/缺席观察；完成后把门禁默认开放。
2. **M1 价值闸门材料**（需预算批准后执行）：3—5 组同题同基线 DELIBERATE vs DIRECT——先列任务清单、评判标准（事实准确性/漏项/分歧处理/调用量/耗时）与总预算报给用户，再执行；不预设结论。
3. 价值闸门通过前不进 DEV-11 自动分工；不影响其他独立工程工作（跨房间建房命令等）。

已知小残留（不阻塞 M1，随相关包顺手收）：跨房间切换 UI 场景（正式命令面无建房命令，待房间管理命令落地后补）；UI 发送横栏传输失败路径的 UI 级注入测试（传输层已有单测+smoke）。

## 施工纪律提醒（下一轮自查）

- 检查点提交只挑本包文件，不全量 add；TS 6.x / zod 4.6.5 / better-sqlite3 13.0.3 已锁。
- 三态区分：IMPLEMENTED ≠ VERIFIED；报告写实际命令与退出码。
- 用户明确延期项（并行写入增强/worktree）不得恢复；G3 已收口，不再重跑已过认证（steer/allow/resume/usage 等）。
- UI 相关验收：真点击链路用 CDP 方式（ADR-I41）；宿主内 ZS_UI_DEMO 证据只作后台链路口径。

### 2026-10-15 人工回填后收口

[当前总门](evidence-r84-manual-closeout-20261015/final-gates-human-confirmed.json) pass/corePass均true；human-titlebar-drag.json原用户来源已read_thread核对。程序仍05b549f/bld_fcf357a7e1e4ad52，未重包/新增模型/重跑2h。原42封存证据和自动化false原件不改。用户现启动candidate后产生server-data，不能删除、搬移、关闭用户应用或再当工程根运行；新QA只读程序清单并依据同BUILD/manifest交付前无预置数据证明收生命周期门。新增26正负合同/两脚本lint0通过。不要把拖动单项改成整体userAcceptance=passed。
