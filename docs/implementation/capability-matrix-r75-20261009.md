# 能力矩阵 R75（2026-10-09）——项目切换落位/取消收口

> 基线：`capability-matrix-r74-20261009.md`。本轮差异：项目打开落位所有权（openInFlightTarget+按目标落位）、取消回滚完整性（本地记忆+整表投影）、ProjectAlign 双态缺陷修复、R74 交付文件回归修复。
> 交付：`desktop-daily-win-v13`（bld_d4510629e370c260 / 6ddd41e / dirty=false，593/593）。

## A. 本轮新增/修复

| 能力 | 实现 | 工程验证（r75 门/集成/启动器） | 边界 |
| --- | --- | --- | --- |
| 从对话/文件/设置页开项目落位 | openInFlightTarget（projectId+URL 代次）+陈旧路由让位+弹窗按返回目标 id 落位 | 门 G1 五场景（真实弹窗+pickFolder 桥，零延迟钩子）；启动器发布形态 ✓（stash 后反例 FAIL=复核签名） | 触屏未测 |
| 连开 B→C 最新意图 | 代次+目标绑定（旧链零提交） | 门 G1 场景五；集成 S5；启动器 ② | — |
| 取消回滚完整性 | 焦点+zs.lastProjectPath+rooms/members/memberRuntimes/dms（守卫：只撤销本操作拥有值；注册表不回滚） | 集成 S3/S3b（用户选 C 不被覆盖）/S3c（装载失败+取消）；门 G2③（active/lastPath 回 B+侧栏 B 房间+零 nav 写入） | — |
| 三相位取消分列 | thread.get/project.open/装载波（saved.list 受控延迟） | 门 G2①②③（URL/active/lastPath/prefs 全 B+零旧错误）；集成 S2/S3/S4 | 发布形态无钩子（bat 清洗） |
| 重启进入正确项目 | 取消不写偏好+正常打开写最后意图 | 门 G2④/G3③（重启进 B/C） | — |
| ProjectAlign 双态（衍生） | 本项目打开在途=保持对齐挂载；清理判据=URL 是否仍指向本项目 | 探针 47k 循环→31 条 6s 进房；门 G1-G3 全量正例 | — |
| 交付文档内打开文件（R74 回归） | openedFrom=当前预览上下文（不再硬编码 files 来源被自动收起） | r72 门 G1 成果文件链（82 页）修复后绿；r74 门混合矩阵回归绿 | — |
| 冷启动/跨项目深链/冷房间 | 沿用+上述所有权（合法深链不受让位影响） | 门 G3 四项；r72 门十步矩阵 | — |

## B. 既有能力回归（必要项）

| 项 | 结果 |
| --- | --- |
| R74 混合标签/恢复/阅读位置/草稿/拖动/放大/Esc | r74 门 ok:true errs:[] |
| R73 基本三项+导航取消+PPT 逐页 | r73 门 ok:true errs:[] |
| R72 容量/Git 往返/另存/XLSX/看板/待办/收藏/搜索/成果文件 | r72 门 ok:true errs:[]（G1 曾暴露交付文件回归，修复后绿） |
| 全量 | 922/922；typecheck 0/0 |

## C. 交付形态

| 项 | 结果 |
| --- | --- |
| v13 清单 | 593/593（bld_d4510629e370c260 / 6ddd41e / dirty=false） |
| r63 --src v13 | ok:true，realCalls=0 |
| 启动器发布协议复证 | ok:true（A 房间真实弹窗开已注册 B 全落位+A 保留+零 toast；再开新目录 C 最新意图；重启进 C；文件页可达；console 0；realCalls 0） |
| 工程直通（文档化） | bat 显式透传 ZS_DEV25_DEBUG_PORT/ZS_PICK_FOLDER(_FILE)（验证用；用户默认不设） |

## D. 边界（如实）
- 发布启动器无延迟钩子——装载期取消强复现在源码门/集成；启动器复核普通打开路线+重启恢复。
- r72 门两次「no such table/directory」=残留 electron 树占用户级管道名（环境清理后绿，非代码缺陷）；r72 G1 超时=R74 交付文件真回归（已修）。
- 触屏/触摸板、<940px 分隔条细分、逐页像素对照（沿用）；15s 上传未复现维持悬置；既有延期不动。
