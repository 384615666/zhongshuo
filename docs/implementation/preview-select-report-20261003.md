# 附件预览引擎选型验证报告（2026-10-03）

**任务**：暂停第四十轮主包施工，对 PPT 视觉预览两条候选路线做同文件、同口径实测对比，给出可执行推荐。全程独立目录安装与运行（`scripts/preview-select/` + `dist/desktop/preview-select/`），未动正式源码、冻结基线、验收包与用户数据；零新增真实模型调用，未引入付费服务，未上传任何用户文档。

- **路线 A**：`@aiden0z/pptx-renderer@1.3.0`（ZCode 采用的浏览器专用组件；Apache-2.0；纯原生 ESM，**不需要 React**）
- **路线 B**：`@deepseek-ai/libreoffice-kit@0.1.5`（DeepSeek 采用的精简 LibreOffice 转换内核；MPL-2.0；Node 原生引擎 + Windows 平台包）
- 对照组：全量 LibreOffice 26.8（第三十九轮原型，358MB MSI / 1.6GB 展开）

## 0. 结论与推荐

**推荐 A（pptx-renderer）作为众说 PPT 视觉预览的默认方案；B（libreoffice-kit）保留为复杂文档/一致性兜底的备选增强，按需分发，不作默认。**

| 维度 | 结论 |
|---|---|
| 真实 Office 文件保真（8 页真机 PPT 对照） | **A 最高**（6/8 高保真，含母版/主题/表格/组合/图表结构）；B 为"接近"级（LO 字体度量类差异：断行点、中西文间距）——**口径=本批样本表现，不外推所有常规文件**（见 §9 未覆盖项） |
| 独立生成器文件（PptxGenJS 表格 4 页） | **A 4/4 通过**（零结构/数据丢失，仅边框色调/列宽折行样式差）——「稀疏表格丢网格」缺口经复核**仅限手造极简 OOXML**（无显式边框属性），不构成"AI 生成文件"类用户类型的兼容缺口 |
| 手造稀疏 OOXML 表格 | A 丢表格网格线（blocker 级，仅此类文件）；B 完好 |
| 性能 | A 显著领先（时延口径）：首开 118–144ms / 重开 17–19ms / 翻页 3–41ms / 缩放 4ms；B 冷 2.16s / 热 1.25s（另需 PDF.js 渲染）——**时延差约一个数量级；内存不是**（见下行） |
| 内存 | A renderer 工作集峰值 139–142MB（常规）/ 377–386MB（126MB 超限输入最坏，无崩溃）；B 原生 helper 峰值 202MB/次、逐次进程——**同量级，且采样对象不同**（前者=renderer 进程含 Chromium 常驻，后者=转换子进程单次峰值），不可比数量级 |
| 包增量 | **A≈1.83MB 单文件**（内捆 JSZip+ECharts）+可选 1.67MB（EMF 回退用 PDF.js v5）；**B=71.4MB 压缩下载 / 182MB 展开占盘**（正式封包增量须按安装器实测另列；B 本轮不分发）+VC++14 运行库（不随包） |
| 用户配置 | **A 零配置零依赖随包**；B 随包=分发体积显著增加，或首用时下载（破坏"首次无网可用"）；全量 LO 1.6GB 已排除 |
| 边界安全 | 双方达标（详见 §5 与 §5.1 第四十轮增补）；B 对 .pptm 直接 `unsupported-format` 拒绝（比预期更保守，安全面好） |

Word：docx-preview（0.4.1，vanilla，75KB）渲染接近 REF，接入成本低；Excel：视觉预览维持网格组件+既有解析链（SheetJS），kit 可作兜底（公式格正确显示缓存值 7，符合只读不重算合同）。

## 1. 口径与方法

- **同批文件**：三个 PPTX + 两个 Word/Excel 真样本 + 三个边界输入，A、B、全量 LO 用同一批字节。
- **参考页**：office-deck 由真 PowerPoint 2007（12.1.0.28488，COM 自动化）逐页导出 PNG 作 REF；dense/rich 手造样本 PowerPoint 打不开（COM E_FAIL，如实登记），REF 改用全量 LO 26.8 转换并明确标注；Word/Excel REF 由真 Word/Excel 导出 PDF。
- **判读**：22 张 PPT 对比图 + 3 张 Word/Excel 对比图（每页多列并排、列名标注），由视觉判读代理逐页按统一清单判级（高保真/接近/明显差异/缺失），不看图的主模型不参与判读。
- **成本**：全部依赖 tarball 实测下载字节数 + 展开实测 du + 随包口径（vendor 单文件/平台包），不拿入口脚本与安装目录互比。
- **环境**：同一台机器（Win10 x64、Node 24.16、Electron 44.4.5、VC++14 运行库已装、系统含中文字体+Office 2007+Office16 主题目录）。

