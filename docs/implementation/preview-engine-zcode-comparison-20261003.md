# 预览引擎选型补充：ZCode 实物与源码对照（2026-10-03）

用户在向 GLM 发第四十轮指令前补问：本机 ZCode 安装包约 170MB 能浏览文件，为什么众说似乎需要 1.57GB 插件；是否引入了超过需求的功能。

## 1. 先纠正 PDF 与 Office 转换的混淆

- 众说现有 PDF 保存、解析与视觉预览使用 PDF.js，不需要 LibreOffice。
- 本次实测 `src/ui/renderer/assets/pdfjs/` 共 171 文件、2.76MiB。这是前端 PDF.js/worker/CMap 资源，不是 PDF 能力全部依赖或整个应用体积；daemon 另有 PDF 解析代码。
- 1.57GB 是 GLM 原型解压后的完整 LibreOffice 目录，MSI 约 357MB，用于 PPTX→PDF 视觉转换，不能写成“PDF 插件必须这么大”。

## 2. ZCode 公开依赖与本机安装内容

公开 `packages/ui/package.json` 与本机 `C:/Program Files/ZCode/resources/app.asar` 元数据相互印证：

| 格式 | ZCode 对应组件 | 本机包版本 |
|---|---|---|
| PDF | pdfjs-dist / react-pdf | pdfjs-dist 5.4.296 |
| PPTX | @aiden0z/pptx-renderer | 1.2.4 |
| DOCX | @extend-ai/react-docx；另有 docx-preview | react-docx 0.8.1 |
| XLSX | @extend-ai/react-xlsx | 0.16.0 |

本机 ASAR 中实际存在 pptx-preview-viewer、pptxRendererPreviewEngine、DOCX/XLSX/PDF 预览模块；PPT 预览入口明确动态加载 PptxPreviewViewer，不仅是依赖清单上有一个未使用包。

- PPT 预览引擎产物 `pptxRendererPreviewEngine-DcwqxS2b.js` 为 1,042,714 字节（约 1MiB）；这是该入口脚本，不包含全部依赖，不能拿它当最终功能增量的完整预算。
- DOCX 的 WASM 为 1,119,333 字节；XLSX 也使用 WASM/浏览器组件，而非必须带完整桌面办公套件。
- 本机 ZCode 版本为 3.14.4，安装目录 1078 文件合计 729.9MiB；“约 170MB 安装包”来自用户描述，本次未取得原安装器重新测量。安装下载包、安装后占盘、库入口脚本是不同口径。
- 仅查安装目录中的程序文件与公开源码，没有读取用户会话、账号配置或操作 ZCode UI。

依据：

- https://github.com/zai-org/ZCode/blob/main/packages/ui/package.json
- https://github.com/aiden0z/pptx-renderer
- https://github.com/extend-hq/react-docx
- https://github.com/extend-hq/react-xlsx

## 3. 对此前建议的修正

此前把 LibreOffice 推进为默认自动配置的主路线过早。它是覆盖编辑、排版、计算等能力的办公套件，体积来自大量超出当前预览用途的能力与共同运行资源。众说当前要求的是既定七类保存/预览，以及分列的正文提取与受限模型输入，不要求内置完整 Office 编辑器。

因此：

1. **暂停默认安装/自动下载 LibreOffice 的产品化决定。**保留已经完成的原型与证据，不删除。
2. 优先验证 ZCode 使用的轻量 PPT 组件 `@aiden0z/pptx-renderer`，在众说既有渲染器中建立适配，不重写整套 UI。用同一批源文件和实际保存的 PPT，对照 ZCode/PowerPoint 或可靠参考页面；检查中文、图片、表格、图表、组合、母版/主题、页序、翻页/缩放及限制。
3. 库声明支持不等于众说已经认证。特别检查解压资源限制、外部关系/资源访问、HTML/SVG 输出与生命周期，沿用权限、版本、预算和净化边界。官方 renderer 明确保真依赖源特性，不承诺全部 PowerPoint 语义等价。
4. Word/XLSX 的可视预览按需要评估专用组件；保留已经通过的 Mammoth/SheetJS 正文与数值提取，不因换预览库连带改模型输入。React 包可用隔离适配或非 React 对应实现，不为了引一个组件重写整个应用。
5. 当前众说 PDF.js 为 4.10 分支，PPT 候选安装版本的 PDF.js peer 为 >=5 <7；其 SmartArt/EMF 嵌入 PDF 回退依赖需按固定版本实际验证，不能盲改全局 PDF.js 破坏已有 PDF 验收。
6. 若轻量方案不能满足某类文档，LibreOffice 作为复杂文档的备选增强，是否需要分发由具体缺口与用户取舍决定，不默认给每个用户安装 1.57GB 组件。
7. 在同一口径报告新增压缩包大小、展开大小、包含依赖后的实际构建增量、冷/热加载、内存与兼容范围，避免又拿 npm 包、入口文件或安装后占盘混比。

用户“无需手动配置、控制软件体积”的要求保持有效。**本补充覆盖 review-r39-next-round-20261003.md §6 中默认采用 LibreOffice 自动管理组件的路线建议**；该文其他恢复守卫、种子和交付缺口仍有效。用户正在澄清选型，尚未向 GLM 发下一轮指令，本次没有进行代码或依赖迁移。
