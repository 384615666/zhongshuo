# ZCode 源码对照 → 众说 R69 预览复用/适配映射（2026-10-07）

对照基线：[zai-org/ZCode](https://github.com/zai-org/ZCode) @ `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（main 浅克隆，独立只读副本 `dist/zcode-ref`）。
根 LICENSE=Apache-2.0；第三方条款见 `THIRD-PARTY-NOTICES.md`（逐组件分列，非根许可一揽子）。

## 1. 逐格式链路对照表（ZCode 源码 → 众说现状 → 本批处置）

| 格式 | ZCode 源码入口（@29628c9） | 依赖与许可 | 众说当前实现 | 本批处置 |
| --- | --- | --- | --- | --- |
| 外壳（标签/面包屑/内容三分层） | `packages/ui/src/PreviewPane.tsx`（面包屑 :1529-1728）；tab 条在 `app-shell/AnimatedSidePanePanel.tsx:942-1058` + `SidePaneTabTrigger.tsx`（图标+截断名+X、中键关、右键菜单） | 第一方 Apache-2.0 | PreviewPane 标签行+工具行+来源行+正文（自研壳）；标签无格式图标、工具行常驻按钮多 | 复刻三层结构：格式图标+名+×标签、路径面包屑行+右侧动作、格式专属底部条（仅 PPT/PDF）；引用/摘录/评论/信息收进菜单 |
| 格式分发 | `previewPaneContent.tsx`（type=text/image/media/pdf/file/pptx）；office kind=`lib/officeFilePreview.ts:13-29`（扩展名） | 第一方 | `flavorOf`（内容 kind+扩展名）；Office 统一走 previewOffice 提取面板 | 改为统一 FormatKind 分发（字节在渲染器侧解码渲染）；提取文本降级为信息/诊断 |
| TXT/代码 | `previewPaneCodeContent.tsx` + `fileService.readTextFile`（256KB 上限 :897-935） | 第一方 | `attachment.readFull` 全文 + SourceView 行号 | 保留；补 0B 空态与编码注记 |
| 图片 | `previewPaneImageContent.tsx`（object-contain、@2x 折算） | 第一方 | `attachment.previewImage` dataUrl + img | 灰舞台居中+适应/1:1/150%，能力门文案与本地预览分列（已有） |
| MD | `previewPaneMarkdownContent.tsx`（react-markdown 系） | 第一方（内部依赖 MIT） | MarkdownView（markdown-it，R39 选型） | 保留（已达标）；默认阅读视图 |
| PDF | `components/ui/pdf-viewer.tsx`（react-pdf + **pdfjs-dist@5.4.296 Apache-2.0**；单页+页码输入+缩放 %+ctrl 滚轮；cMap 资产 :24-27） | react-pdf（MIT/WTFPL→Apache 兼容链） | `attachment.previewPdf` bytesBase64 + vendored **pdfjs-dist 4.10**（`renderers.ts`）单 canvas；fit=固定 480px；正文下铺全文提取 | 沿用自有 pdfjs 4.10 链，按 ZCode 交互重做：真实面板宽适应、页码输入框 `/ N`、缩放 ±%、底部控制条；提取文本移出主体 |
| Word | `previewPaneOfficeDocxContent.tsx`（**docx-preview@0.4.0 Apache-2.0**；renderAsync 完整选项 :10-30；只缩不放 fit+ResizeObserver :68-98；去掉 wrapper 底色/纸阴影 :130-144） | docx-preview Apache-2.0 | docx-preview vendored（R39 同库）Shadow DOM 渲染 **+ 第二份净化 HTML 提取副本** | 采用 ZCode 渲染选项（ignoreLastRenderedPageBreak:true 等）+fit 缩放；**移除第二份提取副本**；提取入信息面板 |
| Excel | `previewPaneOfficeXlsxContent.tsx`（**@extend-ai/react-xlsx@0.16.0 MIT**：WASM 渲染、sheet tabs 键盘导航、只读、链接净化） | react-xlsx MIT（wasm=@dukelib/sheets-wasm 0.1.21） | `attachment.previewOffice` 提取字符串网格（merges 记录未渲染、无列标/行号/样式） | **vendoring react-xlsx 0.16.0**（PROVENANCE 钉版本+sha256；wasm 4.3MB+worker 220KB 随包），按 ZCode 用法接正式字节；失败回退=样式化网格（本表 §3） |
| PPT | `components/ui/pptx-preview-viewer.tsx`（956 行）+ `presentation/pptxRendererPreviewEngine.ts`（`parseZipLazyMedia`+`buildPresentation(lazySlides)`+每页 `renderSlide` 挂载） | **@aiden0z/pptx-renderer@1.2.4 Apache-2.0** | vendored **pptx-renderer 1.3.0**（同一库更新版，API 面一致）`PptxViewer.open` 单页模式；正文先铺全部提取文本，无缩略图/缩放/跳页 | 采用 ZCode 引擎架构：open→PresentationDocument；左缩略图列（IntersectionObserver 懒渲染）；主舞台 fit×zoom；底部条「‹ [n] / N ›｜− % +｜下载」；提取文本移出主体 |
| 打开链/多标签 | `lib/workspaceSidePane.ts`（sourceKey 去重 :943-1009；关闭其它/全部 :1982-1998；空=启动页） | 第一方 | `data/lib/resource.ts` openTab（key 去重/ordinal）+ store.preview 会话 | 保留自有会话语义（audience 隔离/收起/返回快照），标签外观对齐 |
| 空文件/过大/二进制 | `previewPaneContent.tsx:378-404`（分列弱化/警示文案） | 第一方 | 上传层拒绝（0B「文本内容为空」；>256KB 拒） | 0B 允许保存+空态展示；过大仍拒（有界合同不变） |

## 2. 依赖与许可结论

- 可直接复用（同库已在用/宽松许可）：docx-preview@（已 vendored）、pptx-renderer 1.3.0（已 vendored，**同一上游**，ZCode 用 1.2.4）、pdfjs-dist 4.10（已 vendored；ZCode 用 5.4——不升级，EMF 回退不需 pdfjs>=5）。
- 本批新 vendor：`@extend-ai/react-xlsx@0.16.0`（MIT；wasm MIT/Apache 链见包内 LICENSE）→ `src/ui/vendor/react-xlsx/`（index ESM + xlsx-worker.js + duke_sheets_wasm_bg.wasm），PROVENANCE.json 钉 sha256；随包走 assets/vendor/。
- 未采用：ZCode 的 react-pdf 包装（自有 pdfjs 足够，避免双 pdfjs 版本）；ZCode 的 AI 元素选择/评论浮层（众说无此合同）；`createCodeViewerSourceForWorkspaceFile` 的 workspace 服务层（众说走 daemon 命令合同）。
- ZCode 源码本身（Apache-2.0 第一方组件）仅作机制参考与交互复刻依据，不整文件拷贝；实现按众说 store/命令合同重写。

## 3. 回退与边界

- react-xlsx 若在 zsres 协议下 Worker/WASM 不可用 → 回退自研样式网格（parseWorker 扩展读 styles.xml fills/fonts/merges/列宽行高，SheetJS CE 不解析单元格样式→自行解析 XML）；此前 Excel 预览仍为提取网格。
- PPT/Word/PDF 渲染内存护栏（ZIP 条目数/单条目/总量、20MiB 原件上限、解析子进程截止）全部保留；嵌入对象/宏/外部关系继续不执行不加载。
- 模型注入窗（64KB 提取）与屏幕阅读（全文/渲染）分列不变；提取失败不影响已保存原件的本地预览（R69 P1 修复后分列状态）。
