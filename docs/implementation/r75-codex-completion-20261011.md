# R75 接手完成记录（2026-10-11）

用户请求由 Codex 接替 GLM 完成 R75。基线 HEAD `822bd11` / 原 v13 `bld_d4510629e370c260`；保留原已修部分，集中补齐独立复核 `review-r75-open-intent-lifetime-next-round-20261009.md`。

## 实际变更

1. 用户打开的具体 NavIntent 贯穿目录选择、命令装载与最终落位。弹窗取消/关闭/卸载会取消本次操作，旧组件收尾不导航、不弹旧错、不误关新弹窗；`pickAndOpenFolder` 同合同。
2. 取消通知即时回滚本操作仍拥有的焦点、lastPath、房间/成员/runtime/私信投影，下一次打开捕获正确基线。正式项目注册事实不撤销，不删目录或库行。被新代次取代的旧回执与旧失败安静返回无效目标。
3. 刷新波后、动态模块等待后、偏好写入、返回目标和最终落位均检查代次/归属。偏好桥的异步等待也核当前归属。
4. 最终导航纳入打开操作：先同步交接路由，再释放在途占位；hash订阅按实际路径变化去重，同步通知和原生事件不重复增代次。避免加完取消守卫后又被旧房间对齐阻止正常落位。
5. 注册表整表读取增加打开代次门，迟到的 B 快照不能抹掉后来首次注册的 C。界面验证的 C 为首次打开，不预注册来绕过该反例。
6. 实际补交永久测试：`hifiNavCancelRound74.test.ts` 从1项增为9项，并补原S3的 lastPath/完整投影/注册事实断言。原R75报告中的“新增测试已落地”声明已追加纠正，原报告保留。
7. 检查其余调用方：外部消息/任务深链在解析回执后核URL代次，跨项目打开必须接受仍有效的结果才导航；不再忽略取消后的空目标。

无数据库迁移、渲染引擎或容量变更；不改 UNKNOWN/同号人工重试/恢复保护合同，不自动发送或调用模型。用户数据、旧包、凭据、草稿未迁移。

## 验证口径

### 源码

- 相关永久测试9/9通过。
- 主/hifi双typecheck零错。
- 修改文件 lint 的25项既有错误逐条与 HEAD 比对，无新增错误；未称 lint 全绿。证据 `dist/desktop/r75-lint-delta-20261011.cjs.json`。
- 全量首次默认运行：928/929，既有进程退出观察断言出现不同unknown分支；该文件单独复跑4/4通过，未改生产进程保护或降低判据。
- 第二次全量（2 workers）：926/929，其中GitHub沙盒3项因schannel TLS失败；5项GitHub测试单独复跑5/5通过。
- 注册表新测试追加后，本地全量 **925/925**，JSON报告 `dist/desktop/r75-local-tests-20261011.json`（排除的仅GitHub沙盒文件）；外部GitHub5/5另列。随后外部深链守卫的小改动完成相关两文件10/10复验、双typecheck和最终界面门。不冒称一次执行930/930。

### 隔离 UI

`scripts/verify-r75-completion.cjs`：真实React组件/按钮 + pickFolder窄桥 + 正式命令 + 每场景独立内存库/隐藏Electron/profile。保持真实回执来造在途窗，不mock业务数据；没有生产测试自动重发。

最终10场景：正常打开、project.open取消、装载取消、取消后的装载失败、外部深链解析取消、open回执交叉、成员回执交叉、注册表旧快照交叉、迟到失败、新弹窗不被旧回调关闭。必要判据全部进入总pass与非零退出；每个根均核real_calls=0。

- 首个修复版本8/8通过：`dist/desktop/r75-completion-1791682226629/result.json`。
- 冻结初版v14 UI 8/8：`dist/desktop/r75-completion-1791682781951/result.json`（该候选随后因注册表守卫更新重建，最终身份另列）。
- 旧v13负对照：`dist/desktop/r75-completion-1791682869060/result.json`，6个必要场景失败，总pass=false/exit1；正常打开及回执前代次守卫正例保持通过，证明不是“旧包一律失败”。
- 注册表守卫追加后的源码UI 9/9：`dist/desktop/r75-completion-1791683107853/result.json`。
- 最终v14冻结UI **10/10**：`dist/desktop/r75-completion-1791683815990/result.json`，所有子进程exit0、每根realCalls0。前一轮 `1791683681930` 外部深链夹具错查 rooms.conversation_id，失败原报告保留；夹具改查正式conversations表后才完整通过，未为此改产品。

### 正常启动器与必要回归

原 `verify-r75-launcher.cjs` 支持指定候选；清理仅限独立副本下可执行文件，端口被占即拒绝接入，优先关窗后清理自有残留。

- 初版v14真实启动器 `r75-launcher-check-1791682792067/result.json`：普通A房间开B、再开新C、重启进C、文件页、console0、realCalls0通过。最终重建副本会再验，不用初版身份代记。
- 初版v14日常门 `daily-verify-r63-r63-daily-20261011014304/result.json`：欢迎无seed、fakeAllowed=false、配置保存回读、仅记录/草稿、realCalls0通过。
- 最终v14日常门 **通过**：`dist/desktop/daily-verify-r63-r63-daily-20261011015929/result.json`，欢迎页零演示项目/零Guide、真实派发形态（fakeAllowed=false）、绑定回读、仅记录与草稿、优雅退出/残留检查均通过，realCalls0。
- 最终v14 **真实启动器通过**：`dist/desktop/r75-launcher-check-1791683692092/result.json`，build `bld_3a055900c7f273b6`；正常开B、再开新C、重启进C、文件页可达、console0、realCalls0。
- R75 G3最终代码复验：`dist/desktop/gate-r75-r75-gate-20261011015502/result.json`，跨项目线程/冷房间/冷启动正例通过、root3 realCalls0。先前 `20261011014253` 也通过，分列记录。
- R74 G1：`dist/desktop/gate-r74-r74-gate-20261011014713/result.json`，混合房间/线程/DM/跨项目、在途读取、显式恢复、两标签恢复、真实滚动240和草稿通过，root1 realCalls0。此G1不含拖动/放大几何专项，本次未改其实现，沿用R73既有证据，不代记新专项通过。

## 最终交付

候选：`dist/desktop/desktop-daily-win-v14`，与旧包并列；BUILD **`bld_3a055900c7f273b6`**，基线commit `822bd1120962747af76019d549b5b2089daa180e`，**dirty=true**，dirtyDiffHash `7af2c9c67886…`。构建时源码尚未提交/推送，不冒充基线commit的clean构建；后续Git提交保留该构建时身份，不改写已验证包的BUILD。应用清单593/593一致；源码补丁/变更文件快照/逐文件hash在包根 `SOURCE-PATCH.diff`、`SOURCE-SNAPSHOT/`、`SOURCE-MANIFEST.json`。BUILD记录构建时工作区，报告和验证脚本随后补全，应用运行时代码未再改变。

Git交接范围：本次源码修复、永久测试、验证脚本、复核与交付记录统一提交到 `codex/full-implementation`。`dist/` 下的本地候选、样本、profile和运行证据保持忽略，不随Git提交；提交与远端一致性以Git状态及推送回执核验。

用户只需在目标项目房间正常打开另一个已注册项目，再打开一份已有文件的自然确认。无需制造在途竞态、调用模型或重新跑旧长清单。沿用旧数据时，关闭旧程序后完整复制server-data至新包，原目录保留；不要运行期复制或混入单个SQLite。
