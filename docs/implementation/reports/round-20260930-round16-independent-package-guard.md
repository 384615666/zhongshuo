# 第十六轮报告：独立交付包重构 · 真实派发硬隔离 · 成员启停设置（2026-09-30）

> 提交：0b99979（工程组）+本文档组。数字：本地套件 **565/565**（62 文件，排除 githubSandbox——远端链未动）；dispatchGuard 2/2、memberEnabled 1/1；最终交付包（buildId `bld_c2f364d06ff0014e`，commit 0b99979 **clean**）开发机自测：daemon 级 **11/11**、renderer 级 **9/9**、故障路径 2/2（清单失败报告仍生成 exit 1 / daemon 失败 90s 内不挂住 exit 1）；lint/tsc 0；**零真实调用**。

## 四（先做）：真实派发硬隔离 ZS_REAL_DISPATCH_GUARD（R15 事故产品级收口）
- MemberRuntimeRegistry：解析出真实 runtime（claude/codex——含全局默认与成员持久绑定）在 adapter 构建（=spawn/请求）前拒绝；**配置读写不受影响**（可保存/回读真实绑定）；生产不设变量=正常可用（生产分离测试：工厂照常构建）。
- adapter 解析失败改判「确认未启动」：turn FAILED+turn.startupFailed 审计（原 openSession 阶段抛错会按不确定语义留 UNKNOWN——解析时 runtime 从未被调用）。
- 用户可见性：task.get 增 lastStartupFailureMessage（最新启动失败原因）→ 线程状态行如实显示「[验收防护] …派发被拒绝」。
- 反例测试（dispatchGuard 2/2）：持久 claude 绑定→新实例读同一 DB→提交=FAILED+registry 零登记+真实工厂构建计数不变+受管计数不变；无绑定 fake 照常 DONE。

## 一/三：verify-local 重写（结果保存与异常处理）
- 结果固定 `独立交付/验证结果/<run-编号>/summary.json`——与临时 fixture/appData 分开；临时清理不影响证据。
- 结构化总结：整体状态/预期 11/完成/失败项/未执行项/异常原因/环境（platform/arch/osRelease/node）/产物身份（buildId/commit）/诊断位置。**overall≠every(ok)**：中途异常、未执行、结果为空均不通过。
- 进程出生即挂 exit 监听（error/exit/signal/timeout 四分类；已退出不重挂不永等）；失败只收拢自启 pid（无法确认=保留现场+记录）。
- 残留检测统一协议：QUERY-OK 成功标记（失败/超时/空输出=无法确认≠零）；按实例路径匹配任意名称载体；排除查询自身；**decoy 控制组先证检测有效**再验归零。
- 自测 3 路径实测：成功后结果存在可读回（buildId 一致）；manifest 故障=报告仍生成+exit 1；daemon 故障=90s 内失败退出不挂住。.cmd 保留真实退出码（exit /b %ERRORLEVEL%）。

## 二：独立包三入口与如实拆分
- **自动本地验证.cmd**（daemon 级 11/11）；**自动桌面验证.cmd**（renderer 级 CDP 9/9——含「界面绑定真实 runtime→发送→防护拒绝可见」端到端复核+重开绑定保持+停止闭环）；**本地体验启动.cmd**（模拟验证模式：fake+防护+独立 appData，窗口标题明示——不再让用户裸双击 electron.exe）。
- 一页说明按 自动（daemon/renderer）/本地体验/人工清单 三层拆分——IPC 通过不写成页面通过。

## 五：可追溯交付
- pack-desktop：buildId=sha256(commit+dirty 差异哈希+全部产物文件内容)；dirty 时记录差异哈希（不拿旧 HEAD 冒充）。MANIFEST-SHA256 覆盖**全部文件**（renderer JS/HTML/CSS、原生二进制、daemon bundle、随包 node.exe）；交付清单.json 覆盖验证脚本+启动器；两清单在验证前逐文件核对（篡改/缺失=拒绝）。
- **最终交付包**：`dist/desktop/独立交付/`，buildId `bld_c2f364d06ff0014e`（源码 commit `0b99979` 工作区干净）；入口三个 .cmd；预计 5–8 分钟（两个自动入口）；结果输出 `独立交付/验证结果/<编号>/summary.json`。开发机已按最终包自测全过。**旧包作废——用户应复制本版**。

## 六：设置下一组（含 continuation 矛盾修正）
- 矛盾修正：**协作限制与文件修改策略均无后端命令**（并发=单写者硬编码、§14.7 并行延期；文件写策略=B6 只读档硬编码+读授权合同 fileDiscovery）——原「后端就绪」表述有误；两者需设计先行，本轮不硬造未经设计的选项。
- 本轮真实闭环=**成员启停（协作参与）**：member.setEnabled（停用=不参与之后派发；协调者拒绝——校验在事务外保留错误码；在途不受影响）；member.list 回读；UI 停用/启用按钮+「已停用」状态显示+失败提示；DB 持久化重开生效（memberEnabled 1/1：协调者拒绝/停用后路由拒绝不派发/启用恢复 DONE/持久化）。
- 已交付设置累计：成员 runtime 绑定、任务验收开关、成员启停、仓库状态显隐——逐项列出，不以显隐开关代表设置页完成。

## 七：边界与下一步
- R15 正常/停止链不重复调用；后续真实批次统一 **startTurn 级计数**（提交数仅辅助）——已入 continuation；独立环境回传=用户事项不阻塞工程。价值评价维持暂缓；旧批次 3 次不动用；DEV-11 不开放。
