# 第四十一轮复核与第四十二轮建议（2026-10-04）

基线 `1660a16`。本次只读检查代码、测试、原始报告、v5 包，并运行相关正式测试与独立内存升级反例。未修改产品代码、交付包、用户数据、原有验收证据，未发模型请求。

## 1. 结论与用户操作时机

新数据路径的三个原反例有对应修复，可以让用户开始 **v5 包内 demo-project 的 R1–R7 短回归**；R7 必须改用「📎附件→选择文件」，产品尚无拖放上传处理器。无需重复 v2 的 D1–D10；Android 仍在短回归通过后执行。

同时工程侧须补 **旧数据升级的 P1 兼容漏洞**，并修正 Word 验证支架的缺少负对照问题。这不推翻全新演练数据的通过证据，也不能由全新库通过宣称升级已安全。

用户开始验收后，固定其实际使用的 v5 包、server-data、RESULTS 和截图；工程侧另用独立目录开发/验证，收回用户结果后再集中交付，避免每个文档或测试修订都让用户重新信任证书、重复整套人工回归。

## 2. 已核实的本轮修复与证据

- 迁移041新增 protection_state；新的 notStarted/未确认退出对账会写 retained，正式证据解除会写 released。共享守卫与恢复中心现在能识别**新产生的**无租约 retained 项。
- 本次执行 `tests/integration/dev25FieldFixes.test.ts`，**6/6 通过**，其中有本轮无租约保留保护、正式证据解除与文件库重开的反例。没有重跑整个843项套件。
- PPT 预览入口已释放旧 controller/viewer，迟到首屏和 Office 根 DOM 提交已增加代次门。原始函数的生命周期支架报告 S1–S3 全过。
- Word 产品代码已使用 Shadow DOM，并显式 `renderAltChunks:false`。这形成了所需的样式边界；验证质量仍需补强，见§4。
- 独立重算 v5 所有 **588/588** 清单文件的大小和 SHA256，全部匹配。buildId=`bld_c188402fc999ed17`，包内 BUILD.commit=`1660a16a57542e56e8db216c63dd1d864a1002de`。
- 原始报告三个连续 run 均为 **156项、0 fail**：`v20261003150345-7mdgvb` created、`v20261003151245-zd4wkz` reused、`v20261003152153-uo7x3t` reused。没有混用第四十轮报告。
- 读取最终自测 `dev25-dual-evidence/2026-10-031530-5ij48g/summary.txt`：启动/停止/幂等/real_calls=0 与 RESULTS 保护均记为通过。本次未重启用户验收包。

## 3. [P1] 迁移041未继承旧“保护保留”事实

位置：`src/persistence/migrations/041-turn-protection-state.ts:20`。迁移只 ADD COLUMN 和 CREATE INDEX，旧行全部保留 NULL；而代码注释将 NULL解释为“从未进入保护保留语义”。对于旧版本已明确保留保护的 FAILED/refunded、无租约 turn，这个解释不成立。

### 已执行的独立升级反例

用实际 migration 001–040 建立内存库，正式命令创建 DM 和任务，注入**旧版正式 notStarted 已证明会产生的状态与审计形态**：

- run=INTERRUPTED、turn=FAILED/refunded、无 workspace 租约；
- 持久 `recovery.reconciled` 审计：`verdict=notStarted`、`recordedAs=manual-claim`、`protectionRetained=true`、`reason=manual-not-started-risk-ack`；
- 没有任何后续正式释放证据。

随后运行真实 `migrate(db)` 40→41，再调用真实共享守卫与命令：

```text
protection_state = NULL
assessTaskRedispatchReadiness = null
conversation.list recoverable = true
releaseProtection = stateChanged:false、无保留保护的 no-op
task.redispatch = ok:true / enqueued:true
新增恢复 outbox = 1
```

脚本：`dist/desktop/review-r41/legacy-protection-upgrade-probe.mjs`（包内Node，`--experimental-transform-types`）；结果保存同目录 `legacy-protection-upgrade-result.json`。全程内存库，没有启动 worker/模型。这里证明的是升级后的展示和命令准入失守，不宣称真实旧库已发生重复执行。

### 修复要求

