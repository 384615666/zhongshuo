# 文档解析选型与能力边界（第二十九轮四——短实施说明）

日期：2026-10-01（第二十九轮施工）。本文记录 PDF 之外四类文档解析的库选型、隔离边界与
能力口径——选型即施工依据，不因选型停工；未引入任何新增付费服务或外部渠道（持续授权不
自动扩大的约束保持）。

## 执行边界（所有格式共用，第二十九轮一）

- 解析一律在**独立子进程**执行（`src/daemon/parseWorker.ts`，打包产物 `parse-worker.cjs`）：
  每任务一进程、解析后即退；daemon 主进程零解析依赖——普通 IPC、停止与其他任务不受解析
  阻塞影响（同步 CPU 阻塞被进程边界隔离，`parseBoundary.test.ts` 受控故障证明）。
- 父进程（`src/daemon/parsePool.ts`）强制：墙钟截止 30s（覆盖加载、逐项提取、结果传输、
  收拢——超时 SIGTERM→2s 宽限→SIGKILL，**exit 确认后才结算超时**）；并发=1（内存上限=
  单子进程 320MB）+等待队列 4（超队=parse-busy 明确拒绝）；响应体积防御上限 4MB；
  daemon.stop 同链 dispose（在途/排队取消、子进程杀净）。
- 输出预算：单页/单格/单附件文本上限与总量 512KB 截断（`parseContracts.ts` 常量——预算
  口型变化=旧提取缓存作废，`budgets` 字段核对）。

## 各格式选型

| 格式 | 解析实现 | 理由与边界 |
| --- | --- | --- |
| PDF | pdfjs-dist 4.10.38 legacy（纯 JS） | 沿用第二十八轮；本轮迁入子进程。`isEvalSupported:false`（不执行 PDF 脚本）、`disableFontFace/useSystemFonts:false`（不碰宿主字体）；预定义 CJK CMap（UniGB-UCS2-H 等）依赖随包 `cmaps/`（本地文件系统 CMapReaderFactory——Node fetch 不支持 file://）；加密=PasswordException 分类拒绝。**视觉渲染=渲染器受限预览侧浏览器 canvas（zsres:// 特权协议 + 随包 pdfjs ESM/worker/cmaps）**——服务端零像素解码。 |
| DOCX | mammoth 1.13（纯 JS） | 段落/表格有序提取（extractRawText）+ 安全排版预览（convertToHtml→**服务端白名单净化**：仅 p/br/strong/em/u/ul/ol/li/table/thead/tbody/tr/td/th/h1-h6/blockquote，除 colspan/rowspan 外零属性，script/style 连内容丢弃；渲染器再剥一次属性=纵深）。外部关系/嵌入图片不加载；宏（macroEnabled 内容类型）在 zip 层拒绝。**版式丢失如实说明，不虚构分页**。 |
| XLSX | SheetJS CE 0.18.5（纯 JS） | 只读**缓存值**——`cellFormula:true` 仅保留 .f 标记、值恒取 .v，公式不执行；`<f>` 无 `<v>` 的格 SheetJS 会整格丢弃——解析器在解压 XML 上自查这类引用，预览窗口内以「公式无缓存值」占位+全表标注。日期按 numFmt 经 cellDates 转 ISO；合并单元格读取 `!merges`；多 sheet 按 workbook 顺序。预览窗口 200 行×32 列（窗口外如实标注，不虚构成空表）。 |
| CSV | 自研（~90 行） | 编码探测：UTF-8（fatal 严格）/UTF-8 BOM/UTF-16LE/UTF-16BE——其余（如 GBK 字节流）**明确 unsupported 列出首 8 字节**，不静默转码；RFC4180 引号转义；分隔符嗅探（`,` `;` `\t` 按首行计数）。上限 5MB/2000 行/128 列。 |
| PPTX | fflate 0.8 解压 + XML 直读（`<a:t>`） | 无轻量纯 JS PPTX 文本库可用面——幻灯片按 `ppt/slides/slideN.xml` 编号序、备注 `notesSlideN.xml` 同法；**页图渲染=unsupported 如实**（与文本输入能力分别认证）。 |

## zip 护栏（Office 共同）

`[Content_Types].xml` 存在性 + 条目数 ≤1500 + 单条目声明解压 ≤64MB + 总量 ≤160MB + 路径
穿越（`..`）拒绝。声明尺寸说谎的压缩炸弹：解压在子进程内爆（内存硬界 320MB OOM 崩溃）
或触发墙钟截止——父进程分类失败、daemon 不受影响（隔离内爆，不悬挂不波及）。

## 能力分列（"可上传"不等于完成——四能力分别记录）

| 能力 | PDF | DOCX | XLSX/CSV | PPTX |
| --- | --- | --- | --- | --- |
| ①保存原件 | ✅（{hash}.bin 内容寻址） | ✅ | ✅ | ✅ |
| ②预览 | ✅ 文本层分页 + **视觉 canvas**（渲染器） | ✅ 安全排版 HTML（白名单） | ✅ sheet 分页签+网格+合并/公式标注 | ✅ 按页文字+备注（页图=unsupported） |
| ③提取正文（缓存） | ✅ schema v2（预算口径绑定） | ✅ 有序文本 | ✅ 值矩阵（公式不执行） | ✅ 页序文字+备注 |
| ④受限模型输入 | ✅ 提取文本（页标注+64KB 截断） | ✅ 提取文本 | ✅ **范围窗口**（选择进输入；默认=首表 50×16 有界窗口） | ✅ 提取文本 |
| OCR | 未实现（unsupported 如实） | — | — | — |
| 模型图片输入 | 未认证（IMAGE_INPUT_UNVERIFIED 门：用户明确二选一） | — | — | 页图=unsupported |

## 幂等与缓存（第二十九轮二）

上传三层幂等（commandId 回执预查→同会话同 hash 去重→跨会话缓存复用——解析池 completed
计数证明不重复解析）；提取缓存 `artifacts.extracted_text_json` schema v2 严格校验
（结构/版本/预算/页码连续），预览侧无效即隔离重提回写，组装侧 fail-closed 不派发；解析期
间归档/audience 变化在提交事务内重检——失败不留 artifact/半截缓存/错误关联。

## 未覆盖（如实，不冒充）

- DOCX/XLSX/PPTX 的**图片/嵌入对象**不解码（文本与结构提取为界）；PPTX 页图渲染未实现。
- 图片/PDF/Office 的**评论锚点**仍按既定分批归属（本批不因文本行号评论已有而扩大）。
- Markdown 安全预览、共享预览完善（搜索/引用锚）、导出——保留剩余项。
- OCR（图片/扫描件）未实现；如需引入视觉/OCR 渠道属新增服务——按约束先给适配目标/上限/
  资源方案再询问用户，持续授权不自动扩大。
