# 第四十轮复核与第四十一轮施工建议（2026-10-03）

基线：`3360817`，分支 `codex/full-implementation`。本次检查代码、原始报告、包清单并执行独立反例；没有修改正式代码、v2/v3/v4 包、用户数据或既有验收证据，没有启动产品 worker 或模型。新增的复现支架和结果仅在 `dist/desktop/review-r40/`；Word 探针运行在独立数据根的隐藏窗口。

## 1. 已核实的正向结果

- 已按用户决定接入 PPT `@aiden0z/pptx-renderer@1.3.0`、Word `docx-preview@0.4.1`。B 首版不集成、不下载；原 PDF 4.10、Mammoth、Excel 与受限模型输入合同保留。
- PPT vendor 的来源与 SHA256 已登记；EMF/PDF 回退配置为 `pdfjs:false`，没有引入可选 PDF v5。
- 新视觉字节入口走 audience 与副本完整性核验，在发送到 renderer 前执行 20MiB 上限。不能把此上限说成 renderer 解压、渲染期间的总内存或墙钟上限。
- 在途检查、带租约的人工退款保护、UNKNOWN 已结算但未确认退出、sourceRunId 不存在/跨任务/过时的旧反例已补入共享守卫与测试。
- 独立重算 v4 内全部 **588/588** 清单文件的长度与 SHA256，均与 `vdr-frozen/MANIFEST-SHA256.json` 一致，buildId=`bld_a1fcfa390ddeec46`。
- 清单文件字节总量 v3=`519826740`，v4=`522001716`，差=`2174976`（约 **2.074MiB**）；五个 vendor 文件共 `2153158` 字节（约2.053MiB）。报告约2.1MiB的量级成立，但这是展开产物增量，不是已实测的安装器压缩增量。
- 阅读了最终启动器自测归档 `dev25-dual-evidence/2026-10-031429-ddgtil/summary.txt`：两次启动、优雅停机、种子幂等与保护结果均记为通过。本次没有重新启动该验收包。

轻量选型继续有效；以下问题应先由工程修复，再让用户做受影响项短回归。

## 2. [P1] 无 workspace 租约时，人工退款仍能绕过未解除保护

位置：`src/persistence/stores/recoveryGuard.ts:42`、`:57`；`src/daemon/commands.ts:1207`、`:1278`。

本轮守卫只检查未释放租约和 UNKNOWN 状态。真实 `recovery.reconcile(notStarted, manualRiskAck=true)` 会将 turn 改为 FAILED/refunded，并明确返回 `protectionRetained=true`、`admissionReleased=false`。如果该 turn 没有 workspace 租约，两个守卫分支都会漏掉它。

### 实际复现

独立内存库正式创建 DM 和任务，仅注入 INTERRUPTED/UNKNOWN 故障形态，不注入任何租约或进程身份。之后逐步调用真实命令：

1. 对账前：`assessTaskRedispatchReadiness` 返回 `RECONCILE_REQUIRED`。
2. `recovery.reconcile(notStarted)`：返回 FAILED、refunded、`protectionRetained=true`、`admissionReleased=false`。
3. 对账后：共享守卫返回 `null`，`conversation.list` 把任务标为 `recoverable=true`。
4. `recovery.releaseProtection`：因租约数为0，直接返回“保护已收口，幂等 no-op”，没有取得退出证据。
5. `task.redispatch`：返回 `ok=true/enqueued=true`，新恢复 outbox 行数为 **1**。

结果：`dist/desktop/review-r40/recovery-no-lease-result.json`。脚本：`recovery-no-lease-probe.mjs`。用包内 Node 加 `--experimental-transform-types` 运行即可；全程内存数据库，零 worker、零模型。这个反例证明展示和派发准入失守，**不宣称实际产生过重复模型调用**。

### 修复要求

