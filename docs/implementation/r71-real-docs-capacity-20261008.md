# R71 真实文档容量与非 Git 收口交付（2026-10-08）

主交付 **desktop-daily-win-v9**。输入：`review-r70-verified-daily-next-round-20261008.md` + `desktop-v8-real-samples-feedback-20261008.md` + 样本 `C:\Users\user\Documents\文档测试`（只读使用，不修改原件/不外发；文件内文本均为测试内容）。R70 复核确认的核心修复保留；本轮按用户真实反馈优先完成容量与非 Git，再补齐验收余项。

## 1. 优先项：真实 PPT 容量（先修后验）

**根因**：`内蒙古职工互助系统建设方案@1010.pptx` 23,629,598B（22.54MiB）> v8 的 20MiB 上限——`resolveProjectPreviewFile` 在 stat 阶段即拒，从未进渲染器（不是渲染失败）。

**分道调整**（每道独立，护栏不取消）：

| 通道 | 旧 | 新 | 依据 |
| --- | --- | --- | --- |
| Office 保存+预览+视觉字节（OFFICE_MAX_BYTES） | 20MiB | **32MiB** | 真件 22.54MiB；渲染器 RECOMMENDED_ZIP_LIMITS（4000 条目/单条目 32MiB/总量 256MiB）远高于此 |
| ZIP 单条目声明解压（ZIP_ENTRY_MAX_BYTES） | 64MiB | **128MiB** | 真实 XLSX 单表 XML 解压 73.4MiB 被 64MiB 误拒（同类问题） |
| 解析子进程 V8 堆（PARSE_MEMORY_LIMIT_MB） | 320MB | **768MB** | 73MiB XML+SheetJS 全表对象超 320（子进程 abort 134 实测）→真件 69793 行解析 4.3s |
| 整进程提交内存（Job Object） | 384MiB | **896MiB** | 随 V8 上限同步（仍硬界；alloc 反例测试改相对常量验证不游离） |
| Office 解析截止 | 30s 默认 | **120s**（仅 office 分支） | 大表余量；仍硬截止 |
| PDF/图片/CSV | 20MiB/8MiB/5MiB | 不变 | 真件 1.9MB/2.2MB 均在内 |

超限错误全部人话化（`23,629,598B（约 22.5MiB）超过 32MiB` 式）；预览扩容**不等于**模型获得全文——提取输出仍受 PARSE_TOTAL_TEXT_MAX/SLIDES_MAX 等预算约束（分列不变）。

**真件全链验证**（verify-daily-r71 G1）：上传+保存+提取 **5.9s**；标签→首屏 **4.5s**；**82 页**（容器 82 个 slide 部件全数渲染就绪）；中页（40）图片 1/1 解码+内容非空；末页 82 到位；缩放 125%；切标签回位 **82**；另存 sha256 与原文件一致；渲染器堆 13→**111MB**。

## 2. 非 Git 目录中性态

- daemon `git.status` 对非 Git 目录保留 **NOT_A_GIT_REPO 结构码**（此前折成 VALIDATION_INVALID，UI 只能当失败渲染红面板）。
- UI：中性信息面板「此文件夹未初始化 Git——文件树与预览不受影响」；`notARepo` 状态分列；真实 Git 执行错误/权限/目录失效仍走红失败面板（不吞错）。
- 验证：G3 在**真正仓库外**的临时目录（gate 输出目录本身在 zhongshuo 仓库内——git 向上发现外层仓库是正确行为，不构成反例）实测：中性面板出现、无红面板、文件树打开 MD 正常阅读。结构码锚点进 upstreamMultiRemote 测试（永久合同测试）。

## 3. 真实样本验收（替代小夹具结论）

全部来自用户样本目录（只读复制到自有 fixtures）：

| 样本 | 结果 |
| --- | --- |
| 不动产买卖合同11.16.docx（391KB 真合同） | 分页阅读+内容+**另存 hash 一致** |
| 去重翻译表v4.xlsx（9.8MB，解压 73MiB，69793×12） | WASM 引擎渲染（单表页签条正确隐藏）+另存一致——此前被 ZIP 条目护栏整份误拒 |
| GPT-5.6 分析.pdf（1.9MB，19 页） | 全页数+跳页 |
| result.pdf（317KB） | 阅读正常 |
| QQ20260711-003638.png（2.2MB） | 解码 1043×1439 |
| 辉步记忆系统-项目详解.html（137KB） | 隔离页预览 |
| requirements-frida.txt / SKILL.md | 源码视图 / MD 排版 |

