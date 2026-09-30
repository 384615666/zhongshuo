# 第十三轮报告：受管桥完整化 · 恢复证据正式链 · push 目的地绑定 · DEV-15 早期打包（2026-09-29）

> **〔2026-09-30 第十四轮撤回注记〕**本报告「一、受管桥」环境段的结论「koffi CreateProcessW 非空 lpEnvironment 恒 87=FFI 层 W 变体缺陷」**已撤回**：根因是本方调用缺 `CREATE_UNICODE_ENVIRONMENT` 标志（UTF-16 块被系统按 ANSI 解释）——调用侧实现错误，非 koffi 缺陷。第十四轮补标志后按规范构造环境块（大小写不敏感去重/排序/双 NUL 终止），真实子进程逐项回读（ASCII/中文/空值/空格路径/覆盖/删除/32K 大块）全过（见 round-20260930-round14 与 managedBridge 测试）。「需要覆盖环境请关闭受管开关」的绕行建议同轮删除。另：releaseProtection 按 pid 查受管句柄的口径当轮即与本报告「jobId 稳定身份」叙述不一致——第十四轮二已按 managed_job_id 正式列收口。

> 分组提交：`736dddc`（工作区核对+flake 同步点修复）→ `1aec264`（桥 stdio/argv/证据生命周期+正式链验收）→ `3635a38`（push 目的地绑定）→ `58374bf`（DEV-15 早期打包）→ 本文档组。
> 数字：**563/563**（单次全量含 githubSandbox 5/5；TLS 握手偶发失败为环境敏感——单跑即过）；managedBridge 6/6+managedLifecycle 9/9+gitRt24 10/10+pack 4/4；lint 0、tsc 0；**零模型调用**。

## 〇、工作区核对与 flake 归因（736dddc）

- 未提交改动核对（均本人前轮残留非他人改动）：pnpm-workspace 的 koffi 构建占位→显式 `false`（预编译运行时加载，无需构建脚本）；gitRt24 hooks 用例类型拓宽=727c835 后的 tsc 补丁。
- 两项 supervisor 满载失败归因（非生产时序问题=测试等待条件不可靠）：
  - 三代现场：固定 sleep(900ms) 后拍快照——满载下孙尚未派生，快照只锚定父→「历史身份发现孙」断言必败。**修复=同步点**：孙自写 grandson.pid（waitForFile 就绪）+waitAlive 存活轮询+快照 ack（<3 代重拍，对齐生产周期快照语义）+退出轮询。
  - 盲区如实：sleep(100ms)+单次 liveness——父窗口 200ms，满载下检查本身超窗→前置失败。**修复**=waitAlive 轮询+父窗口 1500ms（盲区语义与绝对速度无关）。
  - 验证：隔离 3 连跑 11/11+**原失败组合（全量并行）563/563**。

## 一、受管桥 stdio/argv/句柄生命周期（1aec264）

- **stdin EOF**：`Writable.final→endStdin()`=关父侧写端；fixture=**持续读 stdin 至 EOF 才输出结构化 JSON 并退出**（非行回显）——1MB 大输入经 koffi 异步 `WriteFile.async`（后台线程）分片串行写，事件循环写阶段持续运行（心跳断言 vitest 7 拍/独立 54 拍；同步阻塞=0）。koffi async 正确形态=`fn.async(args, callback)`（func 第 4 参 'async' 是 ABI 槽位非异步声明——首轮误用之坑）。
- **句柄继承修复**：CreatePipe 双端可继承+bInheritHandles=TRUE 会把**全部**可继承句柄带入子进程——子进程持有自己的 stdin 写端（EOF 永不到来）。`SetHandleInformation` 清父侧三端继承标志后 EOF 语义正确（EOF 探针由「挂起无输出」转「读到 N 字节退出」）。
- **输出**：字节流 push Buffer（跨 chunk 解码归消费端——中文跨字节边界不丢，1.5MB 大输出无丢失）；exit 与 close 分开（close=两管道排空判定 stdoutDrained/stderrDrained——非固定 200ms）；终拍补 push(null)（末块与退出同拍到达时的流不发 end 缺陷）；背压=高水位 1MB 暂停。
- **argv**：MSVCRT argv 约定（非 shell 引号）——空参 `""`/嵌入引号 `\\"`/引号前反斜杠/带空格+末尾反斜杠逐位回读核对。
- **环境（诚实边界）**：实证 koffi CreateProcessW 对任何非空 lpEnvironment 恒 87（同指针 A 变体有效；系统原生块与 VirtualAlloc 页对齐块均 87；同值作 cwd=267 正常读取）=FFI 层 W 变体缺陷。受支持路径=**继承父环境**（=entry.ts 原传语义等价）；真实覆盖显式报错附证据——不静默错环境。
- 资源回收：创建失败回收全部管道（含子端）；纳管失败终止挂起进程+句柄；dispose 移除注册。