- 未解除的保护/准入和退出不确定性应有独立、持久、按 turn 归属的权威事实；不能由“没有 workspace 租约”或 FAILED/refunded 状态推出安全。
- `releaseProtection` 区分“无租约且确无待解除保护”和“无租约但保护仍保留”。后者必须核对既有正式服务端证据，不能直接 no-op 当已闭环。
- 恢复中心查询也不能只列 UNKNOWN 或有租约的 turn；否则 FAILED/refunded 的无租约保护项消失，用户无从收口。
- 可恢复性、提交前守卫、准入联动与跨重启同判同源。补无租约的人工退款反例、保留保护时零 outbox/零 startTurn、取得正式证据后恰一次恢复，以及文件库重开后仍阻断。

## 3. [P2] 旧预览能覆盖新预览；已打开的旧 viewer 未释放

位置：`src/ui/renderer/app.js:830`、`:1172`、`:1206`、`:1220`、`:432`。

`previewAttachment` 开始时只增加 generation，没有释放已有的 viewer/打开期 controller。新的 viewer 直接覆盖 `activePptxViewer` 指针。`await show(1)` 内虽检查了 generation，外层却继续执行无条件 `obox.replaceChildren(owrap)`；catch 分支同样缺失最终存活检查。

### 实际函数的确定性反例

抽取当前源码的 **原始** `previewAttachment` 和 `closeAttachPreview`，只用 DOM/vendor 桩给 A 的 `goToSlide` 设置受控延迟：

1. A 打开并等候首屏；随后 B 打开，B 已上屏。
2. 释放 A 的迟到首屏结果：A 内部 generation 检查返回，但外层仍将根内容替换成 **A.pptx**，覆盖 B。
3. A/B 两个 viewer 的 dispose 计数均为0；关闭面板后只释放 B，A 仍为0。

结果：`dist/desktop/review-r40/preview-lifecycle-result.json`；脚本：`preview-lifecycle-probe.cjs`。这是源码控制流与生命周期的受控反例，不是声称已在真人点击中复现某个特定时间窗口。

现有 `verify-preview-integration.cjs:59` 的支架会先 dispose 旧 viewer，但产品函数没有这一步；它模拟的是比产品更正确的控制流。`disposeSemantics.goAfterDispose` 当前仅得到 `Cannot read properties of null ...`，证明不了旧 viewer 自身已释放。

### 修复要求

- 所有预览入口（PPT/Word/PDF/文本/项目文件）切换时统一释放前一轮拥有的资源，再启动新轮；在途 controller/viewer 不得被新轮覆盖后遗失。
- 每个 await、异常/降级分支、页/缩放回调以及根 DOM 提交前都核对所属轮次。迟到结果只清理自身资源，不改动新轮指针或面板。
- 关闭清理旧 DOM、事件、图表、观察器等；打开失败也走同一清理路径。
- 自动化覆盖真实产品函数/页面的 A→B、PPT→Word/文本、解析/首屏/翻页中关闭、迟到成功和迟到失败；核对旧 viewer 的真实 dispose 与后续不可操作，不能只把调用变量置 null 当证明。

## 4. [P2] Word 样式未隔离，文档 CSS 可改变预览外的控件

位置：`src/ui/renderer/app.js:1013`；固定版本 `docx-preview/dist/docx-preview.js:45`、`:3374`。

把 bodyContainer 和 styleContainer 都设为预览 div，不会为其中的 `<style>` 创建 CSS 隔离边界。库将文档 styleId 拼进选择器，`escapeClassName` 只替换空格、点与 `&`，不会转义逗号等选择器语法。

### 同款组件与产品配置的实证

独立构造一个2299字节 DOCX，styleId=`probe,#host-sentinel`，样式只设置红色。使用实际随包 vendor、当前产品 `renderAsync` 参数，以及与产品相同的 CSP，在独立隐藏窗口中渲染。

输出 CSS：

```css
p.docx_probe,#host-sentinel span {
  color: #FF0000;
}
```

预览外的按钮文字由 `rgb(0, 0, 0)` 变为 `rgb(255, 0, 0)`。Mammoth 对该文件可正常提取测试正文。没有脚本执行、网络外联或高权限桥调用；不把此证据扩大成已验证的脚本/RCE 漏洞。

