# R107 真实项目请求在启动前被阻塞：统筹记录

日期：2026-10-24（Asia/Shanghai）。统筹 `01a16d02-2621-7330-afbe-b2d116627da4`，编码 `01a16bd8-dbb4-7553-93eb-aecb1395c860`。

## 用户反例与范围

用户在 V49 中打开真实 `D:/zhongshuo` 项目后，发送“你们帮我看看我们项目和 https://github.com/Gambler134201/multi-agent-collaboration 的区别，还有优势的地方”，任务立即 BLOCKED、0 回复、无运行。截图 `C:/Users/user/AppData/Local/Temp/codex-clipboard-59b4d51c-76d9-4366-9a93-2a55873db3aa.png` 已实际查看。

本轮已派给原编码会话继续处理，沿用用户授权的多个 DeepSeek Flash/max 子代理方式。编码方负责产品与原生 UI 操作，统筹独立取证/审查。必须用用户这条实际只读分析请求恢复及验收；不能以新问候成功代替。

## 统筹独立查到的事实

- 运行数据仍为原 V44 `server-data`，V49 / `bld_49b786e55f9b69ef`。
- 新项目 `prj_0a86f349-d2a3-488f-b74a-9c5f73827c1e`，canonical_path 为 `D:/zhongshuo`。
- 任务 `task_993d7e3e-ad2c-4951-a24a-a7d1a760ce0c`，房间 #1，AUTO；coordinator / frozenMemberIds / initialWakeMemberIds 只有 Claude。没有 run、turn 或真实模型调用。
- seq435 `changeset.baselineCaptured`：`fileCount=5007`、`truncated=true`，contentUnavailable 主要是 `dist/desktop` 内旧包的 Electron / DLL / Node 等产物。
- seq437 `task.contextAssemblyFailed`：`reason=write-baseline-incomplete`，明确消息为“写入基线不完整：目录扫描失败、路径被拒绝或文件清单超出安全范围，未启动模型”。
- 实际路径是 `changeset.captureBaseline → preimage.scanDirectoryFiles`，默认上限 5000，目录扫描默认只排除 `.git`；它与本来排除 dist/build 的分析 `baseline.ts` 是两套实现。
- 根卡却显示泛化“缺少必要前置成果”，详情只建议查看不存在的运行诊断。这是独立的错误投影缺口。

统筹另做有界只读 Git 文件清单统计（`GIT_OPTIONAL_LOCKS=0`）：2472 个 tracked + 101 个 non-ignored untracked，合计 2573 个唯一项目文件，低于原 5000 上限；清单不含 dist / node_modules。没有读取文件正文、改索引或调用模型。统计时点之后的本轮新增测试/文档会使数量正常增加。

## 已发送的审查要求

1. 先备份和保全原输入、任务、用户源码/WIP，再修复真实根因及主池/串/详情的启动前失败原因展示。
2. 不放宽不完整写入基线守卫、不提高上限硬扫、不忽略越界。若采用 Git 感知范围，保留 tracked（含被 ignore 但已 tracked）、dirty、有效 untracked 和原删除事实，明确未覆盖范围，不能把缺前像推导为 absent。
3. 若区分只读分析/规划，保持现有全权限和规划回合已修改成果→review 的正常路径，不能将所有 AUTO 一刀切改成只读。
4. 正式命令/worker 回归覆盖新项目首次使用、大真实工程和无 run 的失败投影；最终同一新包用原生 UI 对这条实际项目分析请求得到实质答复，保留真实调用/任务/消息链。
5. 不 commit/push、不清理用户文件、不改全局模型/凭据/权限设置、不运行 githubSandbox、不执行外部项目安装脚本；仍保留原 V44 数据根。

## 施工方案与补充审查

编码方选择以本次请求明确“仅分析”意图恢复原任务，不扩大写入扫描范围、不将 dist 排除后假称完整前像。仅分析需落到实际 adapter 的只读工具/进程策略，保持成员默认 bypass 配置与原任务 scope 不变；允许读项目/公开网页，不能只靠提示词限制写入。新请求可选择本次只读，原失败卡须直接给具体原因及“仅分析继续”。

统筹补充要求：原 task 旧 scope 为 full 时，首次只读 scope 保存在明确恢复事件中；后续普通继续、同串跟进、AUTO 子步骤、交接和恢复须继承最近明确只读意图，不能重新按成员 bypass 生成 full。已有可写会话不能复用成只读会话，真实配置/停止代次/UNKNOWN 保护仍有效。正式回归需同时保留默认可写 AUTO 修改后 review 的正例，避免全局降权限回归。

