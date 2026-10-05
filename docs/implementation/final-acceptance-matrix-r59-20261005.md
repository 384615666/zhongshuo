# 最终验收矩阵（R59 准备稿，2026-10-05）

> 目的（review-r59 §5）：为最终验收准备一份现状矩阵——旧库升级与副本回退、源码与产物
> 对应、能力分列（已认证/仅原界面/未开放）、G5 剩余条件。**只整理既有事实，不重跑无变化
> 的认证矩阵；用户未回填项一律不写 PASS。** 依据：implementation-status.md、
> hifi-capability-map-r56-20261005.md、各轮 continuation/报告；变更后按需补检。

## 1. 旧库升级与副本回退

| 面 | 现状 | 证据/机制 |
|---|---|---|
| 架构迁移 | 001→045 全量入 `src/persistence/migrations/`；打开即迁移（openDatabase 启动链） | 迁移目录 + 各轮报告 |
| 保守回填 | 042（protection_state 按事件顺序回填，损坏→retained 不默认安全）、043（矛盾/alive/exited→retained 保守分类，只降级修正 042）、044（ReleaseEvidence 完整校验，Job 优先于 alive probe）、045（Object.hasOwn 分离缺字段与损坏） | 各迁移文件头注 + 8/8 正例 |
| 升级即开 | 旧库（含 NULL 旧行）升级后：恢复事实保守保留、只回填 NULL 行、不涂改既有验收/审计记录 | 042–045 合同测试 |
| 副本回退 | 每次打开带 `backups/` 目录（openDatabase 选项）；演练/验证一律**独立数据根副本**（包验证器 h2 副本 run、OS 证据脚本 os-crash-r59-*）——交付包/用户数据零接触 | verify-hifi-package-r59.cjs、verify-os-crash-restart-r59.cjs |
| 崩溃后重开 | WAL+applyRecovery：非终态→INTERRUPTED/UNKNOWN、孤儿租约重排、需要时门禁落下；恢复对账/解除显式分开 | OS 级证据 os-crash-r59-r59-oscrash-20261005144704（含 renderer 断连/daemon 崩溃分列） |

## 2. 源码与产物对应

| 面 | 现状 |
|---|---|
| 构建门 | 打包脚本入口自建 build:ui→pack-daemon→pack-desktop 并核对退出码（任一非零中止，绝不拷旧产物——R52 教训固化） |
| 构建身份 | ZhongshuoDual/BUILD.json：buildId+commit+dirty；MANIFEST-SHA256.json 全量清单（591 项）逐件核对 |
| 包根材料 | README-H*总是写当前版（writeCurrent）；RESULTS 模板不覆盖（用户回填保护）；包验证器**包根材料门**独立核验（不符退出码 5 拒绝三连） |
| daemon 对应 | OS 证据脚本记录 dist/pack/daemon.cjs sha256 与候选包内 daemon hash 对应（v3=R58 源码构建 sameBytes=false 如实记录；v4 构建后同链复核） |
| 三连验证 | 每候选冻结产物首启/复用/重启三连（真实启动器/优雅停机/PID 归零/退出码/real_calls=0/重启轮真实恢复流）；allPass 记录于 continuation |

## 3. 能力分列（hifi 新界面）

| 分列 | 内容 |
|---|---|
| **已认证（真实链）** | 房间主池/线程卡、任务派发（DIRECT/M0 门禁）、@提及触发位置消费、回复跟进、停止（三重绑定）、验收/返工（三重身份）+**执行返工（r59 完整身份绑定）**、复制定位、关注/静音、消息引用/表情、收藏、成果与附件（类型/版本/预览）、导出（线程/DM MD·HTML·DOCX）、长历史定位补读、DM 全操作行（重命名/归档/停止/继续/中断恢复/导出）、搜索筛选、活动流、看板范围、命令面板（导航）、恢复检查（四类动作分列）、标题栏防护标识、首启欢迎/打开切换项目 |
| **仅原界面（直达入口）** | Git 写操作（commit/push/pull/undo——DEV-14 主体已验）、runtime 绑定（项目设置/成员绑定——DEV-10 生产接线）、子任务定向 E3（task.steer）、远程访问变更入口 |
| **未开放（如实）** | DELIBERATE 研讨编排（M1 显式 opt-in——真实闭环未证）、B=LibreOffice 预览（不集成——A+Word 已定）、并行写入增强（延期）、DEV-11、远程访问默认关、搜索/活动流/看板=只读聚合 |

## 4. G5（DEV-16 发布验收）剩余条件

依赖链未闭合项（据 implementation-status）：

1. **DEV-10** 生产绑定剩余：成员级 runtime 绑定界面在原界面（hifi 侧只读展示已认证）。
2. **DEV-14** 剩余：设置页其余真实项、merge 多父 diff 视图。
3. **DEV-15** 剩余：安装器/代码签名/自动更新（便携产物已交付且三连稳定）。
4. **G4 真状态**：33 次已执行，只卡**用户匿名评分**（等回填）。
5. **价值评价**（G5 关联）：延期保持——待用户显式指令重开。
6. **用户回填待办**：桌面 v3 G1–G10（进行中）、Android v6（进行中）；未回填不得写 PASS。
7. **兼容矩阵/性能**（DEV-16 本体）：未启动——等上述依赖收口后按实际组合实测，不预填。

## 5. 结论口径

- 本矩阵为**准备稿**：只列事实与剩余条件，不代替任何验收动作。
- 用户手测结果以回填为准（FAIL/NOT_RUN 如实保留）；工程验证与用户验收分列，互不代记。
- Android：继续 v6 独立（原 CA 口径），不随桌面候选连带宣布。
