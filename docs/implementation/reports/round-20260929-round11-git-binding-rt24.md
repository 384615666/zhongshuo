# 第十一轮报告：提交内容绑定 · 任务归属双向保护 · RT-24 剩余功能（2026-09-29）

> 范围口径：全部本地/临时 Git fixture 与**临时本地 bare remote** 验证，零真实模型调用（未跑 real*；剩余 3 次未动用）。
> 既定决定保持：价值评分暂缓；DEV-11 不开放；并行写入增强延期；不触用户真实工作区/远端。
> 分组提交：`1332f00`（内容绑定+操作保护）→ `3d1a98b`（批量暂存归属+崩溃恢复）→ `44fc273`（RT-24 剩余）→ 本文档组。

## 一、提交预览内容绑定（`1332f00`）

**缺陷**：第十轮 indexDigest 只 hash XY/路径/重命名来源——同文件内容改变但路径状态不变时绑定失效。

**方案（机械消除校验-提交竞态，不只是换 hash）**：

- **绑定实际索引 tree**：预览在仓库写锁内取得一致快照（HEAD→分支→`git write-tree`→porcelain→身份），返回 `indexTree`（40 位 tree oid）——同文件内容、文件模式变化都改变 tree。
- **执行链**：`write-tree` 复核 → **`git commit-tree`（用预览时的 tree 直接构造提交对象，绕过索引）** → **`git update-ref HEAD <new> <expectedOld>`（compare-and-swap）**。CAS 失败=外部已推进→拒绝不覆盖；空仓库 unborn 分支用 ZERO 期望值；detached HEAD 拒绝产品内提交。
- **提交后核对**：HEAD/分支/parent/tree 与批准对象一致才落账；CAS 后外部又推进（测试接缝 `_between` 注入真实竞态）→ `consistent:false` + `headAfterActual` 如实记录实际 HEAD——**我们构造的 commit 仍是本次结果、不把别人的 HEAD 记为本次、不回滚不 reset**，审计 `git.commitVerifyInconsistent` 留痕进人工核对。
- **外部 Git/hooks**：commit-tree 不跑 pre/post-commit 钩子、不走 commit 模板/gpgsign——预览 notes 如实告知（需要钩子的提交请用自己的 git 客户端）；外部并发由 tree 比对+CAS 兜底，产品内互斥（见下）只声称管产品内。

**关键反例（gitWrite 14→18 用例）**：暂存 A→预览→同文件暂存 B（路径/状态不变）→旧预览提交拒绝、HEAD 不变；同 HEAD 切换分支→拒绝（目标分支绑定）；提交后核对 parent/tree/ref 一致；竞态被超越→consistent:false。**锁不可重入的嵌套死锁**在开发中被抓出并修复（预览拆为持锁包装+内部快照）。

## 一 b、操作互斥与放行边界（并入 `1332f00`）

- **仓库级写互斥**：按工作树真实路径身份键（`comparisonKey(resolve(root))`）串行产品内全部 Git 写操作——await git 子进程期间不交错（用例：6 并发写深度恒 ≤1）；**两个项目行映射同一工作树也互斥**（键不按 projectId）。
- 与执行保护/撤销协调：租约活跃→写拒绝（既有）；改动集撤销未收口（in_progress/failed/conflict）→Git 写拒绝；Git 写在途→`changeset.undo` 拒绝（`repoWriteBusy` 同步探测）。
- **目录身份解析失败→写拒绝**（不再放行让 git 自行报错）；边界如实：产品内互斥不声称阻止外部 Git 客户端。

## 二、任务批量暂存双向保护与崩溃恢复（`3d1a98b`）

- **after 冻结核对**：include 候选路径的当前工作区必须与所选改动集冻结 after 一致（sha256/存在性/文件类型）。反例×3：改任务产出文件、改任务新增文件、重建任务删除文件——全部列冲突，**被保护内容零进索引**（porcelain 断言无 staged 条目）。
- **多改动集裁决**：按定型序（change_sets.rowid）版本关系，后集覆盖前集（不「先遇到就决定」），结果注明多集路径；指定旧集而工作区是新集内容→与所选 after 不符→冲突。
- **链式归属**：基线「dirty」若=项目内更早定型集的 after（任务链未提交产出）→归属任务链纳入，不误判用户改动；其余 dirty 保持冲突不自动分离。
- **集级门与归属**：reverted 整集跳过；partial/撤销未收口/清单损坏→冲突；taskId/changeSetId 跨项目拒绝。
- **持久意图（迁移 017）**：副作用前写 pending 行（commandId/参数 hash/预期 parent/tree/分支）；重试协议=回执重放→done 行重放→pending 按事实裁决：stage 全部已暂存干净=已达成、**出现新未暂存内容=拒绝同号重试（MM 状态断言：暂存的仍是旧内容）**；unstage 已不在暂存=达成/仍暂存=安全重执行；commit HEAD 未动=续跑、尾标记命中=恢复、外部推进无标记=进人工核对；无行窗口保留第十轮尾标记恢复；**同 commandId 异参数在全部恢复分支拒绝**（request_hash 比对，gitWrite 用例④）。

