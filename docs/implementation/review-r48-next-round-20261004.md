# 第48轮复核：H1当前包不宜交用户短测（2026-10-04）

基线`b264a40`；候选`dist/desktop/hifi-h1-win-v1`，buildId=`bld_bbe84842e7a1f23f`。本次不修改产品源码、候选包、原型、v6或用户数据/证书/结果。探针写在独立`dist/desktop/review-r48/`，使用候选实际renderer的隔离隐藏窗口与受控传输；正式网关验证仅内存库、无worker/真实模型。

## 1. 工程状态与下一轮范围

新界面施工继续，不回到先补全全部功能才接界面。R49应集中完成H1的可运行交付与以下确定性核心修复，再让用户短测；暂不开始H2新功能。用户无需新资源或产品裁决，Android仍可用现有v6独立进行。

独立核对当前应用591/591文件与包内MANIFEST字节/长度/hash一致（manifest-result.json），它证明清单完整性，不能替代冻结产物三连、启动器或正式数据链。BUILD真实记录基线0b8dacb+dirty，本次不改元数据或声称干净b264a40构建。

独立hifi typecheck通过。独立跑hifiFirstPackage/legacyProtectionUpgrade/dmReviewContract：3文件11个断言通过，但Vitest报告1个未处理拒绝且**退出码1**：

```text
Error: STORAGE_UNAVAILABLE: The database connection is not open
  at command (.../hifi-bundle.mjs:1950:9)
  at refreshDms (.../hifi-bundle.mjs:2279:16)
Tests 11 passed; Errors 1 error
```

不是“本次全绿”，未重跑全量854。标读后的异步refreshDms/测试关库时序需有界等待与错误归属，不吞掉或关闭Vitest未处理错误检查。当前真实链测试是loader/store直连命令面+fake worker，不是最终Electron页面/preload/管道全链。

## 2. [P0] 交付启动器缺依赖，所谓启动器证据未跑bat

当前start-server.bat是旧DEV25双机启动器：

- 调用`%PKG%seed\seed-client.cjs`，候选目录**没有seed目录/文件**；必然SEED FAILED。
- 输出声称RESULTS/seed.json已写，目录里没有RESULTS、结果模板或README。
- 提示执行run-self-check.bat，候选里也没有该脚本。
- 两条NEXT指向旧双机/LAN配对，而当前交付任务是H1本机界面体验。

verify-launch.cjs实际直接spawn exe，没有运行start-server.bat；env继承父环境，仅固定ALLOW_FAKE/RUNTIME，没有机械指定独立appData、真实派发guard、独立管道。探测只看hifiOn/legacyVisible/legacy的__zsReady，结束taskkill /T /F，没有优雅停机与零残留事实。launch-evidence.json只是直接exe显示模式探测，不得叫“真实启动器全链”。未证明真实用户目录已经被其改动，环境继承影响也没有完整留档，须如实保留边界。

R49把H1打包脚本入库，独立/幂等种子走正式命令，提供房间/启用fake成员/独立DM/已发样本及相应README、结果模板、留档目录；用户双击一个启动器即可进入项目，不需要自设环境变量/账号。内置fake、真实派发硬防护、独立appData与管道，清理会覆盖配置的父环境ZS变量；文件路径含中文/空格实跑。程序/数据目录与日志输出按实际存在核对，模板不覆盖用户结果。启动失败要非成功退出，不打印Seeded假成功。

## 3. [P1] “完整冻结信封”仍从UI目标重造，缺正式目标字段

候选实际React页面探针`ui-envelope-probe.cjs`（隔离profile，读取包内renderer原字节，受控严格传输）记录：

首次实际message.submit：

```json
{"commandId":"cmd_9a7s0imr","params":{"target":{"kind":"room_root","projectId":"p","conversationId":"ca","roomId":"ra"},"body":"Same target original","intent":"default","mentions":[]}}
```

同目标点“重发原内容”：

```json
{"commandId":"cmd_9a7s0imr","params":{"target":{"kind":"room_root","roomId":"ra"},"body":"Same target original","intent":"default","mentions":[]}}
```

页面提示VALIDATION_INVALID，随后未知信封被清除。原因Composer.envelopeOf取ComposerTarget，loader首次发送会补正式projectId/conversationId，但冻结层没有保存这份真正发送的参数。DM的ComposerTarget还含非正式roomId/dmId，不能直接当严格DM目标。

