# R69 文件预览集中修复与统一阅读器交付（2026-10-07）

主交付 **desktop-daily-win-v7**。对照源码：zai-org/ZCode @`29628c9acdb81b703bbd4080c207a0e7ce5e276e`（独立只读副本 `dist/zcode-ref`；逐格式映射表见 `zcode-preview-mapping-r69-20261007.md`）。用户参考五图+状态截图原件：`dist/desktop/review-r68-preview-audit-20261007/`。

## 1. P1 修复（独立反例 → 已修 → 已验）

| 反例 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- |
| 房间草稿 TXT/PNG 点「预览」无面板、无读取命令（DM 正常） | 首开转换 effect 在 PreviewPane 内，而 RoomPage 只在 `preview.tabs` 非空才挂 PreviewPane → 循环依赖死锁 | `store.openPreview(target)` 在调度层**同步**登记资源+开标签（`contextTargetFromRoute`/`registerAttachmentResource` 移入 store）；组件桥接 effect 删除 | G1 首开文本内容可见；G6 DM/已发消息/关闭全部后再首开 |
| 用户真实 PPT（11.7MB/55 页）被 `docx-macro` 整份拒绝 | parseWorker 对 `[Content_Types].xml` 全文 `includes('macroEnabled')`——内嵌 xlsb 部件声明污染主演示文稿定类 | `classifyOfficeMain`：包根 officeDocument 关系→主 part content type 定类；宏判定只看主 part（.pptm/.docm/.xlsm 拒）；真实文件分类器直证 `pptx/macro:false` | G3 上传→55 页缩略图/主舞台/跳页/缩放/另存 hash 一致；嵌入 xlsb 正例+宏主 part 负例（单测+G7 UI/服务端双拒） |
| 0B「失败」；UTF-16 被称「损坏字节」；UTF-8 BOM 另存丢 BOM | renderer fatal-UTF-8 解码后重编码上传（contentBase64=解码产物）；空文件 min(1) 拒 | 新命令 `attachment.uploadTextRaw`（原字节直存+hash=原字节 sha256）；`decodeTextBytes`（BOM/UTF-16LE·BE/无 BOM 启发/GB18030，控制字节=二进制判据）读链共用；0B 允许保存 | G1：0B 空态+另存 0B；BOM 阅读剥 BOM/另存含 BOM 逐字节一致；UTF-16 解码+另存一致（单测 5 例） |
| 失败原因只藏 title | 芯片仅 title 提示 | 失败行就地显示（文件/大小/原因/重选文件按钮）；就绪芯片字段统一 名称+大小+v版本+预览；空文本 AI 门（仅记录建议） | G1 exe 负例 inline 原因+重选按钮 |
| Office 解析失败吞掉整次上传 | uploadDocumentAttachment 解析失败即 throw（原件已落盘却失败） | 软失败（非宏/非 zip 护栏/确为 Office zip）→ 建 artifact（kind 按扩展名）+`extraction:'failed'` 分列；同会话同 hash 去重；previewOffice 提取不可用时返回字节+分列态（注入侧既有 fail-closed 保持） | G7 损坏 docx：上传成功+警示芯片+预览明确失败态+可下载原件 |

## 2. 统一阅读器（对照参考五图）