## 三、RT-24 剩余功能（`44fc273`，迁移 018 动作枚举扩展）

- **分支**：list（当前/列表/未提交计数）；create 绑定 expectedHead（不切换、同名如实失败、名称校验拒控制字符）；checkout 绑定当前分支+HEAD、**不自动 stash**——改动随行计数如实（e2e：切换反馈「未提交改动 1 项随行」），冲突 git 拒绝如实上抛。
- **单提交聚合 diff**（git.commitDiff）：parents/作者/任务与改动集关联（仅操作日志，外部提交零关联、merge 提交只注记不虚构）；diff-tree `--no-commit-id -r -M` 机器身份+逐文件正文。
- **push/pull（临时本地 bare remote 验收）**：`git.remoteHead` 查询；push 绑定**两端头**（本地 HEAD+远端当前头，任一变化拒绝）、仅快进不强推、推送后远端核对、崩溃重试=远端已=目标按既成事实恢复；分叉拒绝（真实第二克隆推进远端构造）；AUTH 语义映射明确错误（不改全局配置、不回显凭据）；pull=fetch+ff-only（分叉如实拒绝，不自动合并提交）。**真实远端凭据路径未验证**（零调用纪律；代码路径就绪，如实标注）。
- **conflict.content/resolve**：三方内容（:1/:2/:3）只读；解决只接受手动内容（防半写+add；无整文件一键覆盖）；非冲突路径拒绝；崩溃重试按已解决恢复。
- **commit.undo**：软回退（reset --mixed 语义）——内容回工作区、文件不删；仅限当前 HEAD（后续提交阻塞）、根提交/detached 拒绝；无历史改写无强推。
- **UI**：git-ops 区新增分支行/远端行/冲突解决区/历史 diff 展开与 HEAD 撤销按钮（轮询不重建口径不变）。

## 四、REC-LIFE-1 排期（本轮交付=排期文档，不阻塞）

`rec-life-1-plan.md` 落实用户令五的五点：①原生依赖与打包（N-API 自写 vs 现成包 spike；prebuildify+electron-rebuild，随 DEV-15 ABI 验证；打包失败=发布阻塞不降级）；②启动纳管竞态（CREATE_SUSPENDED 挂起创建→挂 job→恢复，窗口为零；无挂起能力的候选不合格，不退回观察式缓解）；③句柄生命周期与 shared/per-turn 差异（per-turn 每 turn 一 job；shared 随 daemon 生命周期+turn 级归属清单）；④daemon 崩溃后事实（KILL_ON_JOB_CLOSE 内核终止+重启后既有对账链收口，registry job 归属标记）；⑤纳管失败拒绝启动（startTurn 前置失败，不降级为不受管执行却声称安全）。排期：Git 收口后独立成批（0.5 天 spike+1-2 天实现+六条验收）；**不把普通进程组声明为 Job Object 跨平台等价物，能力矩阵按实际平台分列**。

## 五、数字与验证

- 集成/单元：**539/539**（gitWrite 18 + gitRt24 6 新增；满载时 processTreeSupervisor 盲区用例偶发时序 flake，隔离 11/11 通过，与 Git 改动无关——已记录）。
- e2e：**30 passed + 3 skipped**（real 档既定 skip；新增 RT-24 UI 用例）。lint 0、tsc 0、build:ui 通过。零真实模型调用。

## 六、剩余项（如实，不以「Git 全功能已接入」概括）

- push/pull 的**真实远端凭据路径**未验证（本地 bare remote 验证；真实补证归另批）。
- 设置页其余真实项（协作限制/文件修改策略等依赖后端命令面）待任务书逐项推进。
- REC-LIFE-1 实施（排期已定）；研讨轮迟到收口语义待定义。
- merge 提交的单提交 diff 只注记（多父对比视图未做——列为后续项，不虚构）。
