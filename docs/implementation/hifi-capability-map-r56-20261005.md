# 新界面能力对应清单（r56 长批次，2026-10-05）

> 服务实际施工的简明盘点（review-r55-long-batch §6）：正式命令 ↔ 新界面入口 ↔ 状态。
> 状态取值：**真实**（正式命令已接、页面级验证过）/ **仅原界面**（能力存在、入口在旧界面，新界面给定向可达）/ **未开放**（无正式合同或冻结，不放假按钮）。
> 验证事实：探针 `verify-hifi-h4-r56.cjs`（22 段）/集成 `memberQueueContractR56.test.ts`/包验证器 `verify-hifi-package-r56.cjs`（三次运行）。

## 房间 / 线程

| 能力 | 正式命令 | 新界面入口 | 状态 |
|---|---|---|---|
| 房间主池/线程卡 | room.pool | 房间页 | 真实 |
| 发起任务/仅记录 | message.submit（room_root） | Composer | 真实（M0 提示=T4 修复） |
| @ 提及（触发位置消费） | mentions | Composer | 真实（T2 修复） |
| 回复跟进（不另建任务） | message.submit（thread） | 线程 Composer | 真实 |
| 停止任务 | task.stop（三重绑定） | 线程详情 | 真实 |
| 验收/返工 | task.review（三重身份冻结） | 线程详情 / DM 头部 | 真实 |
| 复制定位链接 | deepLink 形态 | 线程详情 | 真实 |
| 关注/静音（阅读订阅） | thread.subscribe / thread.subscriptions | 线程导航行 | 真实（r56） |
| 消息引用 | （草稿动作） | 消息菜单→插入草稿 | 真实（r56） |
| 消息表情 | message.react（toggle） | 消息操作行 | 真实（r56） |
| 收藏消息 | saved.add / saved.remove | 消息书签 + 搜索与收藏页 | 真实 |
| 成果与附件 | attachment.listByConversation / files.view | 线程「成果与附件」标签 | 真实 |
| 导出线程 MD/DOCX | export.create（thread）+openPath 白名单 | 线程导航行 | 真实（r56） |
| 长历史定位补读 | thread.history beforeSeq | #msg= 深链（自动补读≤5×100） | 真实（r56，合并装载） |
| 子任务定向（E3） | task.steer | — | 仅原界面（未换装，线程详情有定向入口） |

## 私信（DM）

| 能力 | 正式命令 | 入口 | 状态 |
|---|---|---|---|
| 会话列表/新建 | conversation.list/create | 私信页 | 真实 |
| 发送/排队/串行 | message.submit（dm） | Composer | 真实（排队合同=memberQueueContractR56 ③） |
| 重命名 | conversation.rename（revision CAS） | 头部操作行 | 真实（r56） |
| 归档/恢复 | conversation.archive / restore | 头部操作行 | 真实（r56） |
| 停止执行 | task.stop（三重绑定） | 头部操作行 | 真实（r56） |
| 继续队列 | dm.resume（显式泵一条） | 头部操作行 | 真实（r56） |
| 待验收/返工 | task.review（三重身份） | 头部待验收面板 | 真实（r56） |
| 中断恢复 | task.redispatch（绑来源 run；可恢复性服务端分列） | 头部中断面板 | 真实（r56） |
| 导出 MD/HTML/DOCX | export.create（conversation）+openPath | 头部操作行 | 真实（r56） |

## 全局 / 外围

| 能力 | 正式命令/事实 | 入口 | 状态 |
|---|---|---|---|
| 命令面板（Ctrl+K） | store+board.view+search.query | 全局快捷键 | 真实（r56；只导航不执行；legacy 期不响应） |
| 恢复检查 | recovery.status / dispatch.resume / recovery.reconcile / recovery.releaseProtection | 侧栏+自动弹一次 | 真实（r56；四类动作分列） |
| 搜索 | search.query（范围/类型/作者/日期/会话/分页） | 搜索与收藏页 | 真实（r56 补筛选；清空作废在途） |
| 收藏列表 | saved.list（missing/forbidden 如实） | 搜索与收藏页 | 真实（r56 范围生效+链接复制） |
| 活动流 | activity.list（游标分页） | 活动流页 | 真实 |
| 看板 | board.view | 任务看板 | 真实 |
| 文件与 Git（读） | files.view / project.file.read / git.status / git.diff | 文件与 Git 页 | 真实 |
| Git 写（stage/commit/push…） | git.* | 「在原界面执行 Git 操作」直达 | 仅原界面 |
| 成员管理 | member.list/setEnabled/runtime | 成员页 | 真实（runtime 绑定=仅原界面） |
| 待我处理 | mine.pending / reminder.confirm | 待我处理页 | 真实 |
| 设置 | app.settings.get/set | 设置页 | 真实（保存回读+显示同步） |
| 共享预览 | attachment.preview* | 全局预览面板 | 真实（r56 补窄/宽/全屏+引用） |
| 标题栏窗口控制 | zs:window 窄 IPC | 标题栏 | 真实（关闭走既有优雅链） |
| 派发防护标识 | runtime.status.dispatchGuard | 标题栏 | 真实（r56：演练·模拟派发/真实派发） |
| 同成员排队合同 | admission(member)+applyRecovery+dispatch.resume | （产品行为） | 真实（memberQueueContractR56 ①②③） |

## 冻结/未开放（不放假按钮）

权限档位 confirm（RT-23/B6 未验证）、OCR/图片模型输入（能力门显式二选一）、AUTO/DELIBERATE
派发（M0 边界——发送前提示而非禁发）、并行写入、DEV-11、价值评价、B 方案 Office 集成。
