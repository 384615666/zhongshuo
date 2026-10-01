# 通知人工验收结果归档（2026-10-01，第二十八轮一）

> **结论：通过**。用户已在本机完成 Windows 桌面通知人工验收并回填结果；工程侧只读核对
> 与回填一致。**本文件为归档副本——原始回填保留在验收包 `results\result.txt`，不覆盖、
> 不改动**（原文见下节逐字引用）。

## 验收产物身份

- 包：`dist/desktop/通知人工验收/`，buildId **bld_14f26baeb5a8d656**（BUILD.json createdAt
  2026-10-01T10:09:16Z；purpose=通知人工验收（fake+guard 内置；ASCII 启动器））。
- 模式：fake 运行时 + ZS_REAL_DISPATCH_GUARD=1 + 独立 appData + 完整前缀管道——启动器
  内置（用户零环境变量零配置）；窗口标题「模拟验证模式」标识。

## 用户原始回填（逐字，results\result.txt）

```
通知人工验收结果（待回填——2026-10-01T10:09:16.572Z 生成模板）
1. 房间线程通知出现：是
2. 私信通知出现：是
3. 点击①定位房间任务线程正确：是
4. 点击②定位私信会话正确：是
5. 出现重复通知：否
6. Windows 通知中心留有记录：是
7. 异常描述：
```

即：两条通知均出现；两条点击定位正确（房间任务线程/私信会话各一）；无重复通知；
Windows 通知中心留有记录；未报告异常。

## 工程侧只读核对清单（验收后读取同 appData，只读）

| 核对项 | 结果 |
|---|---|
| reminders | 每次运行 2 条（房间线程+私信），共 5 次运行 10 条，全部 status=done（once 计划终结） |
| reminder_occurrences | 10 条全部 fired（待确认态——通知点击只定位不确认，与产品合同一致） |
| real_calls | **0**（5 次运行全 fake+guard，零真实模型请求） |
| agent_turns / tasks | 7 turns/7 tasks 全 DONE：5 条 room_task（各次 seed 房间任务 fake run）+ **2 条 dm_turn**——用户在其中一次运行额外点了「确认执行」（私信提醒确认→dm_turn 正式派发→fake 执行） |
| reminder_calls | settled ×2（上述两次确认执行的调用台账已结算——预算/归属链正常） |

即用户在规定步骤之外**顺带验证了确认执行链**（确认→正式任务→fake 执行→台账结算），与
「点击只定位不确认」的定位步骤互补。

## 脱敏运行记录

- 用户共运行启动器 5 次（seed 按 runId 留档，文件名时间戳 100924/101314/101909/102550/
  103116，UTC——均含 taskSettled=true、daemonExitCode=0、stop-result complete 且非 forced，
  详见包内 `results\seed-*.txt`；重复运行不覆盖回填，验证留档合同生效）。
- 通知日志（zs-notify-log，renderer localStorage）各次运行 permission=granted→created→
  shown→close 五相完整；去重集（zs-notified-rem）含全部键——同一事项无重复通知与服务端
  台账/客户端日志两侧一致。

## 验收范围声明（不过度推广）

- 本结论仅覆盖：**该 buildId（bld_14f26baeb5a8d656）** 在**验收者本机当前 Windows 环境**
  （通知中心开启、无专注助手拦截）的人工验证。不推广为「全部 Windows 版本/设置兼容」：
  Windows 版本差异、专注助手/勿扰模式、通知显示时长设置、企业策略等未做覆盖矩阵。
- Web Push 等远程通知渠道为后续范围（单列）；fake+guard 模式下的送达验证不代表真实
  runtime 场景的通知授权变化。
- 验收包与结果文件保留原样（后续如重跑由用户新建回填，不覆盖本记录）。
