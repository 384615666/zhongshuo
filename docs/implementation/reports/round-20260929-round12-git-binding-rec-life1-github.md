# 第十二轮报告：Git 执行对象收口 · REC-LIFE-1 实施 · 真实 GitHub 补证（2026-09-29）

> 分组提交：`727c835`（Git ref/远端/软撤销/hooks——一至四合并，gitWrite 同文件交织）→ `4fb450e`（REC-LIFE-1 原生基础与正式接线）→ 本文档组。
> 数字：集成/单元 **550/552**（2 个 supervisor 满载时序 flake，隔离 11/11 通过——已知既有敏感项）+ managedLifecycle 9/9 + githubSandbox 5/5（真实网络）+ e2e 30+3skip；lint 0、tsc 0；**零模型调用**（githubSandbox 只走 Git 命令链，不派发任务）。

## 一、Git 提交目标绑定明确 ref（727c835·一）

- **缺陷修复**：CAS 目标从可变 `HEAD` 改为显式 `refs/heads/<批准分支>`——外部在检查后切到同旧 OID 的另一分支时，旧路径经 HEAD 解引用会误更新未批准分支；现被更新的永远是批准的 ref。
- 反例（受控同步点）：同 OID 双分支竞态（`_between` 接缝注入外部 checkout）→ 断言批准 ref 前进、**未批准分支保持原 OID**、HEAD 不被触碰、结果记录 `updatedRef`（不依赖事后读 HEAD 猜）。
- 目标 ref 删除/重建、detached、外部推进由 ref 级 CAS 旧值核对拒绝；提交后核对=目标 ref==提交对象+tree 一致（HEAD 仅附注）。

## 二、push/pull 绑定实际执行对象（727c835·二）

- **推送源=不可变提交 OID**（refspec `<expectedHead>:refs/heads/<branch>`）——校验后本地分支前进的未确认提交不可能被发往远端（bare remote 反例断言远端 log 不含未确认提交）；移除「本地 HEAD==确认值」预检。
- **目的地三重绑定**：远端名→实际地址（`remote get-url` 确认+执行前复核，配置变化拒绝）→远端头（严格相等）→快进。**语义机械化为「远端旧头严格等于确认值」**：`--force-with-lease=<branch>:<确认旧头>`——lease 不符即拒（不是强推）；快进预检保留。
- 副作用后网络失败/核对变化→不确定分类（同号重试按远端现值三态裁决：=目标既成事实/=旧值重推/其他人工核对），不盲目重发；**全部远端输出与 URL 凭据脱敏**（scheme://user:pass@、?token= 打码）后才进消息/UI/日志。
- pull：fetch 对象固化为 OID 后 `merge --ff-only <OID>`（不引用可变 FETCH_HEAD）。

## 三、commit.undo 保护索引（727c835·三）

- **弃用 `reset --mixed`**（它会改写索引、丢用户暂存内容）：软撤销=仅对目标 ref 做 CAS 回退（`update-ref refs/heads/<branch> <parent> <commitOid>`），索引与工作区零接触。
- 关键 fixture（索引 A 只在暂存、工作区 B 不同）：撤销后 `git show :a.txt` 仍=A、工作区文件仍=B、a.txt 暂存+未暂存两态原样（AM）；核对=索引 tree 身份不变 + porcelain 变化 ⊆ 提交文件集合。
- 重叠（提交文件∩当前暂存）明确拒绝；merge 提交拒绝（不默认选父）；后续提交/切分支由 ref CAS 拒；崩溃重试按 ref 现值三态核对（=父既成事实/=待撤销续跑/其他人工核对），不重复退。

## 四、hooks/签名边界静态说明→检测阻塞（727c835·四）

- `commitWorkflowConflicts` 检测：`core.hooksPath`/`.git/hooks` 下 pre-commit/prepare-commit-msg/commit-msg/post-commit 存在、`commit.gpgsign=true` → 预览 blocker + 提交前置复检——**内置提交阻塞并说明原因**（不静默绕过、不设全局绕过、不改用户配置）；预览 notes 如实描述实际执行路径（commit-tree 不跑钩子/不签名）。fixture：hook 文件+gpgsign 配置（不调真实签名）；移除后恢复。
- 长期方案差异记录：可选增强=按既有确认模式给单次绕过选择（本轮保守=只阻塞）；不建议产品代跑用户钩子（改变内置原子 CAS 路径）。

## 五、REC-LIFE-1 正式实施（4fb450e，非再写方案）

