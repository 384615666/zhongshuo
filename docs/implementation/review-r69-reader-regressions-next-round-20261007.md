# R69 独立复核与 R70 文件阅读器收口长任务（2026-10-07）

## 结论与复核边界

R69 有实际进展：统一格式阅读器、普通/0B/BOM/UTF-16 文本的原字节保存都已落地；但日常阅读状态、文件身份和内容完整性仍有可重复反例，不能宣布预览完成验收。下一轮先修这些，不增加新业务页面或让用户继续代找基础缺陷。

- HEAD `21908cf`，交付 v7 BUILD `bld_e6abb00832d9dce2` / commit `70b86b24f78e29b93aa664153bd131a6eba4e362`。独立核对应用清单 **593/593**，hash/字节数全一致。
- 主/hifi typecheck 各 0 错；附件相关两个集成文件 **21/21** 通过。本次没有独立重跑全量 917，不能把 GLM 全量结果称为本复核结果。
- 独立 UI 测试加载 **v7 冻结 renderer/资产**，同版本开发 Electron 隐藏窗口、独立 profile、正式命令层独立内存库与 fake worker，零用户数据写入、零真实模型调用。它是 UI 反例证明，**不冒充整个发布启动器验证**。
- 主要证据：`dist/desktop/review-r69-audit-20261007/repeat/ui-result.json`（干净独立重跑，五类反例均成立，`realCalls=0`）；PPT 媒体证据：`ppt-media-repeat/ui-result.json`（同发布 `zsres://app` 特权协议和 CSP，`realCalls=0`）。应用身份在 `identity.json`。
- 第一轮顶层目录有完整报告，也有复用 profile 的后续探针超时；该超时不算产品缺陷。以 `repeat/` 干净重跑报告为准。`ppt-media/` 初次判据把空图片集合的 every 判作 true，已保留并修正为 `ppt-media-repeat/` 的明确负结果；不得引用初次 pass 作为媒体完整性证据。
- 官方参考副本 `dist/zcode-ref` 的 HEAD 确为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。已有映射表可复用，无需再写一轮选型报告。

## 1. P1：不同中文路径被当成同一文件

真实 UI 从同一工作区点击 `甲文.md`、再点击 `乙文.md`，后者点击成功，但仍只有一个标签，标题与正文仍是甲文的 `AUDIT-FILE-A`，乙文的 `AUDIT-FILE-B` 未显示。

根因：`src/ui/hifi/data/actions-preview.ts:107` 的资源键用 `relativePath.replace(/[^a-zA-Z0-9]+/g, '_')`，把不同中文/标点路径压成相同 ID。它还会碰撞例如 `a-b.md` 与 `a_b.md`；不能再以“同路径去重”宣称身份正确。

要求：资源唯一身份按项目 ID + 完整规范路径（无损编码或稳定散列），展示名与身份分开。同名不同目录、中文路径、标点差异、多个项目都独立；版本/快照/重载/另存/摘录也要绑定具体资源。对已开错文件的负例核 UI 标题、内容、读命令路径与另存 bytes/hash，不只检查标签数。

## 2. P1：Excel 切表几秒后回到第一张

独立重跑：点击「数据录入」后 100ms / 再 1000ms 都确实切到第二张，canvas hash 也改变；再等 4000ms，选中表变回「补助模块」，canvas hash 同时回到初始值。因此不是 selector 误判或根本没点击。

R69 原报告也已记录 `checks.g4.xlsxTabSwitch=false`，但 `ok=true`，因为总判据没有纳入该项。

优先检查 `PreviewPane.tsx` 每次 render 对 PPT/XLSX `.buffer.slice(...)` 新建输入，以及 `XlsxView.tsx` 的 `file={bytes.slice(0)}`。房间/store 周期刷新产生新对象后，引擎把同一文件当新文档重开；ZCode 的传入 buffer 保持稳定。修复应稳定同一读取快照的输入身份，不能关掉权威房间刷新，不能靠更短截图等待掩盖。

要求：切表后至少跨两个实际轮询周期仍停在所选表，内容确属该表；编辑草稿、查看信息、尺寸调整不重置。文件真正变版/用户重载才按规定切换快照。

## 3. P1：PPT 页数成立但内嵌图片没显示

冻结 v7 renderer 在与发布相同的 `zsres://app` origin / CSP 下，原始 11.7MB/55 页 PPT 点击第 5 页：`pageImmediately=5`、读取时 `page=5`，主舞台三张图片 `complete=true`、`naturalWidth=0`、`srcScheme=blob`。日志有 **24 条**明确的 `blob:zsres://app/...` 图片被 `img-src 'self' data:` 拦截。不是模型图片能力门，也不是 Office 上传失败。

R69 成对图的首页标题正常，并不能覆盖有插图页面；原参考缩略图 5–7 页有具体内容，正式截图却大量留白。先修本地媒体通道与当前页稳定性，并实证图文页；保留外部资源/脚本/宏原有边界，不用取消整套 CSP 来修静态图片。

要求：同一真实文件的首页、含图片页、图表页、中间页和末页对照实际内容；主舞台与缩略图都等待真实 render ready/图片解码，核对内容完整。不能只数 `.pptx-thumb`/页码或在空白页也 PASS。

## 4. P2：切标签/收起后阅读位置丢失

独立结果：PPT 第 27 页 → 另一个文本标签 → 回 PPT = 第 1 页；PDF 第 3 页 → 另一个标签 → 回 PDF = 第 1 页；Word 内部滚动 300px → 切标签 → 回 Word = 0px。

