# 本机 Harness 文件预览组件对比（2026-10-03）

用户要求对比 ZCode、Codex、Kimi Code、DeepSeek Harness，并为众说借鉴选型。只读检查安装目录、ASAR 的公开程序资源和官方仓库/说明，没有启动这些应用或模型，没有读取用户会话、账号配置，没有复制其私有实现进众说。

## 1. 结论与证据口径

不存在一个各家统一采用的“全文件预览插件”。实际至少有三条路线：浏览器格式专用组件、应用自有 WASM/结构解析加视图、精简 Office 转 PDF 引擎。应用内看文件、Agent 提取正文、模型得到图片是不同能力。

本机版本：

- ZCode 3.14.4。
- Codex Windows Store 包 26.930.3930.0。
- Kimi Code 1.0.4。
- DeepSeek Harness 0.2.0-rc.2。

本机组件证据只适用于这些发行包，不能当所有版本的官方保证。Codex 官方文档未提供完整内部预览库清单，以下 Codex 组件来自安装文件与第三方声明。

## 2. 对照表

| 应用 | PDF | Word / PPT | 表格 | 可借鉴内容 |
|---|---|---|---|---|
| ZCode | pdfjs-dist 5.4.296 / react-pdf | DOCX：@extend-ai/react-docx + docx-preview；PPTX：@aiden0z/pptx-renderer 1.2.4 | @extend-ai/react-xlsx 0.16.0（WASM） | 按格式用公开专用组件、按需加载，不要求完整桌面 Office |
| Codex | pdfjs-dist 5.4.296；独立 PDF 预览模块与 Worker | 有 docx-preview 0.3.7；同时用 Walnut + .NET/WASM + Open XML 解析 Office，独立文档/演示文稿视图 | Walnut 的 XlsxReader 与 Workbook/Spreadsheet 视图 | 解析与视图分层、Worker 隔离、按格式加载；自有 Walnut 不是已确认可直接引入的公开库 |
| DeepSeek Harness | PDF.js 6.3.289 | Word/PPT 经 @deepseek-ai/libreoffice-kit 本地转 PDF，统一进入 PDF 视图 | FortuneSheet + ExcelJS(XLSX)/SheetJS(XLS)/PapaParse(CSV/TSV) | 精简转换内核、按需转换/共享请求/版本缓存/取消，以及原生表格预览分流 |
| Kimi Code | 已确认 PDF data URL/下载 URL 进入 iframe 内嵌预览 | 本次未确认专用 Word/PPT 可视渲染库 | 已确认 CSV 表格分支；未确认专用 XLSX 内核 | 文件预览面板与代码/Markdown 显示；主前端有 Monaco/Shiki 渲染选项，不能据此推成完整 Office 预览 |

Kimi 的上传 MIME 判断包含 application/pdf，不代表 Office 排版预览齐全。本次没有因库名字未出现便断言它不支持某格式，也没有把 CLI 工具与桌面查看器混写。

## 3. 关键实物

### ZCode

- 官方 packages/ui/package.json 与安装 ASAR 的依赖版本吻合；有实际 PptxPreviewViewer 加载入口。
- PPT 引擎入口脚本约 1MiB，不包含所有依赖，不能当完整功能增量。
- 安装目录约 729.9MiB；用户说的 170MB 是其安装下载包口径，非本次重新测量。

### Codex

- `app/resources/THIRD_PARTY_NOTICES.txt` 列 pdfjs-dist 5.4.296、docx-preview 0.3.7、CodeMirror 6 和 Shiki。
- ASAR 包含 `docx-preview-panel`、`pdf-preview-panel`、`walnut-reader`、DocumentFormat.OpenXml/Walnut/dotnet 的 WASM 资源、文档/演示文稿/表格组件。
- artifact-preview-loaders 的真实分支分别调用 DocxReader.ExtractDocxProto、PptxReader.ExtractSlidesProto、XlsxReader.ExtractXlsxProto，然后交对应视图。
- 这证明按格式分层解析与预览，不证明所有 Office 内容一比一还原，也不意味着可直接复制其私有 Walnut 实现。

### DeepSeek Harness：重要补充，存在比完整 LibreOffice 小很多的引擎

