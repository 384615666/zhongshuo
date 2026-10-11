# R75 独立复核：普通打开已修，弹窗取消与交叉打开仍抢导航（2026-10-09）

## 结论与已确认的进步

复核 HEAD `822bd11`，产品修复提交 `6ddd41e`；v13 BUILD `bld_d4510629e370c260`、dirty=false，独立逐文件大小/SHA256核验 **593/593**。主/hifi类型检查0错，相关3文件 **20/20** PASS。没有独立重跑全量922项。

冻结 v13 renderer × 匹配开发Electron × 当前正式命令/独立内存数据库，隐藏窗口与独立profile：

- R74原始普通路线：A房间→真实打开弹窗/pickFolder桥返回B→打开这个目录，最终路由/标题/lastPath均B，PASS。
- R74有效取消基线：真实弹窗先完整打开B→定位A线程→member.list装载等待期离开到设置，最终标题/lastPath恢复B、取消后零navigation.set，PASS。
- GLM最终启动器报告 `dist/desktop/r75-launcher-check-1791552420050/result.json` 已核读，普通A→B→C与重启的结果支持声明；本复核未独立重跑启动器。

以下两个新失败各在全新独立根复现两次，均real_calls=0。只保持真实member.list请求7秒以制造确定性装载窗，不替换回执内容；取消/第二次打开均点击正式界面按钮。pickFolder由自有桥返回自有目录，非操作用户系统文件选择器。这里是隔离界面反例，不扩称完整发布启动器认证。

证据总根：`dist/desktop/review-r75-audit-20261009/`。

## P1：取消打开弹窗之后，迟到的打开仍导航走

路线：在A房间→打开B弹窗→点击“打开这个目录”→project.open回执已到、B成员装载在途→点击仍可用的“取消”→点侧栏“设置”→释放旧装载回执。

第二次复现完整使用正式“设置”按钮，结果：

- `afterCancel.hash=#/settings`。
- `afterLateReply.hash=#/project/<B>/room/<B默认房间>`，标题B，lastPathB。
- 原基线lastPathA。取消没有贯通打开链，旧异步open回调仍执行最终navigate。

证据：`modal-cancel/ui-result.json`、`modal-cancel-repeat/ui-result.json`，两个pass=false，probeCompleted=true。驱动退出0表示探针完成；**产品判据失败由报告pass=false表达**，不冒充通过门。

源码对应：`pages/ProjectHome.tsx`的OpenFolderModal调用`openProjectByPath(pickedPath)`未传具体intent；“取消”仅onClose。loader对undefined intent恒认为有效，navigate虽然取消登记簿，也不能使本调用失效。函数返回后旧组件open闭包不核存活/所有权，继续onClose和navigate。

修复要求：明确打开动作的生命周期从发起、取消/卸载/被取代，到函数返回后的导航；取消或用户新导航后不再抢焦点、不写旧启动记忆/偏好、不弹旧错误。project.open已经成功注册的事实可保留，不能反向删除目录/注册记录。不靠禁用取消或锁住导航掩盖。

## P1：真正重叠B→C时，迟到B抢回C

路线：A房间→弹窗打开B，保持B成员装载→取消B弹窗→重新弹窗打开C并完成→放行B旧装载。

结果在两个全新根一致：

- `newerComplete`：路由C房间、标题Own-C、lastPathC。
- `afterLateReply`：路由B项目主页、标题Own-B，**lastPath仍C**。
- 旧回调返回B，按B落位使当前C被抢回；标题/路由与启动记忆又分裂。

证据：`overlap-opens/ui-result.json`、`overlap-opens-repeat/ui-result.json`；pass=false、completed=true、realCalls0。

源码对应：loader只在project.open回执后核`loadGen===gen`，**刷新波Promise.all之后未再核代次/当前所有权**。用户级打开未绑定intent，因此旧B在C完成后仍走persistNav并返回`{id:B}`；OpenFolderModal据此navigate(B)。登记openInFlightTarget只解决旧路由让位，不能单独解决旧异步打开回调。

R75门所谓“连开B→C”实际先await第一次modalOpenCurrentPick完成并sleep1500，然后才打开C，是串行正例。串行结果仍有效，应改称串行连续打开；不能据此证明重叠最新意图。

修复要求：project.open等待、刷新等待、动态import等待、最终偏好写入、返回目标与调用方落位，每个跨异步边界都遵从最新操作所有权。旧请求失败也应安静，不向当前C弹旧错。不要只在一个await后加布尔补丁；至少让弹窗与pickAndOpenFolder等用户打开入口遵循同一合同。

## P2：报告所称新增永久测试未出现在当前提交

R75报告/提交说明称集成测试新增lastPath/投影/用户后来选C/S3b/S3c/刷新失败取消；但`git diff e9af5ef HEAD -- tests/integration/hifiNavCancelRound74.test.ts`为空。

当前文件S3只断言navigation.set计数与active恢复，未断言lastPath/投影，也没有S3b/S3c。20/20测试通过是真实事实，**不支持这些新增判据已进入永久集成测试**。请核实是否曾临时修改但未提交/被stash还原；补齐并提交真实测试、修订总账，不删除原报告。

## 下一轮集中范围与验收

1. 保留v13普通A房间打开B与定位取消回滚正例；先复现上述两个新UI反例。
2. 打开弹窗在project.open等待/装载等待期间取消或离开，保持最新页/焦点/lastPath/服务端偏好；注册事实不删除。
3. 真正重叠B→C，分别保持B的project.open/装载回执，C先完成、B迟到及B迟到失败，全部只落实C；旧弹窗收尾不误关新弹窗。
4. 补齐可反向击穿的永久集成测试和UI判据。各阶段清楚区分正常成功、取消、被取代、失败，而不是只查标题。
5. 对之前投影回滚验证lastPath/成员/房间/私信实际归属，以及用户后来选C不会被回滚；冷房间对齐不得再次循环。沿用相关深链和预览必要回归。
6. 只在实际修复后交付v14，正常打开/关闭/再打开用户路线最终启动器复证；受控竞态证据与启动器正常证据分列。工程零真实模型调用，迁移001–048冻结，用户数据/旧包/未知账本原地不动。不扩功能/更换引擎。

用户只需v13普通打开已注册项目、在目标房间打开已有文件的2–3分钟确认；无需造在途竞态，也无需发默认AI消息。若确认已做过则继承，不重测长清单。下一轮工程完成后再给一次增量正常使用确认。