另段：A发请求后、unknown回执前切B，draftKey effect改commandIdRef；unknown处理再读该ref冻结，A原命令cmd_2tlgcelb变成cmd_4mccr9py。原始结果ui-envelope-result.json。

将捕获的两份重试信封交真实`dispatchDaemonCommand`内存schema校验：均VALIDATION_INVALID；实际结果actual-gateway-result.json。这是schema拒绝证明，未执行真实原提交/模型，也不声称用户现场已发生。

修复：在**调用bridge发送前**由唯一正式参数builder生成不可变信封（原commandId+完整目标/参数），立即与发起目标键绑定。等待/回执/重试都用这一份，不在unknown回来后重读ref、当前target或当前项目再拼。组件消费信封/回执结果，正式数据层保存真实发送参数；同号同参重试由后台幂等结算，确定拒绝与未知保留语义分开。覆盖房间/DM、unknown期间编辑/切走卸载/切项目、成功旧信封重放后原调用恰一次。

现有P7冒烟只看retryBody、次数和banner消失，未核对完整参数或重试ok。它可能把**失败后删除banner**当重试成功。真实链测试又手工构造正确env绕过Composer冻结逻辑，不能证明UI产生的信封正确。用候选UI实际生成的信封经正式管道到DB，不用测试写一份比产品更正确的参数；断言重试ok+完整参数一致+单业务效果+新草稿保留。

## 4. [P1/P2] 草稿与接管身份仍需两个关键反例

- sendingKeyRef只是单个字符串，不是每键锁；A在途后切B发、B未回时A.finally把全局ref清空，可能允许B重复提交。已登记的双击断言只覆盖同目标单请求，需在多目标交错回执下验证锁/错误/命令身份。
- stored草稿按发起键清算方向正确，但“同字符串前缀就删”没有草稿编辑代次：同目标用户删除原文再写相同前缀的新内容不代表该内容已发送。未知信封只有每键一槽，连续unknown新发可能覆盖前一份；UI正常发送在未知未解决时允许原正文再次以新号提交，要区分旧未确认内容与新草稿，避免重发原任务。修复与信封生命周期合并，不只让P8 B独立文本通过。
- 当前takeLegacy(current-dm)丢弃会话ID，截取peerDisplayName并查首个includes匹配。同成员多DM时会打开第一条：抽产品locateLegacyDm函数，目标为Guide A会话二、按钮有会话一/二，实际点击dm-one并返回null；结果legacy-identity-result.json。未执行真实停止/验收，但此入口承载这些动作，不能按同名文本定位。房间也应按roomId/projectId，不能名称includes。用机器身份定位、确认最终实体一致，返回原导航；补同成员两会话/同名房间反例，不只检查面板可见。

## 5. R49一次交付门与口径

先修启动器与真实信封，再统一补上述交错场景和异步退出清理，不拆成继续交半包让用户验。把当前目录标为未完成工程候选；需要替换时用独立修订目录保留旧证据，不动v6。

最终冻结产物默认hifi在干净环境**实际运行交付bat**，连续三次完整首包序列分别留档：首启自动项目/侧栏→房间指定成员派发/仅记录零运行→DM回复落库及页面可见→未知原信封重放→草稿跨目标→按ID接管/返回→重启历史→正式关窗shutdown事实/exit确认/零残留/real_calls=0。二次启动种子幂等。--no-hifi只是旧界面对照，不算默认H1全链。持久数据与UI证据、传输模拟分别列，不关闭错误检查、不拼绿。

包内实际文件逐件核最终冻结清单，记录build/commit/dirty真实身份。原型与H1同窗尺寸对照侧栏、消息气泡、私信阅读区和输入宽度，优先修明显空间问题；必要入口集中放对应位置，不把说明/诊断再堆回聊天区。首包就绪后用户只需5项左右、约5–10分钟主要体验短测，提供实际入口和PASS/FAIL模板，不重复旧Windows D1–D10或v6四项。

更新continuation/总账：当前顶部仍为R47，不能让下一轮从旧快照施工。将未完成项按启动/合同/交付分类，不称“不阻塞用户短测”来跳过已批准交付门。

继续原型主线；H2/H3在H1交付后排，不等Android才出H1。v6/Android/旧证据保留，A+Word不变、B不集成不下载，零新增真实模型调用；价值评价、DEV-11、并行写入仍关闭，G5不连带宣布。