- 用新的版本化兼容迁移（例如042）修复已升到041但未回填的库，同时覆盖40→最新。不要要求用户删数据或清空预算。
- 按同一 turn 的持久审计/正式证据及事件顺序继承 retained/released，不能只看最终FAILED/refunded，不能因为历史上“曾释放”就忽略更晚的保留事实。
- 没有明确保留历史的普通失败、正常终态保持原语义；不把所有旧失败或所有运行中有租约项一律标 retained，造成新误拦。
- 明确保留、没有可靠释放事实的旧项在呈现/恢复中心/提交前判定中均阻断；证据缺失、损坏、矛盾有明确处理，不默认安全。
- 回归覆盖40→最新、41→最新、旧保留项零新派发、已有可靠释放项不误拦、普通失败不误拦、数据/预算/审计不丢、文件库重开同判。新数据的六个已通过用例继续保留。

## 4. Word 验证支架尚不能证明报告中的全部声明

位置：`scripts/verify-word-isolation.cjs`。产品使用Shadow DOM的实现方向正确；以下是支架/覆盖缺口，需要修正证据，不能当成已发现的产品脚本执行漏洞。

1. **W1哨兵目标不匹配。**复核样本 styleId 为 `probe,#host-sentinel`，旧非隔离渲染输出选择器为 `p.docx_probe,#host-sentinel span`；支架却放置 `id=sentinel` 的裸按钮，读取按钮自己的颜色。旧无隔离实现也不会命中这个哨兵。改为实际目标 `#host-sentinel > span`，增加同组件无隔离负对照确实变红、Shadow正对照保持原色。
2. **“文档样式在shadow内生效”未测量。**W1只判 `hasShadow` 和哨兵前后颜色，`colorInside` 为 null。增加正常有效文档样式的内部 `getComputedStyle` 对照，不用包含CSS字符串或style节点数替代。
3. **W2样本没有altChunk。**当前用word-rich检查零iframe，不能证明关闭嵌入HTML选项。构造有合法aFChunk关系/内部HTML的无害样本；开启选项时负对照能产生iframe，产品关闭选项时零iframe且如实标未支持。
4. **W3外链形状未证明被消费。**当前添加 `w:drawing/a:blip`，没有完整wp:inline/pic:pic图形结构；metrics中外联命中0、拦截数0。应使用组件实际识别的外链图片结构/已存在图片关系，并证明引用被解析。零请求可以是正确行为，但不能由未消费fixture得出。保留可达目标和正常内嵌图片对照。
5. W4返回headers但通过条件不核对；对页眉和图片实际可用性补适当断言，声明按所取得事实收窄。

此类确定性反例适合工程自动验证，不要求用户用自己的任意DOCX来证明安全边界。

## 5. 操作材料必须匹配真实入口和版本

当前源指南、v5 README/模板仍存在以下实际差异：

- 标题/适用目录/新CA说明仍写v4、六项；当前包为v5且有R7。只读核对范围和回填版本必须明确。
- R7写“拖入任一.docx”，但 `wireAttach` 只接 fileInput.onchange，源码没有 drop/dragover 上传处理器。改为「📎附件→选择文件→点击芯片」，只预览即可，不要求发起任务。
- v5未随包Word回归样本。可随操作材料提供已验证的无隐私word-rich.docx，免于用户找个人文件；人工验证覆盖正常显示，不替代§4自动安全反例。
- 指南称种子项目为“DEV25短回归”、PPT位于发送框芯片；真实种子项目为“DEV25双机验收”，PPT是一条已发仅记录消息的附件。写实际入口。
- 包内README的防火墙程序路径被模板转义成多行坏路径。应打印实际完整的 `ZhongshuoDual\resources\app\daemon\node\node.exe`，并核验生成后字节，不让用户沿坏路径配置。
- `licenses-preview-vendor/`九件文件确实存在；同时核对NOTICE内所引用的相对路径/源材料真实可达，不能仅以“九件存在”当全文路径闭环。

用户已经开始回填的模板不可覆盖；工程修订操作材料使用独立补充说明或保留原回填再追加。

## 6. 下一轮安排

用户可以先用**v5的全新隔离演练数据**做受影响项短回归，R7走真实附件选择入口；不把旧项目数据迁入该演练包。短回归通过后再Android，记录系统/浏览器版本、包身份和所用物理LAN地址。

GLM同时完成§3升级收口、§4有效反例、§5操作材料。不要改动用户正在验收的v5、数据、结果；工程修复在独立目录验证，等回填后集中处理实际失败再交付下一候选，不因每次证据或文案修订让用户重复全部手测。

旧数据升级与Android/G5仍未通过；PPT A+Word/B不集成的决定不变，零新增真实模型调用，旧批次/通知/D1–D10证据保留，价值评价、DEV-11与并行写入维持原约定。