## 2. 样本清单（全部落 `dist/desktop/preview-select/samples/`）

| 文件 | 来源 | 覆盖点 |
|---|---|---|
| office-deck.pptx（8 页，163 zip 项，110KB） | **真 PowerPoint 2007 保存**，ApplyTemplate(Dune.thmx) | 中文×4 字体（宋体/雅黑/楷体/SimHei）混排、密排长文、嵌入图片（青蓝 320×200）、5×4 表格（表头加粗浅蓝底）、柱状图（中文类别/系列/标题/底部图例，嵌入工作簿数据）、三形状组合+整体旋转 15°、母版标题字体颜色改写（楷体/深红）、12 版式+双主题+备注母版、**页序探针**（图片页先于密排页创建后 MoveTo 交换）、**外链双目标**（file:/// 图片外链 TargetMode=External + https://example.invalid 超链接）、逐页备注、页角 pN/8 标签 |
| dense-deck.pptx（6 页）/ rich-deck.pptx（8 页） | 第三十九轮手造规范 OOXML（复制入同批） | 长文密排折行稳定性；真实 chartSpace 图表/表格/组合/跳号页序/实体字符 |
| word-sample.docx / excel-sample.xlsx（2 表+SUM 公式） | 真 Word/Excel 2007 保存 | Word/Excel 适用性（注：docx 首段标题未插入，vision 已如实指出，不影响判读） |
| bad/corrupt.pptx（44KB，截断 40%）/ bad/huge.pptx（126MB，合法 zip+120MB 未压缩 junk）/ bad/macro-container.pptm（+4KB 伪 vbaProject.bin，关系与 ContentTypes 齐备） | 构造 | 边界：损坏/超限/宏容器 |

外链图片目标文件在参考导出后已移除（`assets/REMOVED-linked-pic.png`），A/B/LO 渲染时目标不可达——用于验证"不加载外部资源"。

## 3. 保真对比（视觉判读，REF=PowerPoint 真机导出）

### 3.1 office-deck（8 页，4 列：REF | A | B | LO-全量）

| 页 | A | B | LO 全量 |
|---|---|---|---|
| 1 封面（4 字体副标题） | 高保真 | 接近（断行点不同，"Office 样本"掉行） | 接近（同 B，字距偏宽） |
| 2 密排长文 | 高保真（断行几乎同 REF） | 接近（细微间距差） | 接近 |
| 3 嵌入图片 | 高保真 | 接近 | 接近 |
| 4 表格 | 高保真（网格+隔行底色一致） | 接近 | 接近 |
| 5 图表 | 接近（ECharts 自绘：8 柱/图例/中文类别/标题全对，绘图区比例与柱宽微差） | **高保真** | 高保真 |
| 6 组合+旋转 | 高保真 | 接近 | 接近 |
| 7 母版/主题继承 | 高保真（楷体深红标题+主题色矩形） | 接近 | 接近 |
| 8 外链 | 接近（灰底英文占位框"Image not found"——未加载外链✓，占位文案英文） | 接近（外链区域纯空白——未加载✓） | 接近（同 B） |

页序探针：三列页角 p1/8–p8/8 全部与所在页序一致；无豆腐字、无内容缺失、无结构性塌陷。

### 3.2 dense-deck（6 页，REF=LO-全量）

A：6/6 接近——**零丢行/零截断/零溢出**，但字重偏粗、ASCII 空格丢失（"第 1 页"→"第1页"）、疑似行交叠横线伪影（样式级，内容无损）。B：6/6 高保真（与全量 LO 几乎逐像素同构——**精简 kit 未损失 LO 渲染能力**，两列同源差异属渲染引擎特性而非裁剪）。

### 3.3 rich-deck（8 页，REF=LO-全量）

B：8/8 高保真。A：7/8；**page-04 表格退化为纯文本、边框网格完全丢失（blocker，仅见于手造稀疏表格——该文件未写显式边框属性，LO 补默认网格而 A 不补）**；page-03 ECharts 图表信息无损但几何风格不同（偏小偏细+多画轴刻度）。真实 PowerPoint 保存的表格（office-deck p4）A 渲染完好——**A 的表格缺口集中在"稀疏 OOXML"这类非常规文件**。