- 本机实际携带 `@deepseek-ai/libreoffice-kit-win32-x64@0.1.2`，展开 731 文件、**182.04MiB**。
- 单原生 helper 可执行文件约 170.31MiB，加必要资源形成上述平台包。它不是原型中 1.57GB 的完整 Office 安装镜像。
- NPM 官F 导出方元数据可获取 `@deepseek-ai/libreoffice-kit` 和平台包；本次查询 latest=0.1.5，win32-x64 平台包 unpackedSize=190868740 字节，约182.03MiB。
- HEAD 请求未给 Content-Length，本次没有测当前 tarball 压缩下载大小，不能把展开182MiB称为安装下载量。
- 官方新仓库为 **deepseek-ai/dsh-libreoffice-kit**（部分旧版包仍指向已不可访问的 deepseek-harness/libreoffice-kit）。
- 官方说明明确裁掉 Java/Python、脚本/扩展、数据库连接、帮助字典、更新等桌面能力，保留导入/布局/绘图/PD。它提供 Node API、固定平台 native 引擎或 WASM 引擎，不搜索或要求用户安装系统 LibreOffice。
- 平台包与 API 的 Node 版本、字体、VC++ 运行库、许可证材料、取消/退出与资源预算仍须在众说实测。当前众说 Node 24 满足所述最低 Node 门槛，不代表整体已经接通。
- DeepSeek 的文档预览插件将 Word/PPT 转为 PDF，但 Excel 在浏览器预览，不统一转换成 PDF；只展示缓存公式值、不自动重算。

### Kimi Code

- 本机主前端存在实际 PDF iframe 分支，src 从 data:application/pdf;base64 或下载 URL 生成；另有无法内嵌时的下载提示。
- 找到代码显示的 monaco/shiki 配置选项；没有据此宣称完整 Monaco 编辑器所有能力已接通。
- 本次未找到并确认 DOCX/PPTX/XLSX 专用可视渲染调用链。后续若要借鉴这些格式，应先做确切入口复核，不能猜为使用 PDF.js 或 LibreOffice。

## 4. 众说的调整方向

1. PDF 继续用现有 PDF.js；现有前端资源为2.76MiB，daemon 另有解析代码，PDF 不需要1.57GB Office镜像。
2. PPT 先比较 ZCode 路线 `@aiden0z/pptx-renderer` 与 DeepSeek 路线 `@deepseek-ai/libreoffice-kit`，使用相同文件、字体、参考页面，度量完整封包增量、首开/翻页/缩放/缓存、内存、取消和复杂格式。
3. Word 可评估 docx-preview/react-docx；需要更完整分页/排版时比较精简 kit 转 PDF。表格使用专门网格组件与成熟解析器，保留只读和不重算合同。
4. 不再把“轻量组件”与“完整1.57GB Office”当唯一二选一。精简 kit 是已在同类产品实际使用的第三种可运行候选。
5. 优先复用公开组件和许可允许的代码；Codex 参考分层/生命周期，不能把私有二进制当开源库直接塞入产品。
6. 字体、宏/外链、资源限制、归属权限、源版本、缓存、草稿与模型输入仍按众说合同实证。不因某家用了库就免验。
7. 用户无需手工配置，能随包的专用模块随包，重组件是否需要及如何自动管理待同口径对比决定。首次无网可用、主安装器大小和展开占盘分别报告；不预设必须下载完整 LibreOffice。

此前 review-r39-next-round-20261003.md 的恢复守卫/短回归种子缺口不受此次组件对比影响，仍需先修。用户尚在问选型，未向 GLM 发第四十轮指令，本次没有进行产品迁移。

## 5. 可核对来源

- ZCode：https://github.com/zai-org/ZCode/blob/main/packages/ui/package.json
- PPTX renderer：https://github.com/aiden0z/pptx-renderer
- DeepSeek 预览：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-documentpreview/README.md
- DeepSeek 转换服务：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/document/office-to-pdf/README.md
- 精简 kit：https://github.com/deepseek-ai/dsh-libreoffice-kit
- Kimi 公开 CLI（与本机桌面UI不混为同一代码范围）：https://github.com/MoonshotAI/kimi-code
- Codex 本机：`C:/Program Files/WindowsApps/OpenAI.Codex_26.930.3930.0_x64__2p2nqsd0c76g0/app/resources/app.asar` 及同目录 THIRD_PARTY_NOTICES.txt。

本文件是只读调查结果，不是这些候选已经在众说通过兼容认证的声明。