新子阅读器自己滚动、页码/缩放/工作表都放在易卸载的组件 state；旧 `PreviewPane` 只记外层 body.scrollTop（通常是 0）。`FileStage key` 切换还会卸载阅读器。R69 的“收起保留位置”声明没有这些实证。

要求：按具体资源+读取版本存阅读状态（PPT/PDF 页与缩放、Excel 工作表与可恢复滚动、Word/MD/TXT 阅读位置）；切标签、隐藏/重开、布局切换、周期刷新都保持，同名文件互不污染。显式关闭后如何重新打开按既有合同处理，别混同隐藏与关闭。迟到渲染结果只释放自身，不覆盖新文件。

## 5. P2：PDF fit 没跟随真实面板宽度

初始 stage 583px 时 canvas 453px 正常；缩窄后 stage 389px，canvas 仍 453px，scrollWidth 487px，右侧越出容器。R69 只测一次初始 fit，没有测调整尺寸。

`PdfView.tsx` 宽度 observer 的 `useEffect([])` 初次运行时组件还返回 loading，viewportRef=null，随后 doc ready 也不重装 observer。必须在真实节点挂载后观察宽度/高度，fit 随窗口、拖分隔条、放大/还原响应。绝对缩放模式允许溢出，应和 fit 模式判据分开。另核快速翻页 renderTask 取消后恢复与较高 DPR 清晰度。

## 6. P2：Word 灰底与图标 fallback 仍在

- v7 Word wrapper 实际 `backgroundColor=rgb(128,128,128)`、`padding=30px 30px 0px`；R69 已交截图也有明显灰带。自定义 shadow style 在 renderer 后续注入默认样式之前，覆盖顺序需要实修；仅外层设 background:#fff 无效。
- Preview 的 `presentation/grid/zoom-in/zoom-out` 在 Icon 映射中不存在，实际落成黑实心圆；R69 图片可见。补已有风格中的真实图标或用受类型约束的已存在图标，不以 data-icon 属性名正确代替形状正确。
- 同时核字体/表格/分页/红字与黄高亮、完整 paper fit；用真实阅读截图证明，别只查 section 数和 table 存在。

## 7. R69 尚未完成的第三来源与事实回填

- `delivery.document` + `TaskComplete` JSON 是交付说明报告；`DeliveryDocView` 的 `files` 仍只是文字列表，不能代表“AI 实际产出的 MD/PDF/DOCX/XLSX/PPTX 文件已从成果入口进入同一阅读器”。这是 R69 原指令已要求的范围，不应又当作新功能延期。
- 用正式 fake worker 自然交付并产生真实本地文件（零真实模型调用），成果列表给文件入口，沿正式路径/权限/版本身份读取；报告与文件明确分列。工作区可变文件和固定交付快照不能互相冒充；若已有后端事实不足，落实必要合同并说明证据，不能仅提供一个报告 JSON。
- FileStage 读取工作区后只放 `worktreeSnapshots`，没有调用已 import 的 `applyWorktreeRead`，文件信息仍可能保留 `(读取时核验)` / 不准确类型。核真实 hash/字节数/编码/来源回填；还应保持 `delivery.document` 的 `hashMatch` / 真正字节数，不能把其结果丢弃后用 rawText.length 冒充 UTF-8 字节数。以上为源码确认的缺口，尚未独立跑发送链，须自行复证。

## 8. R70 验收与交付要求

1. 从 v7 冻结发布形态实跑上述反例，再修；补有意义的合同/浏览器断言。总门把每一项必要结果纳入，不允许 false/null/未运行项被忽略。
2. Excel 选择态+实际内容跨两个轮询；文件键碰撞、阅读状态、PDF resize、PPT 媒体、Word computed style/截图都进门。总门增加少量直接对应漏判的负对照，缺图片/切表失败/显示错文件应 exit 非零；每个独立 root 核 real_calls，不只查 root1。
3. 视觉验收按同文件/同页或 sheet/相同实际预览区域尺寸、DPR、主题截图；记录整个窗口与预览 rect，两者不能混同。R69 的 PDF/Word/Excel 对照使用不同夹具只能说明结构近似，不能证明参考原件版面一致；TXT/图片也没有 reference，不能统称七对成对 PASS。保留既有主池/回复串布局与左右宽度合同，不为了对照重构整款应用。
4. 同一文件从房间草稿、已发根消息、回复串、私信、文件树、真实成果文件入口打开，核具体文件内容和来源身份；关闭全部后首开、跨项目/会话、快切不串读。同源渲染器不等于六入口都测过。
5. 工程门完成再构建独立 `desktop-daily-win-v8`（若未占用）。用最终副本真实启动器+发布 zsres 协议复核，给统一结果、失败保留、未覆盖边界。无需再次做源码选型/另换 Office 引擎。
6. 用户的旧包/server-data/RESULTS/项目/配置/凭据/CA/草稿/未知账本原地保留；零新增真实模型调用，不自动重试 UNKNOWN/解除保护/扩大图片 AI 认证；迁移001–048冻结。Android、安装器签名、价值评价、DEV-11/并行写入/G5等既有延期不扩。
7. 用户暂不需要再测试 v7、复制数据根或补新的参考图。修复后只安排一次约5分钟自然确认：中文两文件不串、Excel切表保持、PPT图文页、切标签返回原位置。是否最终贴近参考由用户确认，但基础缺陷应先由工程自验收完毕。