**两点修正落实**：①koffi=N-API 预编译，按加载进程宿主构建——daemon 是系统 Node 子进程，无需 Electron 双编译假设；②「曾纳管+daemon 已死+PID 不存在」**不替代**完整退出证据——releaseEvidence 要求根退出∧句柄已关∧计数 0，句柄不在本进程（重启后）即拒绝并进人工核对。

- **jobManager.ts**：挂起创建（CREATE_SUSPENDED）→建 job（KILL_ON_JOB_CLOSE）→挂靠→恢复——**纳管窗口为零**；管道 stdio（stdin 写入→子进程回显实测）；`activeCount`（查询失败≠0）；`terminateAll`；`releaseRootHandles`（ActiveProcesses 归零必要条件——实测确认：根退出后仍持句柄则计数>0）；纳管失败→终止挂起进程+清句柄+抛错（**不恢复执行、不降级**）。
- **接线**：bridge（ManagedChildProcess：Readable/Writable/exit/kill + 按 pid 注册表）；adapter 边界不感知受管（§8.4——注入点=cliAdapter `spawnFn`/appServerAdapter 新增 `spawnFn` 选项）；daemon entry 构造时注入（`ZS_MANAGED_RUNTIME=1`；桥不可用=**daemon 启动失败拒绝派发**；未设=维持既有路径与第九轮保守口径——按部署节奏启用）。
- **迁移 019**：`runtime_process_registry.identity_source` 增列 `'managed-job'`（重建表搬数据）；dispatchWorker 登记（bridge 按 pid 命中→managed-job）；**releaseProtection 受管证据分支**：`releaseEvidence.releasable` 才解除；句柄不在本进程→不追认。
- **验收（本地真实进程，零模型调用）9/9**：多代派生+detached 后代全归属 job/terminateAll 清零；正常关闭句柄语义（未关→不可解除；关+延迟→归零→可解除）；快速派生窗口零逃逸；stdio 契约；纳管失败不残留；**句柄持有者强杀→KILL_ON_JOB_CLOSE 兜底**（独立 holder 进程实测）；重启恢复不追认；shared 单成员退出≠job 退出（不误杀不早释）。
- **未完成（如实）**：打包链（electron-builder 集成 koffi）待 DEV-15 首次打包验证；真实 CLI（claude/codex）适配未认证——受管桥的生产 runtime 实战路径归补证窗口（本轮全部用 node 子进程 fixture）。

## 六、真实 GitHub 补证（新授权，githubSandbox 5/5）

- **仓库**：`384615666/zhongshuo-git-e2e-sandbox`（新建私有）· URL `https://github.com/384615666/zhongshuo-git-e2e-sandbox.git` · 默认分支 main（基线 `1d78626`）· 用途=众说 Git 功能真实验证；仅合成测试文件（README+test/*）；测试后保留 test/* 分支供复核。
- **全部经众说正式命令**（git.stage/commitPreview/commit/branch.create/remoteHead/push/pull）；git/gh 仅用于环境准备（建仓、基线、第二克隆模拟他人——这正是并发反例的一部分）。
- 已验证（真实网络+真实认证）：①远端事实核对（remoteHead=基线、URL 脱敏）；②命令链闭环（stage→tree 绑定 CAS 提交→两端头绑定 push→真实远端 refs 核对一致）；③并发反例（第二克隆推进远端→旧确认推送被拒、**远端未被覆盖**；分叉 pull 如实拒绝）；④pull 快进（他人提交拉回、log 断言）；⑤test/* 分支链（branch.create→提交→push→独立克隆读回文件内容）。
- 保留分支：`test/round12-<时间戳>`（每轮唯一）+ main 上的 test 提交序列；清理清单待指令（不自动删除）。
- 环境注记：github.com 偶发 TLS 握手失败（schannel）——网络环境敏感，单用例重跑即过（本轮 5/5 完整跑通）；不属于产品缺陷。
- 边界遵守：未动其他仓库/账号设置/SSH keys/默认分支/可见性/协作者/webhook/Actions；未强推未删仓；凭据未读取未打印。

## 七、剩余项

- 设置页其余真实项、merge 多父 diff 视图（依赖已满足，下一批）。
- 真实 CLI 受管路径补证（ZS_MANAGED_RUNTIME=1 × claude/codex——待真实调用窗口）；electron-builder 打包含 koffi 的可加载性（DEV-15）。
- 价值评分暂缓；旧批次剩余 3 次未动用；并行写入增强维持延期。
