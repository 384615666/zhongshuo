# 续工记录（continuation）

> 每轮结束前更新；下一轮收到「继续」后先读本文件 + implementation-status.md，从断点接着做，不重新调研。

## 当前真实状态（2026-10-03 第四十一轮，唯一权威快照）

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
