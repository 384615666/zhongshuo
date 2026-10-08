# 能力矩阵 R72（2026-10-08）——原始路径修复与桌面日常收口

> 基线：`capability-matrix-r71-20261008.md`（含 R72 口径注）。本轮差异：文件树 Office 容量接共享合同、Git 状态往返、/thread/:id 深链跨项目定位、逐页/数据行/全进程验证口径补齐。
> 交付：`desktop-daily-win-v10`（bld_0558b208779db4a7 / a700a58 / 593/593）。

## A. 阅读器与文件

| 能力 | 后端 | UI | 工程验证（R72 增量） | 待用户 |
| --- | --- | --- | --- | --- |
| 文件树 Office 完整读取/另存（20–32MiB） | readFull/originalFile 上限=OFFICE_MAX_BYTES(32MiB)/PDF_MAX_BYTES 分道 | ✅ | r72 G1（真 22.54MiB 树开 82 页 5.4s+另存 sha 一致）+ r67Contracts 边界用例（21MiB 过/33.5 拒/21MiB PDF 仍拒） | — |
| 上传/成果同真件分列 | uploadOffice 32MiB / fake writeFile | ✅ | r72 G1（上传 7.1s；成果落盘字节一致+同阅读器 82 页） | — |
| PPT 82 页逐页渲染 | —（renderer） | ✅ | r72 G3 walk **82/82 页 0 失败**（等真实渲染+图片解码） | 翻页观感 |
| Excel 69793 行数据正确性 | previewOffice includeBytes | ✅ | r72 G4：aria 69913+键盘滚动归零+横纵滚动+sheet 恢复+**视觉判读首/中/末行与 openpyxl 源事实全对上**（末行 DATA_AS2.BIN_01478/内部字段表） | 滚动流畅度/鼠标选择 |
| 进程资源口径 | 解析子进程 768MB/896MiB 硬界 | — | r72 G5 全进程采样：worker 峰 887MiB<硬界；关闭收拢回基线 | — |

## B. Git 与项目

| 能力 | 后端 | UI | 工程验证（R72 增量） |
| --- | --- | --- | --- |
| Git 状态往返（普通↔仓库↔错误） | git.status NOT_A_GIT_REPO 结构码 | ✅ 成功清旧 notARepo/读失败；非 Git 清投影；错误清中性 | r72 G2 七步：中性→main→中性→红→恢复 main；B(trunk)/A(main) 跨项目分列 |
| /thread/:id 深链（跨项目/冷启动） | thread.get+deepLink.resolve | ✅ locateThread+ensureProjectActive+ProjectAlign+previewSide 让位+高亮重试 | r72 G6 十步矩阵 10/10（含真跨项目、冷启动重开、不串项目） |
| 看板/待办/收藏/搜索定位 | board.view/mine.pending/saved.list/search.query | ✅ | r72 G6 各自入口→正确线程（含消息高亮） |

## C. 六来源（真件 22.54MiB PPT 重查）

| 来源 | R71 证据 | R72 修正后 |
| --- | --- | --- |
| ①房间草稿 | ✅（小件） | ✅ 真件 82 页（r72 G7） |
| ②已发根消息 | ⚠（「本次仅记录」按钮已不存在——实为 AI 派发） | ✅ ⋯ 菜单真实仅记录+DB 落库+另存 sha 一致 |
| ③线程回复附件 | ⚠（选择器命中房间输入区——非线程回复） | ✅ .col-thread 作用域+thread_id DB 断言 |
| ④私信 | ✅（小件） | ✅ 真件 82 页 |
| ⑤文件树 | ⚠（R71 只小件；大件被 20MiB 拒） | ✅ 真件 82 页+另存一致（用户原始路径） |
| ⑥成果文件 | ✅（docx/xlsx/pdf 小件） | ✅ 真件字节落盘+同阅读器（r72 G1） |

## D. 交付形态

| 项 | 结果 |
| --- | --- |
| v10 清单 | 593/593 一致（bld_0558b208779db4a7 / a700a58 / dirty=false） |
| r63 --src v10 | ok:true，realCalls=0（独立副本×真实启动器） |
| 启动器原始路径复证 | ok:true：树开真件 82 页 5.4s、p40 图 1/1 解码、console 0 错、realCalls=0 |
| 源码形态 | 全量 921/921；typecheck 0/0；r71 门回归 ok:true |

## E. 边界（如实）

- canvas 引擎选择/复制：合成输入无法驱动（键盘滚动正常）——真机鼠标选择待用户使用。
- 深链定位链低频竞态已加产品级吸收（对齐落位校验+重试）；如用户复现再独立处理。
- 既有延期（Android/签名/价值评价/DEV-11/并行写入/G5 等）不动。