## 4. 交付真实文件与六源入口

- **fake 二进制交付**（G4）：真 DOCX/XLSX/PDF 原字节经 `writeFile`（新增 contentBase64 支持 + `ZS_FAKE_WRITE_FILES_JSON` 文件承载 MB 级 base64）自然落盘→成果报告「涉及文件」逐项「打开文件」→**同一阅读器**（DOCX 分页阅读、PDF 阅读+另存 hash 一致）。三份落盘文件与源字节 sha256 逐一相等——不手工插交付记录。
- **六真源**（G5，逐项判据缺一即 fail，不用计数阈值）：房间草稿 ✅／已发根消息（记录卡→线程附件） ✅／**线程回复附件**（新增覆盖） ✅／私信 ✅／文件树 ✅／**成果文件**（fake 交付真件入口） ✅——同一文件 SIX-SOURCE-CONTENT 六路各自打开验证。
- 合同交叉（G6）：引用卡去重提示、磁盘变更脏横幅+显式重载新内容、加载中关闭再开无残留、console 零错误。

## 5. R64 登记项与多远端复核

- **project.open DTO**：`Project` 合同 + schema 补 `rootPath`/`canonicalPath`；`rowToProject` 与新建分支两路直出（此前仅 project.list 回）。G3 + 测试双证。
- **多远端 upstream**：`upstreamMultiRemote.test.ts`（永久测试）——双远端（origin+backup）仓库，`git.branch.list` 返回 upstream=origin/main、ahead=2/behind=1，与 `git rev-list --left-right --count` 真值逐项对上；remotes 含双远端。
- 能力矩阵更新：`capability-matrix-r71-20261008.md`（后端已有/新界面接入/真实认证/工程验证/待用户确认五列分记；过期行按当前代码事实改写）。

## 6. 真窗口回弹真缺陷（R70 遗留疑点收口）

R70 复核发现「拉宽未恢复」但归因 Emulation 钳制。本轮真窗口（window.resizeTo）实测 **1283→760→1283 后 pane 608→514→380 不回弹**——确认产品真缺陷：`useThreadWidth` 在 resize 时把用户宽度永久 clamp 到下限（棘轮）。修复：删除收敛写回（显示上限由消费处动态 `min` 承担；width 只在用户拖拽时改写）。修后实测 608→514→**609** 完整回弹。G8 另证：真窗口缩窄无横向越界（画布随 stage 收缩）；DPR2 背板像素 **780=2×390**（翻页触发按新 DPR 重绘）。

## 7. 验证总账

- **verify-daily-r71.cjs** `{"ok":true,"errs":[]}`，realCallRoots **8×0**（每独立根核）。超限负对照（33.5MiB 合成件）就地人话拒绝+文件树如实。
- 全量 **920/920**（新增 upstreamMultiRemote 3 例；alloc 反例改相对常量后 Job Object 硬界语义保留）；主/hifi typecheck 0 错；**r70 门回归全绿**。
- v9 = `bld_a03ef3a265fd6513`（commit `f4fa0e4`，dirty=false，593/593）；`verify-desktop-daily-r63 --src dist/desktop/desktop-daily-win-v9` ok:true（独立副本×真实启动器）；升级门 `verify-upgrade-r67` ok（负对照 4/4）。

## 8. 未覆盖/边界（如实）

- 真件 XLSX 69793 行的引擎滚动性能未逐帧测（打开+渲染就绪已断言；行高/字号观感待用户确认）。
- `/thread/:id` 深链在 G5 场景定位不稳定（改走卡片真实路径；深链问题独立登记，不阻塞）。
- 22.54MiB PPT 的 82 页**逐页**视觉未逐一截图（首屏/中页/末页+缩略图批量渲染断言；逐页全览待用户自然使用）。
- HTML 交互脚本仍禁用；PPT「选择元素」未移植；既有延期（Android/签名/价值评价等）不动。