## 当前状态

**R107 / V50 本轮技术验收通过。** 用户原任务已在原项目、原消息、原 AUTO 路线上完成实质比较；未以新问候代替。编码方证据目录：`D:/zhongshuo/dist/review-r107-preflight-20261024`。

最终包 `D:/zhongshuo/dist/desktop/desktop-daily-win-v50-r107-analysis-20261024`，build `bld_64960bf21b281f99`，daemon SHA-256 `e2bc23bc6aa2d04bcc0848c5bffc5269f8cbbc748235a1f6b9dcb60390816fda`。统筹独立计算清单 595 项，无缺失或不符；已读全量 `237 文件 / 1964 测试通过`（排除 githubSandbox）、90 项正式专项及双类型检查记录。变更 lint 仍有 commands / Room / store 共 30 项既有问题，不冒称全仓通过。

## 原任务实机结果与保留边界

- 原任务 `task_993d7e3e-ad2c-4951-a24a-a7d1a760ce0c` 为 DONE / revision6；原根两条运行均 SUCCEEDED，Codex 仓库核查子任务 `task_13e4eb65-ce75-4d9b-a7ee-4367d1959dc6` 也为 DONE。
- Claude 读取本地工程后交给 Codex 核查公开仓库，再由 Claude 整合七维区别与优劣。最终可见消息 `msg_turn_abb4fa3c-dc36-42a5-837c-2c6b806f99b8_claude_final_turn_abb4fa3c-dc36-42a5-837c-2c6b806f99b8` 已由统筹直接从最终记录读取核对，原生截图 03 也已实际查看。
- 新增真实调用 4 次（账本20–23）：3 次成功、1 次因模型抄错回复目标 ID 的合同失败。通过正式 `task.redispatch` 的只读格式补交一次，绑定原输出/失败事件/结果键，不重新调查仓库；补交回合实际工具启动数为 0。原失败保留，不称全自动无失败。
- 原任务旧 full scope 原始字符串、原消息 ID、成员 profile / 模型 / 权限 / 执行程序绑定均与初始一致。仅分析范围冻结在本次明确恢复意图，四个实际 runtime session 均 `analysisOnly=true / fullAccess=false / modificationAuthorized=false`；没有将成员默认权限改掉。
- 只读执行前后 2583 个 tracked + non-ignored untracked 路径逐项相同（包含4个既有删除，保持 absent）。该清单明确不覆盖 ignored 的应用 dist 数据，不能称为全磁盘无变化证明。业务模型没有修改已比较的工程文件；随后新增的统筹/施工文档发生在此清单完成之后。
- 最终无 PENDING / DISPATCHING / RUNNING / WAITING / STOPPING / UNKNOWN turn，无未释放租约；最终一致备份实际 hash 匹配，完整性记录为 ok。

统筹独立复核文件：`coordinator-final-verification.json`。首尾截图 `01-v50-original-preflight-cause.jpg`、`03-v50-original-comparison-complete.jpg` 已实际查看且与各自 metadata 路由/build/hash相符。

完整比较文档保存在受控 artifact，并逐字复制为 [比较结果](../../dist/review-r107-preflight-20261024/zhongshuo-vs-multi-agent-collaboration-2026-10-24.md)，22,296 字节、SHA-256 `9b221d7ca3eb5ea6007b9e0efb3f7e06e641a3dffb3a2fa2f805625a9d7ef4c8`，统筹已重新计算复制文件 hash。它是应用内此次真实请求的结果，不能说是统筹此前的开源报告重新运行或人工替代模型输出。

**限制**：本轮解决只读分析的明确执行与可读恢复路径。需要写入的任务在目录基线超限/读取失败/越界时仍保守拒绝；没有提高上限、排除 dist 后伪造完整写入基线，不能宣称所有大目录可写任务已解决。截图中的原请求无需用户再次输入，已实际完成。沿用原数据使用 V50 包内 `start-existing-data.vbs`，仍指向原 V44 `server-data`，旧目录继续保留。

最终收口报告：[R107 原比较任务恢复与只读分析](r107-analysis-preflight-20261024.md)。统筹另已实际查看截图 04 的完整文档打开场景，重新核对图片 hash/build 与最终 UI 备份 `final-ui-state.sqlite` 的 6,250,496 字节/SHA-256 `d82260a32d9c7937bc9fc6beb947593863290ca01009abc039e91648ebb0dea7`。原数据启动入口、最终报告与 continuation 均已更新，V50 原数据窗口保持完整比较文档预览，本轮无需再执行模型或重建同类任务。