## 二、恢复证据正式链（1aec264·二组）

- 生命周期分立：rootExited/stdioClosed/evidenceReleased/consumed/finalized；根退出后保留可查询 job（**close≠证据消失**）；jobId 稳定身份索引（pidIndex 仅注册期弱索引）；证据消费后保留至 dispose。
- **正式生产链验收**（非直调 releaseEvidence）：受管 spawn→登记 managed-job（note=jobId）→UNKNOWN+租约→probe→`recovery.releaseProtection` 凭 releaseEvidence 解除（reason=managed-job-evidence）→锁域可授予排队任务→重复解除幂等。根先退后代仍活=不可解除（closeOutputPipes 后证据仍在）；terminateAll+句柄释放+延迟→可解除；dispose 后=重启语义（句柄消失不追认）。

## 三、push 目的地绑定（3635a38）

- `pushUrl()`：`get-url --push --all`（**push 传输目的地**，pushurl 优先；fetch/pull 侧维持 get-url——两类目的地分开）；多 push URL 明确拒绝。
- 改写规则：实证 get-url 不在 pushInsteadOf 生效面（返回改写前字面量）→确认值与实际目的地不一致→**明确拒绝**受 insteadOf/pushInsteadOf 影响的目的地（不复刻 git 改写、不静默发送）。
- 核对同源修复：远端头/推送后核对改走 `remoteHeadAtUrl`（**显式 URL** ls-remote）——经远端名的 ls-remote 读 fetch URL（url≠pushurl 时核对对象就错了）；确认/旧头/推送/结果核对同一目的地。
- 两 bare remote 反例：fetch=A/push=B 首推走 B 且 A 零接收；预览后替换 pushurl 拒且 C 零接收；多 push URL 拒；insteadOf 拒+清规则恢复。组合保留：固定源 OID refspec+快进前置+精确旧头 lease（文档已注明 lease 参数名≠强推语义，产品拒绝非快进）。

## 四、DEV-15 早期打包（58374bf）

- 产物：dist/pack/daemon.cjs（esbuild CJS bundle；原生依赖 external，.node 经安装目录 node_modules 解析）；入口哨兵 ZS_PACKED_ENTRY=1。
- verify-pack 4/4：①中文+空格安装目录+clean env（PATH 仅 System32）启动→listening=SQLite 可加载；②koffi 可加载（安装目录 nm 链含 @koromix 平台包——cnoke 的 `__dirname/../../../@koromix` 解析已核对）；③精确移除 koffi（保留 sqlite）→拒绝启动不降级；④报告 verify-report.json 落盘。坑：pnpm symlink cpSync EPERM→realpath+dereference；named pipe 裸名→EACCES（须 `\\.\pipe\` 前缀）。
- **未做（如实）**：Electron 应用壳打包（electron-builder）、受管 fixture 在**打包产物内**跑完整链（当前产物验证到依赖加载与拒绝降级层）、日志/资源目录策略——归 DEV-15 主体。

## 五、四层证据分级

| 层 | 已验证 | 证据 |
|---|---|---|
| 底层模块（FFI/Job Object） | jobManager/桥：EOF/字节流/argv/背压/句柄/生命周期 | managedBridge 6/6+managedLifecycle 9/9 |
| 本地正式链 | spawn→登记→UNKNOWN→probe→release→排队续跑；进程树/迟到链 | managedBridge 二组+全量 563/563 |
| 打包产物 | daemon.cjs 在中文+空格独立目录启动；sqlite/koffi 可加载；拒绝降级 | verify-pack 4/4+verify-report.json |
| 真实 CLI | **未验证**（受管路径 claude/codex 实战、真实 lateEvents）——归补证窗口 | — |

## 六、剩余项

- merge 多父 diff 视图、设置页剩余真实项（本轮被桥/打包收口占满，如实列为下一批首项）。
- 受管 Claude Code + deepseek-flash 最小补证方案（本地收口后提出，逐次说明目的/停止条件——**本轮未执行**）；DEV-15 主体（Electron 壳/安装器）；koffi CreateProcessW env 缺陷上游跟踪（受管环境覆盖因此在 FFI 修复前不可用——继承父环境已满足 adapter 现有需求）。
