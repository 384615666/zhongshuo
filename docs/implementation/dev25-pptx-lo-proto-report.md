# PPTX 视觉预览·LibreOffice 无界面转换原型报告（2026-10-03 第三十九轮 §4.1）

> 原型目录：`dist/desktop/pptx-lo-proto/`（tools/=LibreOffice 26.8.0 解压件；samples/；out/=全部
> 归档产物）。**实际运行原型**，非选型说明。路线：PPTX → `soffice --headless --convert-to pdf`
> → 现有 PDF.js 视觉预览链。正文提取/表格值/模型输入**不变**（previewOffice 通道照旧）——
> 转换只服务视觉预览，且**不代表图片模型输入已认证**。

## 1. 运行事实（convert-report.json）

| 项 | 实测 |
|---|---|
| 引擎 | LibreOffice 26.8.0 Win x86-64（官方 MSI 357MB → `msiexec /a` 管理解压——不装系统、不写用户配置） |
| 转换命令 | `soffice --headless --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=<独立 profile> --convert-to pdf:impress_pdf_Export` |
| 隔离 | 每样本独立 UserInstallation profile + 独立 outdir；超时 120s 强杀进程树（taskkill /T——可终止性实装） |
| 耗时 | 冷启动每样本 5.8—7.7s（独立 profile=每次冷启；同一进程连续转换会更快但牺牲隔离） |
| 峰值内存 | soffice 进程工作集 480—543MB |
| 部署体积 | 解压后 **1.57GB**（含 help；可裁剪）+ MSI 357MB 分发件 |
| 宏/外部资源 | 输入仅 .pptx（宏容器 .pptm 不入——沿用现有 zip 守卫拒绝）；样本媒体全部内嵌=零外部请求；headless 转换不触发事件宏（正式化时仍需 DisableMacros 类配置收口） |
| 字体 | **解压件不含 CJK 字体**（仅 DejaVu 等 127 个拉丁字体）——中文靠宿主机字体回退（本机微软雅黑，实测无方框/乱码）；随包部署需另配 Noto Sans CJK（约 +20—40MB）或声明宿主字体依赖 |

## 2. 真实样本页面比对（视觉三轮核验，28 张对照图归档于 out/*/compare/）

样本=规范 OOXML（升级过程见 §3 教训）：rich-deck 8 页（中文标题/嵌入图片/柱状图表/两列表格/
组合形状/跳号页序/实体字符/结束页）+ dense-deck 6 页（14 段密排中文）。

**终轮判定（视觉代理逐页核验）：LO 路线可用于视觉预览。**
- 文本/多行换行/中文：14/14 页正确，无乱码无缺字；
- 图片本体、两列表格（带边框）、组合形状（填充可见）：正确；
- 页序（sldIdLst 跳号 slide9→第 6 页）：正确；
- 实体字符（A & B、<标签>、"引号"）：单层正确，无双重转义；
- 图表：柱体+数值标签（3/5/2/7 比例正确）渲染，**坐标轴线/刻度/类别标签缺失**（最小化
  chartSpace 的保真度缺口——正式化需补轴定义或接受降级）；
- CJK 与半角符号混排有视觉间距（info 级）。

**自写 XML→SVG 路线（现行产品）定位=轻量结构预览**：文本/实体/页序正确，但版面位置整体
偏下、图表/表格/组合为占位标注（by design）。两路线非同保真对标。

## 3. 工程教训（已修入样本工厂 craftDocuments）

- **手造样本曾致 LO 全空白**：缺 `p:nvSpPr`（cNvPr 唯一 id）/`a:bodyPr`/表格 `tblGrid`/
  组合 `chOff` 时，自写解析器宽容而 **LO 严格丢弃文本**（PDF 文本层 0 字符实证）——样本
  必须规范有效（含真实 chartSpace 部件+c:crossAx 轴配对+系列填充）。
- PDF.js worker 在 file:// 页面不可用——原型 harness 用 fetch+Blob workerPort（产品内走
  zsres:// 特权协议，不受此限）。
- 截图合成竞态：首渲染需 settle 后采集+空图重采（首轮 2 页假空白实证）。

## 4. 产品化差距（如实——未在本轮实施）

1. 部署体积 1.57GB（裁剪后估计 700MB—1GB 级）——**不建议随包**；候选方案=独立安装/首次
   下载（需用户确认网络与磁盘前提），或接受「可选增强」定位（无 LO 时回退自写 SVG）。
2. 7s/样本冷启+500MB 内存——预览点击才转换（缓存绑定附件 hash/revision/audience，派生
   PDF 不跨会话借缓存）；不适合批量。
3. 图表坐标轴保真、宏禁用配置、宿主字体依赖（或随包 CJK 字体）——正式化清单。
4. 派生 PDF 与原 attachment 的 hash/revision/归属绑定+转换子进程纳管（Job Object）——
   沿 parsePool/受管执行既有模式。

## 5. 建议取舍（待用户裁决）

- 视觉预览主路线切 LO（保真），自写 SVG 保留为无依赖回退；或维持自写为主、LO 作可选增强。
- CSV Papa Parse / DOCX 导出 docx 库：分批评估未启动（本轮范围外，按原归属推进）。
