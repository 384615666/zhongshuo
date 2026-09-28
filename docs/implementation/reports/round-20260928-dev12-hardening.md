# DEV-12 四项修复（2026-09-28 第五轮·下；价值批次后工程，不触碰实验固定版本）

零模型调用；全部临时 Git/非 Git fixture + 本地故障注入验证。用户指认的四项缺口全部收口，
关键反例 7 个新增（changesetUndo +2 描述/用例、writeRootRegistry 单元 2、scan 完整性 1、
崩溃窗口 2）；全套 **412/412**、lint 0。

## 1. 扫描完整性（缺口①）

**根因**：`scanDirectoryFiles` 的 readdir/stat 失败被 `catch { continue }` 静默跳过，仍称
扫描完整；受影响子树的基线缺失在 finalize 被推导成 absent（变更前不存在）——违反三态纪律。
junction/symlink 也要递归出去后才逐文件拒绝。

**修复**（`src/daemon/preimage.ts`）：`ScanResult = { files, truncated, failedDirs, rejectedEntries }`——
readdir/stat/realpath 失败记入 `failedDirs`（完整性破口，如实落库进 change_sets.manifest）；
**进入目录前**先 realpath 核物理路径（越界 junction/symlink 记 `rejectedEntries` 拒绝进入，
零接触；复合链接环按真实路径判重终止）。空目录是合法基线（finalize 不再因 before 行数为
零拒绝——`changeset.ts`）。finalize 的合成规则：截断/失败/拒绝任一存在 → 基线无行=**unknown**
（不推导 absent）。

**反例**：空目录基线 0 文件→finalize 新文件=added→撤销回空；manifest 标记 scanFailedDirs→
finalize 新文件=undeterminable、undo=manual、文件原样保留。

## 2. 撤销执行三态与路径边界（缺口②）

**根因**：`hashIfPresent` 把所有错误归为 null（=「不存在」）——目标被目录占位/读取失败会被
当作已删除而执行误恢复；`safeJoin` 只做字符串前缀判定——基线后父目录被换成指向外部的
junction/symlink 时前缀仍在界内，撤销会把恢复内容写进外部目录。

**修复**（`src/daemon/changeset.ts`）：`probeCurrent` 三态（present+hash / absent=ENOENT /
unknown=读取失败·非普通文件——unknown **拒绝自动覆盖**，原文件不动）；`physicalPathWithinRoot`
对目标（不存在时取**最近存在祖先**）realpath 后核在 root 真实路径内——父链被换链接即拒
（外部零写入）。

**反例**：文件被同名目录占位→failed（detail 含「未知」）、占位内容原样；父目录换外部
symlink→failed（物理路径核对失败）、外部目录零写入（无权限环境如实跳过）。

## 3. 真正的崩溃恢复窗口（缺口③）

**根因**：旧实现每步「执行→立即持久化」之间无故障注入点；恢复只认 current==after——
「文件动作已成功、done 未写库」的样本会被误判成用户冲突（或重复执行）；failed 步骤在续跑
中永不重试（只处理 pending）。

**修复**：`crashAfterStepActions` 注入（rename/delete 已成功、记账前崩溃返回——步骤保持
pending）；恢复改**三向判定**（`adjudicate`）：current==after→执行；current==撤销后预期
（restore 类=before 内容 hash；delete 类=absent）→**补记 done 不重执行、不误判冲突**；
其他→conflict 不覆盖。failed 步骤在续跑装载时重置 pending（三向重验保护）。

**反例**：崩溃于第 1 个动作后→恢复时该步「补记」done、其余照常、终态 succeeded；delete
崩溃窗口同理；删存储文件制造 failed→恢复存储后续跑成功（旧实现将永远卡 failed）。

## 4. 撤销与写入准入（缺口④）

**修复**（`src/daemon/admission.ts`）：`PhysicalWriteRootRegistry`——物理目录写入占位注册表
（lockDomainsOverlap 判重叠：同目录/junction/父子目录全覆盖，大小写与分隔符归一）。
`undoChangeset` 全程持有该占位（重叠即 WORKSPACE_BUSY 拒绝并列持有者），与 workspace_leases
租约检查、同项目撤销互斥三层并存。

**保护范围如实标注（完整接通前）**：①进程内统一占位（B6 派发写档将共用同一注册表——
届时派发侧 writeRoot 准入与撤销同约束）；②workspace_leases 重叠租约检查（active/expired
都阻塞，RT-07 语义）；③同项目单撤销互斥。**未覆盖**：跨进程并发撤销（注册表进程级；跨
进程仍靠单实例锁+租约表）；写档任务派发本体（B6 未接——写档能力保持关闭，并行写入增强
仍延期 §14.7）。

**反例**：registry 单元——同目录互斥+持有者可见+释放复取；父子/大小写/分隔符变体重叠全
拒绝；无重叠目录不受影响。

## 5. 验证与提交

- 测试：changesetUndo 16（旧 9+修复 7）、preimage 单元 6、writeRootRegistry 单元 2；全套
  **412/412**；eslint 0。全部临时 fixture/故障注入，不消耗模型调用、不碰用户真实项目。
- 提交：本次（`git log -1` 见仓库）；报告本文件；总账 DEV-12 行与 continuation 同步更新。
- DEV-13 衔接（下一步，continuation 已列）：RT-03 重领对账/崩溃恢复语义的系统性用例化
  （本轮 stopRecord/UNKNOWN/三向恢复现场已备好素材）。
