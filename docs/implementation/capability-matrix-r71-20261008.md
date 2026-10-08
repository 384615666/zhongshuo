# 能力/入口/证据矩阵（R71 版，2026-10-08）

> 替换 `prototype-parity-matrix-r68-20261007.md` 的矩阵部分（视觉对照记录保留原文件）。
> 分列口径：**后端已有**（命令层实现）/ **新界面已接入**（hifi UI 真命令）/ **真实认证**
> （用户 runtime 实测）/ **工程验证**（零真实模型调用的门/测试证据）/ **待用户体验确认**。
> 原则：配置成功≠模型认证；fake UI 自然链≠新真实 AI 认证；不反向扩张真实能力认证。

## A. 文件预览与阅读器（R69–R71）

| 能力 | 后端已有 | 新界面已接入 | 工程验证 | 待用户确认 |
| --- | --- | --- | --- | --- |
| TXT/MD/HTML/CSV 阅读+源码切换 | attachment.readFull/project.file.readFull | ✅ 统一 FileStage | verify-r71 G2（真件 SKILL.md/requirements/辉步.html） | 阅读舒适度 |
| 0B/BOM/UTF-16/GB18030 原字节 | uploadTextRaw+decodeTextBytes | ✅ | verify-r69 G1 + r71 回归 | — |
| PNG/JPEG/GIF/WebP | previewImage（dataUrl） | ✅ | r71 G2（QQ 截图 1043×1439 解码） | — |
| PDF 分页/适应/缩放/DPR | previewPdf includeBytes | ✅ | r71 G2（19 页真件）+G8（真窗口 resize 回弹+DPR2 背板 2×） | — |
| Word 分页/表格/红字/高亮 | previewOffice includeBytes | ✅ | r71 G2（真合同 391KB）+G4（交付 docx） | 字号观感 |
| Excel WASM 引擎/回退网格 | previewOffice includeBytes（三类） | ✅ | r71 G2（9.8MB 真件 69793 行） | 行高观感 |
| PPT 缩略图/翻页/缩放/图文页 | previewOffice includeBytes | ✅ | r71 G1（22.54MiB/82 页真件全链） | — |
| 容量分道 | Office 32MiB/单条目 128MiB/PDF 20MiB/图 8MiB | ✅ 就地人话错误 | r71 G7（33.5MiB 合成件拒+MiB 文案） | — |
| 阅读状态（页/表/滚动） | —（renderer readerState） | ✅ | r70 G3+r71 回归 | — |
| 文件树同阅读器（二进制） | project.file.readFull 二进制扩展 | ✅ | r70 G5+r71 G3 | — |

## B. 附件上传与交付

| 能力 | 后端 | UI | 工程验证 | 待用户 |
| --- | --- | --- | --- | --- |
| 上传芯片/失败就地原因/重选 | upload*（分道上限） | ✅ | r71 G7 | — |
| 交付报告（TaskComplete） | delivery.document | ✅ | r70 G4+r71 G4 | — |
| 交付真实文件（自然落盘） | fake writeFile+ZS_FAKE_WRITE_FILES(_JSON) | ✅ 报告「打开文件」 | r71 G4（docx/xlsx/pdf 真字节 hash 一致） | — |
| 另存原字节一致 | originalFile | ✅ | r71 G1/G2/G4 | — |

## C. Git 与项目

| 能力 | 后端 | UI | 工程验证 |
| --- | --- | --- | --- |
| status/branch/history/diff/暂存/提交 | git.* 全命令面 | ✅（Git 页+文件页） | r66 门+r71 upstream 测试 |
| 非 Git 目录中性态 | git.status NOT_A_GIT_REPO 结构码 | ✅ 中性面板 | r71 G3（真非 Git 临时目录） |
| upstream/ahead/behind 多远端真值 | for-each-ref+rev-list（null=未知） | ✅ | r71 upstreamMultiRemote 测试（origin+backup, ahead=2/behind=1） |
| project.open rootPath/canonicalPath | ✅ R71 DTO | ✅ | r71 G3+测试 |
| pull/push expectedHead | git.pull/push | ✅ | r66 门 |

## D. runtime 与模型

| 能力 | 后端 | UI | 认证状态 |
| --- | --- | --- | --- |
| 成员 runtime 绑定（claude/codex） | memberRuntime+installations | ✅ 绑定表单 | 配置≠认证（如实分列，未新认证） |
| 真实模型派发 | dispatch 正式链 | ✅ | 复用用户既有认证；R71 零新增真实调用 |
| 图片 AI 输入 | IMAGE_INPUT_UNVERIFIED 门 | ✅ 二选一 | 未认证（不扩大） |

## E. 延期（不动）

Android/安装器签名/更新/价值评价/DEV-11/并行写入/G5/HTML 交互脚本/PPT「选择元素」。