### 3.4 判读要点汇总

- A 的问题：稀疏表格无网格、ECharts 图表几何微差、缺图英文占位、密排字重偏粗/空格丢失（手造样本）。
- B（与全量 LO 同源）的问题：标题断行点漂移、中西文与标点间距系统性偏大——**LO 家族字体度量特性，精简版与全量版表现一致**。
- 双方对超链接与外链图片均**未发起加载**（A=占位框、B/LO=空白），符合众说外链禁止合同。

## 4. 性能与资源（同机同批实测）

| 指标 | A（Electron renderer 内） | B（kit 原生进程） | 全量 LO（对照） |
|---|---|---|---|
| 首开（office-deck） | **144ms**（模块 52+fetch 2+open 90） | 冷 **2159ms** / 热 1251ms | 7345ms |
| 重开/缓存命中 | 17–19ms（**重解析**——仅模块加载复用；不等于附件解析缓存命中） | 1251ms（**字体元数据热路径**——不等于跳过转换） | — |
| 翻页 | 3–33ms/页（含渲染完成事件） | —（PDF 逐页渲染 100–300ms 级，见 pdf-render-summary） | — |
| 缩放 180% | 4ms | —（PDF 端即时） | — |
| Word/Excel | docx-preview 渲染 15ms | docx 709ms / xlsx 709ms | — |
| 内存峰值 | 常规 134MB；126MB 超限输入最坏 379MB（fetch 缓冲主导，**不崩溃**） | helper 202MB/次，逐次进程即起即收 | 620MB |
| 进程模型 | 无新进程（既有 renderer） | 每次转换独立原生 helper+私有 profile，串行 | soffice.exe 树 |

dense/rich：B 673/734ms；全量 LO（第三十九轮数字）6085ms/543MB、5853ms/483MB（引自 dev25-pptx-lo-proto-report；本轮 office-deck 重跑 7345ms/620MB 与其同量级）。

## 5. 边界与安全（全部实测）

| 输入/场景 | A | B |
|---|---|---|
| corrupt.pptx（截断 zip） | 干净拒绝 `Corrupted zip: can't find end of central directory`（2ms），窗口存活 | `invalid-document`，零输出 |
| huge.pptx（126MB/120MB 未压缩项） | 干净拒绝并指明条目与限额（`maxEntryUncompressedBytes 33554432`，203ms），窗口存活 | `input-too-large`（默认 64MiB 输入上限） |
| macro-container.pptm | **照常渲染 8 页**（浏览器无 VBA 执行面；宏部件不参与渲染） | **`unsupported-format` 拒绝**（pptm→pdf 不在白名单；比"转换但不执行"更保守） |
| 超时 | —（同步解析，无长任务） | timeoutMs=300 实测 **324ms 干净命中 `timeout`**，产物删除 |
| 取消 | AbortSignal 拒绝、后续打开正常（超限件在限额处先拒） | `render(req, signal)` **第二参数**传 signal：abort 后以调用方原因拒绝、helper 被杀、2s 后零进程、产物删除。⚠️ 初测误将 signal 放进请求对象会被**静默忽略**——集成时须按第二参数传 |
| 关闭/清理 | dispose 后窗口可复用 | dispose 后零进程；`%LOCALAPPDATA%\libreoffice-kit\Cache` 仅 `font-metadata.json` 一文件（无字体字节/文档内容） |
| 外部资源 | 不加载（占位框） | 不加载（空白） |
| 输出安全 | — | 独占创建、失败/取消即删、EEXIST 不覆盖 |

## 6. 成本同口径（实测 tarball 字节 + du）

| 口径 | A | B | 全量 LO |
|---|---|---|---|
| 随包增量（产品实际口径） | **vendor 单文件 `aiden0z-pptx-renderer.browser.es.js` 1.83MB**（内捆 JSZip+ECharts）+ 可选 EMF 回退 PDF.js v5 两文件 1.67MB（`pdfjs:false` 可关） | 平台包 tarball **71.4MB → 展开 182MB/735 文件** + API 包 104KB + koffi 等依赖（node_modules 合计 198MB） | MSI 358MB → 展开 1.6GB |
| 运行库要求 | 无（跑在既有 Electron renderer） | **Node ≥22.19**（众说 Node 24 ✓）+ **VC++ v14 x64 运行库，不随包**（本机已有；用户机需检测/引导安装） | 无额外（自带全套） |
| 字体要求 | 系统/内嵌字体（Chromium 字体栈；本机中文环境正常） | 系统+Office 补充发现（本机缺字体报告为空） | 同左 |
| 开发期 node_modules | 144MB（含 echarts 源等，非产品增量） | 198MB | — |

