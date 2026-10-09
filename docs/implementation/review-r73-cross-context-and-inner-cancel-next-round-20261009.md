# R73 独立复核与 R74 两个交叉场景收口（2026-10-09）

## 已确认的进展与边界

- HEAD `5b9d698`；v11 BUILD `bld_87d8fd4ec1c6283c` / commit `ed39838e257c6007aa30ea067c0895facfa1bb93`。独立核对清单 **593/593** hash/字节一致；主/hifi typecheck各0错；r67Contracts/upstreamMultiRemote/officeAttachments三个文件 **22/22**。未独立重跑全量921。
- 独立证据根 `dist/desktop/review-r73-audit-20261009/`。冻结v11 renderer/资产、匹配Electron隐藏窗口/独立profile、正式命令层独立内存库、合成MD或自有线程/project夹具。零用户数据写入，所有报告realCalls=0；不是整个最终启动器认证。本复核另查GLM `r73-launcher-check-1791515361363/result.json` 的发布三项结果，未重跑该启动器。
- `ui-result.json`：纯文件来源切房间previewVisible=false；房间打开文件separator=1；原生指针拖动实际宽620→约580；放大宽约1356、left246、maximized类进入布局。用户三个问题的基本单场景确实有修复。
- `thread-cancel/ui-result.json`：上一轮延迟thread.get的取消反例在v11已通过，保持项目B。
- 重传代码只在 `scripts/verify-daily-r73.cjs.uploadWithRetry`，不是产品新增发送自动重试。但该门移除失败芯片再重传最多3次，不能以最终绿证明首次尝试成功或超时根因必为环境。需保留每次结果/回执身份，不把重试当修复；不要修改既有UNKNOWN人工同号确认合同。

## P1：取消凭据没有进入项目打开内部

两次独立运行 `open-cancel/ui-result.json`、`open-cancel-repeat/ui-result.json` 均失败：

1. 项目B已活跃；点A线程直链，thread.get正常返回。
2. 定位进入 `ensureProjectActive(A)` 的后续 `project.open`，只延迟这次自有请求3.2秒（真实响应内容不mock）。
3. 用户已离开到 `#/settings`，标题仍B。
4. project.open回执到达，URL仍settings，active标题变成A。第二轮命令日志明确出现取消后的 **navigation.set(activeProjectId=A)**。realCalls=0。

注意：原模板scope文字保留了thread.get描述；该两个目录的脚本实际hooks拦截的是**project.open**，不能把它们与已通过thread-cancel混同。delay发生在自己的转发层，未改用户服务或真实模型配置。

根因已由源码确认：`openProjectByPath(path, opts?:{fromIntent?:boolean})` 没有接收NavIntent。fromIntent只是“不取消自己”的布尔开关；await project.open后只检查loadGen，随后直接写activeProjectId/可见集合/localStorage并refresh/persistNav。navigate(settings)和定位组件卸载虽已取消意图，却未开启新open请求，loadGen没变，所以旧调用仍提交副作用。ensureProjectActive在await前后检查已太晚。

R74要求：将具体intent/token传到openProjectByPath内部，并在异步回执后的状态提交、本地导航记忆、持久化nav之前核有效性；成员/房间/DM装载迟到结果也只能作用于正确的项目/代次。正常用户直接打开与系统启动恢复保留其合理合同，不用无关新意图互相取消。取消仅安静收尾，不navigate、不toast、不继续重试抢焦点。

验证：thread.get等待取消、project.open等待取消、名单/房间装载等待取消分列；B→A在途→B设置/成员/新链接，最终URL/active/导航偏好/草稿都保持最新用户意图。核取消后的navigation.set为0，成功正例仍可落位。不能只证明第一段已取消就宣布全链。

## P2：混合来源标签时文件页切房间仍占用

两次干净运行 `mixed-tabs/ui-result.json`、`mixed-tabs-repeat/ui-result.json`：

- 先在房间预览 `room-file.md`，保留该标签；再进入文件页，打开 `layout-file.md`。
- 文件页因audience过滤只显示工作区标签，但全局preview会话中保留房间标签。
- 点击回房间后previewVisible=true、width620；第二次报告记录房间中可见两个标签，文件页预览仍占着房间。用户原要求“文件页→房间自动收起”在正常多标签往返后不成立。

根因 `Room.tsx` 用 `visible.every(t.openedFrom.target.kind==='files')` 才收起；存在任一以前的room/thread来源标签就跳过。`explicitShow`已由文件页打开重置false，不能补成永久全局true来绕过。

要求：依据**本次页面导航意图/当前文件页活动预览**确定离开文件页后是否收起，而非要求历史全部标签来源一致。房间内本次主动打开/显式重开继续尊重；旧标签/阅读位置/草稿全部保留，不用清空旧标签使条件成立。不全局每次navigate关闭，保护房间→线程的正常文件行为、引用定位到对话的明确动作和迟到读取不回弹。

测试矩阵至少包含：纯工作区标签；room+files；thread+files；显式恢复→再回文件页打开→回房间；跨项目/私信不可见标签；在途读取。真正点击侧栏，核区域rect/可见性、恢复后的文件与阅读位置、草稿归属，不只断言hidden或计数。

## 验收与交付

1. 两个反例先复现再修，做直接对应的浏览器/集成判据。必要结果逐项纳入总门；延迟位置写明，失败与最终重传分别记实。
2. 单场景已确认的拖拽/放大、PPT真ready、原件保存、大文档容量、Git往返、导航合法正例保持；只做与新改动/失败关联的必要回归，不重新换渲染库或扩容量。
3. `uploadWithRetry` 首次15s失败不能仅凭后续通过定为环境CPU抖动。记录是服务明确拒绝还是传输超时/未知、后台是否已保存/回执何时到达；已保存件重传可按既有幂等/内容去重事实收口，未知不能无依据换身份或自动发送。此项先诊断，未证实的产品问题不代记。
4. 集中交独立v12（若未占用），最终副本真实启动器/发布协议复核两交叉场景及基本三项；源码/最终副本证据分列。
5. 旧包和用户全部数据/配置/凭据/CA/草稿/未知账本保持；迁移001–048冻结，零新增真实模型调用，不自动重试UNKNOWN/解除保护；既有延期不扩。

用户无需再制造竞态、清空标签才能测试或重跑历史清单。待修复候选后只做一次约5分钟：保留房间文件→去文件页打开另一文件→回房间应收起→显式恢复→拖动/放大/Esc还原，确认阅读位置与草稿保留。目前资源和设计判断都足够，不再追加索取。