- **壳**（PreviewPane 重写）：标签条（格式着色图标+截断名+×；右端 收起/放大/更多）→ 面包屑行（来源+路径+会话标签+阅读/源码切换+下载）→ 内容区 →（PPT/PDF）底部控制条。引用/摘录/信息/评论收进 ⋯ 菜单；工程字段进文件信息对话框。会话合同全保留（audience 隔离/收起保留位置/单区域/返回快照/版本·hash 身份）。
- **fileSource 统一字节链**：附件=`attachment.originalFile`/`previewImage`/`previewPdf(includeBytes)`/`previewOffice(includeBytes)`/`readFull`；工作区=`project.file.readFull`（**扩展二进制**：图片/PDF/Office 白名单+按类上限 8MB/20MiB，文本走同一 decodeTextBytes）；交付=`delivery.document`。→ FormatKind 分发，所有入口同一阅读体验。
- **PPT**（ZCode 引擎架构）：vendored pptx-renderer 1.3.0（ZCode 用同库 1.2.4）`parseZipLazyMedia`+`buildPresentation(lazySlides)`+每页 `renderSlide`；左缩略图列（IntersectionObserver 懒渲染+页码+选中描边）、主舞台 fit×zoom、底部「‹ [页码] / 55 ›｜− 100% ＋｜下载」；提取文本移出正文。
- **PDF**：自有 pdfjs 4.10 链按 ZCode 交互重做——真实面板 contain 适应（旧=固定 480px）、页码输入 `/ 5`、缩放步进、下载；提取文本移出正文。
- **Word**：docx-preview（ZCode 同选项：breakPages/ignoreLastRenderedPageBreak/页眉脚）+只缩不放 fit+**全白连续文档流**（对照参考）；Shadow DOM 隔离；**不再铺第二份净化提取副本**。
- **Excel**：新依赖 **@extend-ai/react-xlsx 0.16.0**（MIT，ZCode 同款=WASM 引擎+sheet 页签+行列标+合并/列宽/填充样式真实渲染）。关键工程点：其 worker 是**裸 import fflate 的 ESM**（期望消费方 bundler 预打包）——构建期 esbuild 单独 bundle 成自包含 ESM worker（`dist/ui/renderer/hifi/xlsx-worker.js`），wasm 同目录（4.3MB，PROVENANCE 溯源）。引擎不可用时如实回退提取网格（标注无样式/合并）。
- **文件树**=同一阅读器（G5：树开用户 PPT/PNG/MD/XLSX 全链+树开 PPT 另存原字节一致——readFull 二进制扩展生效）。
- MD/TXT/HTML/CSV 沿用既有阅读（MD 排版默认/TXT 源码行号+0B 空态/HTML 沙箱 iframe/CSV 表格）。

## 3. 验证总账

- **verify-daily-r69.cjs**（真实 UI File 输入/独立数据根/发布前形态同链）：G1–G7 全绿 exit 0，`real_calls=0`。用户真件：PPT 55 页全链+另存 sha256 一致（12266155B）、PNG 1254×1254；文本四态（UTF-8/0B/BOM/UTF-16）另存逐字节一致；多页 PDF/Word、多表 Excel、MD/HTML 夹具全过；负例（pptm 宏/损坏 Office/exe）真翻 FAIL 路径。
- **视觉成对复核**（2560×1380 同视口 vs 参考图，视觉子代理逐对判定）：PPT/PDF/Word/Excel/MD/TXT/图片 7 组全 PASS（Word 首轮深灰横带=灰底舞台，已改全白连续流后复报 PASS；表格帧补验 PASS）。
- **旧门回归**：verify-daily-r68（G1–G6）适配新外壳选择器后全绿 realCalls=0；verify-parity-r66 选择器同步适配。
- **全量 vitest 917/917**（新增 r69 5 例：文本原字节族+Office 定类正负例）；主/hifi 双类型门 0 错。
- **r63 打包门**（--src v7）与 verify-desktop-daily 见 v7 包验证记录。

## 4. 真实衍生缺陷（本轮发现并修复）

1. loader 文本上传把 `fileToBase64` 的 **Promise** 直接当参数传 IPC（结构化克隆拒绝）——gate 首轮暴露。
2. FileStage 统一装载后未回填 `worktreeSnapshots`（工作区另存/脏检测失去快照源）。
3. react-xlsx worker 裸 import（上文）；zsres 协议下 Worker/WASM 本身可用（200 application/wasm）。
4. Word 视图灰底舞台与参考（全白连续流）不符——视觉门暴露。

## 5. 未覆盖/延期（如实）

- HTML 交互网页（脚本仍禁用——隔离边界合同）；SVG 阅读按文本处理。
- 图片缩放 1:1/150% 为固定档（无自由缩放/滚轮）；PDF 无连续滚动模式（单页+页码，与参考一致）。
- PPT「选择元素」/AI 元素引用（ZCode 特有合同，众说无此需求——未移植）。
- Excel 引擎失败回退网格不含样式/合并渲染（如实标注）；预置回退路径未在真机复现（引擎已可用）。
- 既有延期不扩：Android/安装器/签名/价值评价；R68 登记的 project.open 字段与多远端 upstream。