许可：A=Apache-2.0（内捆 echarts Apache-2.0、jszip MIT）；B=MPL-2.0（平台包含 sources/licenses 通知，需原样保留分发）。均与闭源分发兼容（MPL 为文件级 copyleft，随包保留声明即可）。

## 7. Word / Excel 适用性与接入成本

- **Word（docx-preview 0.4.1）**：真 Word 样本渲染"接近"（前两行折行与 REF 逐点一致，后段折行差 3 字符；零缺字）。vanilla UMD 75KB+JSZip 共享，接入=容器+`renderAsync`，成本约与 PPT-A 同级。kit 转 Word PDF 亦可用（709ms，折行漂移一行）。**推荐 docx-preview 作默认、kit 兜底**。
- **Excel**：本报告不测浏览器网格组件（属独立选型）。kit 转换实测：2 表 2 页 PDF、**SUM 公式格显示 7 与 REF 缓存值一致（只读展示缓存值合同成立；注：两者同缓存值不能证明不重算——将来若评估 B 的 Excel 兜底须用公式预期值与缓存值不同的反例）**、字形宽 ~8%（LO 度量特性）。众说既有 SheetJS 正文/数值链**不受本选型影响，保持不动**。
- 正文提取与模型输入链（解析池/SheetJS/Mammoth/PDF 文本层）**全部保持现状**——视觉预览是分列能力，换预览引擎不改模型输入。

## 8. 接入建议（A 方案草图，待第四十轮按此施工）

1. `aiden0z-pptx-renderer.browser.es.js` + （可选）pdfjs v5 两文件 vendor 进 `src/ui/renderer/assets/`（该目录已 gitignored、build-ui 同步——与 pdfjs 4.10 共存不冲突；EMF 回退**独立提供 v5**，绝不全局升级 4.10，保住既有 PDF 验收）。
2. 渲染入口按需动态 `import()`（首开含模块 52ms）；`renderMode:'slide'`+`goToSlide` 翻页；`zipLimits: RECOMMENDED_ZIP_LIMITS` 必传（实测对 126MB 超限件干净拒绝）；`onSlideError/onNodeError` 接入任务区提示；`dispose()` 随面板卸载。
3. 外链：保持库默认（占位框），不注入 fontFaces/外部 URL；缺图占位文案可后续本地化处理（上游字符串）。
4. 边界联动：损坏/超限件走 A 的同步错误面映射到附件面板错误态（与 B 的 ConversionError.code 同一 UI 呈现层）。
5. B 若采纳为兜底：signal 按**第二参数**传；超时预算沿用预览预算合同；平台包是否随包/按需下载由用户在"安装器 +182MB"与"首用时联网拉取"间拍板（默认建议不随包、显式开启）。

## 9. 未覆盖项（如实登记）

SmartArt/EMF 实文件（A 依赖 EMF 内嵌 PDF 回退，需 v5+实测）、WPS 新版保存的 PPTX、.ppt 97–2003 二进制（B 支持 OLE、A 不支持）、真宏 .pptm（A 渲染/B 拒绝已测，宏行为本身不在预览面）、无中文字体裸机、100+ 页超长 deck、并发多开、ARM64、RTL、暗色主题、嵌入字体受限预算实测、A 的 search/export API 面。

## 10. 证据与脚本

- 脚本（已入库 `scripts/preview-select/`）：`make-assets.mjs`、`make-office-deck.ps1`、`fix-chart-data.ps1`、`make-boundary.mjs`、`render-route-a.cjs`、`run-route-b.mjs`、`probe-route-b-edge.mjs`、`render-pdfs.cjs`、`build-compare.cjs`、`make-word-excel.ps1`、`export-excel-ref.ps1`、`render-docx-preview.cjs`、`probe-word-excel.mjs` + `deck-content.json`、`word-excel-content.json`
- 产物（gitignored `dist/desktop/preview-select/`）：`samples/`（含 bad/）、`ref/`（office 8 张真机参考+dense/rich LO 参考+word/excel 参考 PDF）、`route-a/`（三 deck 逐页 PNG+zoom+metrics.json）、`route-b/`（pdf/、逐页 PNG、metrics.json、edge-metrics.json、word-excel-metrics.json、pdf-render-summary.json）、`lo-full/`、`compare/`（25 张多列对比图）、`cost-tarballs/`（12 个依赖 tarball）、`result-office-deck.json`
- 判读：4 次视觉判读代理会话（office 8 页/dense 6 页/rich 8 页/word+excel 3 张），逐页等级与问题清单已摘录于 §3
- 全量 LO 对照：本轮 office-deck 7345ms/620MB（convert-report.json 现仅存本轮条目）；dense/rich 引自第三十九轮 dev25-pptx-lo-proto-report

