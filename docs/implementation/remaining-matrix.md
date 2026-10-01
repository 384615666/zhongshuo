# 剩余工程映射（2026-09-30 第十八轮修订——服从总任务书/基线/交付矩阵；逐项不泛化）

> 依据 docs/dev-briefs/full-implementation-brief-glm5.3.md §6/§7、development-baseline-v1.23、
> development-delivery-matrix-v1.23、implementation-status.md。
> 「便携包存在」≠全功能施工接近完成。历史错误已纠正：DEV-16 不是恢复 UI 的替代编号；
> DEV-22 第十七轮总账为 NOT_STARTED（本轮已开工，见下）；私信 1 对 1 已定稿（§0.21/§4.6，
> 无小群/@ 路由待确认事项）；MCP（FULL-11）依赖未满足不得因设计就绪而提前排产。

## M3 工作包（§6.4：完成 DEV-13/14/18/19、DEV-21-M3、DEV-22—25，再 DEV-15/16）

| 包 | 不得漏掉的内容（总任务书原文口径） | 现状 |
|---|---|---|
| DEV-13 | 崩溃恢复、进程身份、失效租约、不确定提交窗口、历史与文件一致性 | 大半已做（恢复/取证/对账/迟到成果/受管证据）；文件一致性收尾随各功能面 |
| DEV-14 | 三模式完整 UI、任务/成果/确认/诊断、项目与应用设置、可选验收与真实状态；START-07/09 教程与帮助 | 大半已做（DIRECT/研讨 UI、设置七类、帮助、Git/仓库视图）；AUTO 未开放（价值闸门暂停）；恢复中心 UI 批量操作、权限档呈现汇总未做 |
| DEV-18 | 阅读水位、关注/通知、未读、搜索/收藏、深链、待我处理与多项目范围 | **关注/静音（阅读订阅与执行名单分开）、搜索（消息/线程/任务+过滤一致性+本机时区）、收藏（四类+失效呈现+深链跳转）已落地并验**（dev18FollowSearch 7/7 含北京凌晨边界；FS/REM 页面会话；第二十六轮搜索过滤统一）。**剩余**：Activity 流、消息操作全集、惰性表情（按交付矩阵归属） |
| DEV-19 | 看板、成员/房间协作视图、来源关联文件集合、基础附件与搜索 | **首包+动作/Files 已落（第二十六/二十七轮）**：board.view 只读聚合（第二十七轮映射修正——任务终态分列 DONE/FAILED=已完成、CANCELLED=已停止；stop_generation 是代次不作停止证明；exitUnconfirmed=run INTERRUPTED+turn UNKNOWN 事实）+thread.collaborators 四列+renderer；**看板动作快捷入口**（停止 task.stop/通过验收 task.review——闭包钉死 task/run/交付版本，未有命令的动作不出现）；**Files 集合 files.view 四类分列**（项目文件/托管附件 audience 过滤+私信标注/Agent 草稿/交付成果——逐项来源+hash+定位）；连带修复历史停止代次三层误拦（领取/执行/迟到输出——迁移 032 快照；boardFormalStates 5/5 正式链六形态）。**剩余**：跨项目汇总拖拽视图（不做状态直改） |
| DEV-21-M3 | 私信/提醒/跟进模板、正式输出 schema、真实注入/续接/恢复验证 | **模板面已实现并验证**：私信模板（DM 常驻提示词 v0.1.0）+提醒/跟进模板（DEV-21-M3 wake 模板：occurrenceId/scheduledAt/timezone/missedCount/sourceRef/预算/授权——消息与输入同源 renderReminderWakeMessage/WakeInput，第二十四轮落地随 DEV-23 正式执行）；输出 schema=TaskComplete（复用）。**真实注入已补证**：r25-rem 批次（deepseek-flash 恰 2 次 startTurn——自动触发+确认触发各一，模板输入/归属/台账 settled 双向一致，real-batches/r25-rem-result.md）；DM 真实续接 r20-dm 17/17 已补证。剩余：恢复验证散场景随 DEV-13 收口 |
| **DEV-22** | 普通 DM 的持久化与实际执行、同对话续接/跨对话隔离、串行/暂停、权限/验收/附件范围 | **进行中（第十八轮五第一包+第十九轮二包）**：会话/消息持久化与成员归属、conversation.* 命令面（create 每请求独立会话+commandId 幂等）、1-1 输入（无 @/任务号）、dm_turn 串行队列+**输入水位**（input_through_seq——排队消息不提前进入前一轮输入）+停止转暂停+恢复泵、**会话续接如实区分**（provider_session_id 持久+resume 传递+原生续接/受限重放事件分列）、归档遵循停止流程（停止未确认如实 stopPending、派发门拦领取窗口、restore 不自动续跑）、DM 可选验收（绑定 deliveryId/revision+创建时策略快照）、rename、会话深链（#dm=）、正式 UI（侧栏/双会话/排队/停止继续/归档恢复/版本验收/成员选择器）已落地；附件接口预留但明确拒绝（随 DEV-24）；人对人/Agent 对 Agent 投递未做（FULL-02，v0.1=本机用户×项目 Agent）；**真实 runtime 原生续接已补证**（第二十二轮 r20-dm 17/17：A2/A3 续接请求=上报、provider_session_id 持久一致——不再列为待批次项） |
| DEV-23 | 一次/循环提醒、时区、唯一 occurrence、错过合并、停止/归档暂停、真实通知与预算 | **预算已接实际调用边界（第二十五轮 reminder_calls 台账——迁移 028/030：派发/确认持久预占、startTurn 边界统一检查、UNKNOWN 保守计数、max_triggers 与模型调用预算分列；第二十六轮准确归属——完整身份键+归属解析+原子收敛；reminderOwnership 4/4）。桌面系统通知已接入（第二十六轮五相留痕+locate；第二十七轮验收启动器闭环——纯 ASCII 启动器/隔离环境内置/干净环境实测：项目恢复/两条通知 1s-14s 时延/去重/优雅停机全过+OS 层吐司显示视觉取证；**Windows 送达/点击人工复核已通过（2026-10-01 用户回填：两条通知出现+点击定位正确+无重复+通知中心留痕；工程只读核对一致；用户顺带验证确认执行链×2——real_calls=0；归档 evidence/notify-manual-acceptance-20261001.md，范围仅该 build 与该机不推广全部 Windows）**真实 deepseek 批次（r25-rem 2 次 startTurn）已归档；新批次仅在明确新认证目标时建立 |
| DEV-24 | 文本/代码/图片/PDF/Word/Excel/PPT 七类附件；共享预览、基础评论、Markdown/HTML/DOCX 导出 | **七类已全落（第二十六至二十九轮）**：四通道正式链（attachmentChannels 11）+完整性（实根/**realpath 实身份**（junction/符号链接检出——storeLinks 3）/受控句柄读取/sha256/字节截断/fatal 解码）+草稿完整目标键+预览代次保护+评论版本绑定；代码类+基础评论（迁移 033）；图片首包（magic+头部尺寸限幅+**WebP VP8/VP8L 头解析**+<img> 预览+decode() 结果如实——OCR 未实现/模型图片输入未认证分列+**IMAGE_INPUT_UNVERIFIED 能力门**：未确认拒发、确认后注入「图片未发送+用户确认」、record_only 不设门）；**PDF（第二十九轮重构）**：解析迁入**子进程执行边界**（parseWorker/parsePool——墙钟截止+SIGTERM→KILL 收拢确认、并发 1+队列 4、内存 320MB、输出预算；受控故障证明 parseBoundary 6/6）+**真实中文样本**（Identity-H+ToUnicode 码位双射——旧 latin1 冒充废弃）+CMap 解码（UniGB-UCS2-H 随包 cmaps 依赖可证：隔离副本缺资源=提取降级）+扫描件（图像页像素可见+文本如实空）+加密（Standard R2/RC4 真实拒绝）+**视觉页面渲染**（zsres:// 特权协议+渲染器 canvas——服务端零像素解码；翻页构造性指纹验证）+提取缓存 schema v2（结构/版本/预算严格校验——预览侧重提回写/组装 fail-closed）+**上传幂等三层**（commandId 回执预查→同会话同 hash 去重→跨会话缓存复用——解析池 completed 计数证明不重复解析）+解析期间归档事务内重检（不留记录）；**DOCX/XLSX/CSV/PPTX（第二十九轮四）**：mammoth（段落/表格有序+安全排版 HTML 白名单净化+宏拒绝）/SheetJS（值缓存——公式不执行、无缓存值自查占位、日期/合并/多 sheet）/自研 CSV（UTF-8/BOM/UTF-16 探测——其余明确 unsupported；RFC4180+分隔符嗅探）/fflate+XML（PPTX 按页文字+备注，页图 unsupported 如实）；zip 护栏（条目数/声明尺寸/穿越拒绝）；**表格范围选择注入**（attachmentRanges→迁移 036 range_spec→组装按窗口——默认=首表 50×16 有界窗口，坏格式/越界/超窗口提交时拒绝）；预览面板视图全局化（原埋 DM 区内池/线程不可见的存量缺陷修正）。**剩余**：Markdown 安全预览（脚本不执行——当前纯文本直读）、共享预览完善（搜索/引用锚）、导出、图片/PDF/Office 评论锚点（按分批归属）、OCR（未实现——引入新渠道属新增服务，先方案后询问） |
| DEV-25 | 本机/LAN 浏览器、HTTPS/WSS、配对/吊销、设备与会话、WS 票据、重连续传与范围过滤 | 未开始（RT-21 发布必测） |
| DEV-15 | Windows 安装/卸载/托盘/启动、资源打包、native 依赖、升级与数据迁移；随包帮助 | 便携交付链已验（daemon/renderer/独立包 bld_c2f364d06ff0014e 独立机登记通过）；安装器/卸载器/托盘/升级迁移未做 |
| **DEV-16** | **所有首版包的集成验收、兼容矩阵、性能记录和已知限制；执行并产出 G5 发布结论**（不是任何单项功能的替代编号；依赖含 DEV-17—19/21—25 与适用 G0—G4） | 未开始（G5 是本包产出，不是前置） |

## FULL-01—11（§7 完整目标——逐项保留）

FULL-01 导航/频道/资料/Activity/Saved/Search；FULL-02 全部任务入口/认领审阅/完整看板/**DM 与附件**；FULL-03 多格式预览/五类锚点评论/导出；FULL-04 完整 runtime 目录/Agent 详情/生命周期/诊断；FULL-05 账号/邀请/多人/多机/浏览器/PWA/移动；FULL-06 外部 Agent/设备授权/桥接；FULL-07 Connected Apps/OAuth/OIDC/市场/manifest；FULL-08 Agent Events/App Notifications/Service CLI；FULL-09 联邦频道与跨空间同步；FULL-10 套餐权益/计费（商业参数 BLOCKED，无依赖部分可先行）；FULL-11 MCP 本体（12 工具/连接授权/审计）——**依 M3 共用命令面 + DEV-25 交付且 RT-21 通过**（§31 设计三轮评审就绪≠前置满足，不得提前排产）。逐项状态见 implementation-status.md 交付矩阵，均为 NOT_STARTED。

## 明确暂停/延期（授权范围外，不得擅自恢复）

- DEV-11 价值闸门：用户暂停——不开放、不重列、不当作待办。
- 并行写入增强与按任务 worktree（§14.7 延期）：当前仅 single_writer；parallel_writers 在租约入口被拒。
- 写档入口：未认证维持关闭。
- 真实迟到回放（lateEvents）真实 runtime 支持待补证；fake 链已验。

## 下一包建议（依赖已满足排序，第二十八轮修订）

1. **DEV-24 完善面**：Markdown 安全预览（脚本不执行）、共享预览完善（搜索/引用锚）、导出、图片/PDF/Office 评论锚点（按分批归属）；
2. **独立交付包（make-independent-package）随下轮重建**：本轮冻结三连（112/112×3）已在便携产物内经打包 daemon 的 parse-worker.cjs+cmaps 走通 Office/PDF 解析页面链（资源路径已证）；独立包重建随下次交付；
3. DEV-18 剩余（Activity 流/消息操作全集/惰性表情）与 DEV-19 跨项目汇总视图（不做状态直改）；
4. DEV-15：安装器与升级迁移设计（便携链已验，可做增量）。
   （DEV-16 排 M3 末尾集成验收；MCP/FULL-11 等 M3 命令面与 DEV-25/RT-21 满足后再排。看板动作/Files/停止代次修复/图片/PDF 首包已于第二十七—二十八轮交付；通知人工验收已通过归档。））
