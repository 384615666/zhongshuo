# R74 独立复核与 R75 项目切换落位/取消收口（2026-10-09）

## 已确认与复核边界

上一轮两个原始反例确已修复，不应再泛称全部没做完：v12混合来源标签切房间后收起、project.open回执等待期取消零焦点/偏好提交，均通过独立复测。用户可对既有项目的预览交互做一次短确认。

- HEAD `e9af5ef`，v12 BUILD `bld_49bb7307dfac1435` / commit `1dbf27b9ce5b9b1a15bdd2382ae00b1c7160192a`；独立清单 **593/593** hash与字节一致。
- 主/hifi typecheck各0错；hifiNavCancelRound74、r67Contracts、officeAttachments三个文件 **20/20**。未独立重跑全量922，不冒充GLM全量验证。
- 证据根 `dist/desktop/review-r74-audit-20261009/`：`identity.json`、`open-cancel/ui-result.json`、`mixed-tabs/ui-result.json`、后述两场景报告。冻结v12 renderer/随包资产、匹配Electron隐藏窗口/profile、正式命令层独立内存库，自己的项目/成员/房间/MD夹具。各运行realCalls=0，没有用户数据写入或真实模型调用；不是全发布启动器认证。
- 已查GLM发布结果 `r74-launcher-check-1791527683996/result.json`，混合恢复2标签、拖动、放大/Esc与prefs=B；其发布取消验证是双hash（即刻取消），与受控延迟的源码验证明确分列，不混同装载后取消。

## P1：从房间打开另一个项目，旧房间路由抢回焦点

**不注入延迟、不篡改数据**的正常UI路径两次均失败：

1. 当前A房间（自有proj-r61），URL `#/project/A/room/roomA`。
2. 点侧栏「打开/切换项目」，使用自己的pickFolder桥返回B目录（等价目录选择器选择结果），弹窗显示B路径，点「打开这个目录」。
3. 弹窗正常关闭，但URL、标题和当前项目最后仍是A；本地 `zs.lastProjectPath` 已是B。
4. 命令日志有真实 `project.open(B)`，不是按钮空点；B项目确实在库中。作为对照，从全局设置页执行相同目录选择和按钮路径能正常进入B。

证据 `project-open-from-room/ui-result.json`、`project-open-from-room-repeat/ui-result.json`。这两个脚本继承的scope文字提到member.list受控延迟，但该场景**没有启用延迟hook**；以脚本与步骤为准，不将测试模板说明误当执行事实。原 `member-cancel-real-open` 等待B落位超时，后来拆成完整UI报告定位，超时本身不是单独产品缺陷。

根因：`openProjectByPath(B)` 先改activeProjectId=B，URL还在旧A房间；App的ProjectAlign看到pidA!=activeB，启动对齐A。B的加载链/打开弹窗最后依据此时getState().activeProjectId选房间，导航又落回A。旧路由对齐与用户新打开意图没有共同的胜负归属。

要求：把“用户打开B”与“旧A路由对齐”纳入同一导航意图/操作代次。新打开的焦点、装载、路由落点按请求目标B绑定，旧A路由不能在打开窗口中抢回；不要简单全局禁用ProjectAlign或将所有导航锁到加载完成（合法深链仍需要对齐且用户可离开）。必要时分阶段准备与原子落位，不由异步结束时的全局active推断这次操作目标。

验证：从A房间、线程、文件页、设置页分别打开已注册B和新目录C；所有原UI按钮/目录选择链正确落目标房间；A草稿保留、项目集合不丢。快速打开B再C/打开期间点击别的房间，以最后用户意图为准。未取消合法深链/冷启动对齐继续成功。

## P2：装载期取消只恢复焦点，旧本地记忆未回滚

`member-cancel-clean/ui-result.json` 独立UI：

- 先从设置页经「打开/切换项目→选择B→打开这个目录」完成正常打开。基线title=B、URL=B房间、`zs.lastProjectPath=B`。
- 点击A线程；只延迟自己的A项目 `member.list` 回执3.2秒（正式内容不mock）。project.open已返回，active中途A、装载刷新在途。
- 用户离开到settings，释放回执后title恢复B、navigation.set为0，但**zs.lastProjectPath仍是A**。

源码对应：R74取消分支仅 `setState({activeProjectId:prevFocus})`，而前面已写A本地路径/可见与展开集合，refreshRooms/refreshMembers又是全量替换投影。R74集成测试S3只检查active与nav计数，未检查本地记忆或已恢复B的项目数据。

第一版 `member-cancel/ui-result.json` 基线B仅轻切焦点、lastPath本来就是A，无法区分此反例；那份pass仅证焦点回滚。正式证据用 `member-cancel-clean` 的真实UI打开B建立不同基线。不要引用旧pass覆盖新签名。

要求：装载与导航意图的事务边界覆盖本地记忆及项目投影，或者延迟提交直到意图仍有效的完整落位；取消后的清理只撤销本操作仍拥有的值，不能覆盖用户后来新的打开/焦点/偏好。检查B的房间、成员、DM、runtime投影在还原后正确，异步刷新不能把A整表残留成B无数据。上述投影风险为源码疑点，尚未独立证明UI最终串数据，需自行先证后修，不将推测代记。

测试S3补 `zs.lastProjectPath` 前后值、必要导航本地/服务事实、各项目投影归属；覆盖刷新波中取消、刷新失败后取消、期间用户显式切C。不可只改为在最后回写prevFocus再宣布完整回滚。

## 验收与下一轮范围

1. 原正常UI路径先失败→修复→无重试通过；同样检查最终副本真实启动器上的打开目录动作（发布pickFolder正常，测试可选自己的临时目录）。取消相位分列，最终副本即刻双hash不能替代源码/集成的装载后取消。
2. 当前混合预览、拖拽/放大/Esc、阅读位置、容量、原件保存、Git往返及UNKNOWN合同保留。只做新增改动、失败与仍未覆盖分支的必要回归，不换渲染库、不扩新业务概念或容量。
3. 上传15秒现象仍未复现，维持未归类，保留诊断采样，不借此新增产品自动重发。922全量和既有延期按实记。
4. 实际修复需要独立v13（若未占用），最终副本启动器/发布协议证据分列；旧包与用户全部数据/配置/CA/凭据/草稿/未知账本不动，迁移001–048冻结，零新增真实模型调用，不自动重试UNKNOWN/解除保护。

## 用户确认

用户目前可在已有项目上花约5分钟确认：保留房间文件→文件页打开另一个→回房间自动收起→重开保留标签/位置/草稿→拖动→放大/Esc。新发现项目打开与取消竞态由工程自验，不要求用户重复已知失败或造时序；样本与原型足够，无需追加资源/预算判断。修复候选后只增量确认从房间打开/切换项目的正常路线。