## 11. 不因本对比关闭的登记项

`review-r39-next-round-20261003.md` 所列恢复守卫两 P1（预算结算≠退出确认/来源归属校验）与短回归种子缺口（tasks 列缺失等）**继续挂账待修**；冻结三连与 v4 包交付不受本报告影响，等用户选定方案后随第四十轮一并施工。

## 12. 拍板结果（2026-10-03 已确认）

用户已确认（见 preview-select-decision-and-review-20261003.md §1）：**采用 A 与 Word（docx-preview）；B 首版不集成、不随包、不自动下载**，保留验证资料与接口设计。

第四十轮增补勘误与本轮新证据见文末「§13 第四十轮增补」。

## 13. 第四十轮增补（2026-10-03 集成复核后）

**口径勘误**（对上文，按 preview-select-decision-and-review §2）：
- 「常规用户文件不受影响」→ 上表已改为"本批样本表现，不外推"；§0 维度行同步修正。
- 「性能与内存均差一个数量级」→ 拆分：时延约一个数量级；内存 139–142MB vs 202MB **同量级且采样对象不同**（renderer 工作集 vs 原生 helper 单次峰值）。
- 「重开=缓存命中」→ A 重开=重解析（仅模块复用）；B 热=字体元数据热路径（不跳过转换）。分列如 §4。
- 「B 展开 182MB=安装器 +182MB」→ 压缩下载 71.4MB / 展开占盘 182MB / 正式封包增量须按安装器实测另列（B 本轮不分发）。
- Excel「SUM=7 证不重算」→ 同缓存值不能证明不重算（已改措辞）；本轮 Excel 维持现链不引 B。
- 数字绑定：报告数字来自 dist/desktop/preview-select/ 各 metrics.json（多轮本地复跑 office 首开 114–144ms 波动，属正常；单样本覆盖运行的 metrics 已另存 metrics-pptxgenjs-only.json，主 metrics.json 为全样本重跑版）。产物与样本的 runId/SHA 绑定见各 metrics 与 §10；未绑定的中间数字不作唯一证据。

**新证据（第四十轮实测，补 §3/§5 方法缺陷）**：
- **外链**：初判（目标移除后 A 占位/B 空白）不足以区分「不尝试」与「尝试后失败」。复测用**可达受控本地 HTTP 目标**（外链图片+超链接均指向计数器）+会话 webRequest 计数：**pptx-renderer 会尝试发起 2 次外链加载**（库层事实）——产品姿态=主进程会话级取消（`src/ui/main.ts` 已加 onBeforeRequest 全拒 http/https/ws），服务端命中 0。验证脚本 `scripts/verify-preview-integration.cjs`（allPass）。
- **A 取消**：初测（超限件 abort）实为 ZIP 限额拒绝、非取消证据。复测（合法 8.5MB 文件，abort 时点扫描 5/30/60/120/250/500ms）：5ms=加载期生效（`Preview aborted`）；30ms+ 时点 open 已完成（42–70ms）无取消对象。**不宣称"同步解析无长任务"**——≤20MiB 产品限额内本地 open 实测数十毫秒；生命周期释放=dispose（释放后 goToSlide 拒绝、可重开），迟到结果经 generation 门不上屏（产品同型代码验证）。
- **覆盖增补**：PptxGenJS 表格样本（PowerPoint 实开验证 4 页+参考图）A 渲染 **4/4 通过**——零结构/数据丢失，样式级差异（边框色调/列宽折行）。「稀疏表格丢网格」缺口收窄为**手造极简 OOXML**（真 Office 与独立生成器文件均不受影响）。Word 富样本（真 Word 2007 三页：页眉/页脚页码/表格/嵌入图片/8 段长文/显式分页）docx-preview 渲染 **3/3 通过**——分页位置与 REF 一致、页眉/表格/图片全渲染；限制=页脚 PAGE 字段显示缓存值"1"不随页更新（如实分列）。
