# 能力矩阵 R74（2026-10-09）——两个交叉场景修复与日常使用收口

> 基线：`capability-matrix-r73-20261009.md`。本轮差异：项目打开内部取消（project.open/装载刷新两相位）、混合标签自动收起（房间/线程/私信一致判据）、阅读位置恢复缺陷修复。
> 交付：`desktop-daily-win-v12`（bld_49bb7307dfac1435 / 1dbf27b / dirty=false，593/593）。

## A. 本轮新增/修复

| 能力 | 实现 | 工程验证（r74 门/集成/启动器） | 边界 |
| --- | --- | --- | --- |
| project.open 在途取消 | openProjectByPath 收具体 NavIntent；回执后/装载刷新后核意图（零提交+焦点还原） | 集成 S2/S3（unfixed FAIL→fixed 绿）；门 G2①（真实转发层 3.2s 受控延迟：URL/active/prefs 保持 B、零旧错误）；启动器双 hash 变体 ✓（prefs 与包库核对=B） | 触屏/多窗未测 |
| 装载刷新期取消（还原） | persistNav 前核+焦点还原（仅当焦点仍指向本次结果且无更新代次） | 门 G2②（member.list:2500 确定性窗：active 还原 B、偏好不写） | — |
| thread.get 在途取消 | locateThread 安静停（R73 既有，本轮保持） | 集成 S4（零 project.open）；r73 门 G4① 回归绿 | — |
| 反序回执只落最新 | 双意图互斥（navigate 取消旧意图） | 集成 S5；门 G2③（C 落位、A 零偏好） | — |
| 混合标签自动收起 | shouldAutoHidePreviewFor（活动标签来源+explicitShow；不要求历史全部一致） | 门 G1 矩阵：room+files/thread+files/显式再往返/显式保护/跨项目/在途/DM+草稿；启动器混合场景 ✓（unfixed FAIL+视觉判读确认后修复） | 触屏未测 |
| DM 自动收起+重开入口 | DmPage 同判据+头部 PreviewReopenButton | 门 G1⑥（DM 列表/输入框正常、恢复可见） | — |
| 阅读位置恢复 | 逐帧重试到目标可达才赋值（防钳制写回）；用户滚轮/按下即停 | 门 G1①（原生滚轮 240→收起→恢复 240）；r73 门 G1 回归 | 内容变短时恢复到可达位置 |
| 上传重传口径 | uploadDiagnosed（逐次记录耗时/错误原文/artifacts 落库/分类） | 门 G3：3 次首次通过（4.7–5.1s）——15s 未复现，归类悬置（仪器常驻） | 复现前不改产品 |

## B. 既有能力回归（必要项）

| 项 | 结果 |
| --- | --- |
| PPT 页级 render-ready（R73） | 门 G4：82/82 ready 0 失败（一次解码滞后 flake→有界等待后绿，如实登记） |
| 文件树 20–32MiB 真件/另存原字节（R72） | 门 G5：82 页+sha 一致 |
| 页码/滚动保持（R70/R72） | 门 G5：切 XLSX 回 PPT 页码 40 |
| XLSX 69913 行滚动（R72） | 门 G5：aria+bottom |
| Git 中性→仓库往返（R72） | 门 G5：neutral→repo |
| r73 门整体回归（含基本三项+thread.get 取消） | ok:true errs:[]（realCallRoots 6×0） |

## C. 交付形态

| 项 | 结果 |
| --- | --- |
| v12 清单 | 593/593（bld_49bb7307dfac1435 / 1dbf27b / dirty=false） |
| r63 --src v12 | ok:true，realCalls=0 |
| 启动器发布协议复证 | ok:true（混合收起+恢复 2 标签/拖动 608→460/放大+Esc/双 hash 取消 prefs=B/正例 A；console 0；realCalls 0） |
| 源码形态 | 全量 922/922（921+新增 1）；typecheck 0/0 |

## D. 边界（如实）
- 15s 上传失败未复现——归类悬置（r73「环境抖动」维持未证实；分类仪器常驻门内）。
- 触屏/触摸板、<940px 分隔条细分、逐页像素级对照未覆盖（沿用登记）。
- 侧栏房间只列最后聚焦项目（refreshRooms 替换语义——观察登记，非本轮范围）。
- 既有延期（Android/签名/价值评价/DEV-11/并行写入/G5）不动。