结果：`dist/desktop/review-r40/word-style-result.json`；样本：`style-boundary.docx`；脚本：`word-style-probe.cjs`（Electron 隐藏窗口，独立 profile）。

### 修复要求

- 采用真正隔离 CSS 的承载方式，例如经验证的 Shadow DOM 或无高权限桥的受限预览 frame；不要再用“style 节点位于 div 内”作为隔离证明，也不要另写字符串正则替代 CSS 边界。
- 固定版库 `renderAltChunks` 默认为 true，当前产品未覆盖该选项，会创建无 sandbox 的 `iframe.srcdoc`。本次只确认配置事实，未证明脚本可绕过当前 CSP。首版若不支持嵌入 HTML，则显式 `renderAltChunks:false` 并如实标注；超链接沿宿主既有策略。
- 补上述样式选择器反例和正文/图片/字体/页眉页脚/分页正例；同时覆盖 Word 的外部资源策略，不以只测试 PPT 的 HTTP 计数器泛化为 Word 也已验证。

## 5. 证据、分发材料与操作指南校正

### 冻结三连口径

实际报告同 build `bld_a1fcfa390ddeec46`：

| runId 后缀 | 项目数 | 结果 | 验证器状态 |
|---|---:|---|---|
| lo0vku | 156 | 全过 | 图表等待断言修订前 |
| p1hq4y | 156 | 全过 | 修订前 |
| an7ju9 | 156 | 图表1项失败 | 修订前，原报告保留 |
| gv7hdx | 156 | 全过 | 改为有界等待后 |

这支持“同产物三次完整通过，另有一次失败并修验证器”，不能把2份旧验证器通过+1份新验证器通过写成最终验证器下连续三连。完成本次产品修复后，使用最终验证器和同一冻结产物取得连续完整三次，失败原样留档。

### 状态文档

- `continuation.md` 顶部仍是“第三十八轮，唯一权威快照”，不是第四十轮实际状态。
- `remaining-matrix.md` 仍有 LO 方案“待用户裁决”、下一包重做 D1—D10 等陈旧状态。用户已经选 A+Word/B首版不集成，v2 D1—D10 已收案。
- 将当前状态与历史快照分开：工程缺陷、修复、包身份、人工短回归、Android 未测、G5 未通过均准确登记。

### 操作指南

- R6 预置的正常 PPT 应实际渲染图表/表格、翻页/缩放。兼容预览降级可作为另一个失败呈现测试，不能写“正常预置样本视觉不可用也算 R6 通过”。
- 包内 `SHORT-REGRESSION-template.md` 仍要求“缓存命中”，但 A 重开会重新解析。只有实际对应的缓存可单列，不以模块热加载冒充解析缓存命中。
- 用真实种子的项目名、已发附件芯片位置和模板文件名；补 Word 的简短预览操作。保持用户零 SQL/Node/开发者工具。

### 随包材料

v4 清单里没有新 preview vendor 的 PROVENANCE、LICENSE、THIRD_PARTY_NOTICES 文件；源码 NOTICE 引用的 `licenses/` 材料也未随现有3个 vendor 源文件一起带入。下一包按实际分发依赖补齐来源、许可、notice及所引用文件，核验这些路径真实存在。此处是对交付材料的检查，不代替完整法律审查。

## 6. 下一轮范围和用户操作时机

先修以上三个有反例的工程问题，保持 A+Word 的轻量决定，B不集成、不下载。相关正式链与页面反例通过后再冻结、生成独立修复包（不得覆盖 v2/v3/v4 及任何用户回填）。产品代码变更后重新核对最终产物、启动器、种子与同包二启事实。

用户随后仅做受影响项 R1–R6 短回归，再按已具备的 Android 手机执行该组合指南；不重复 v2 D1—D10。现在无需用户购置设备、安装额外服务或再次决定预览选型。

继续零新增真实模型调用；既有 r20-dm/r25-rem 和通知人工证据保留；价值评价暂停、DEV-11/并行写入增强未开放，Android/G5 不提前记通过。
