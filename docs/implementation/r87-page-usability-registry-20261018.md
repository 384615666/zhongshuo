# R87 逐页便利性登记（rc4，2026-10-18）

对象：`desktop-daily-win-v26-r87-rc4-20261018`，clean BUILD `bld_da8c2e34f5842bd5`，源码 `16700ed86a65de28e6ca506c79f4dbf4804f1175`，程序清单 595 项。

口径：以下“已验证”只指所列最终包实际路径或同一 BUILD 的正式隔离副本。Chromium 可信输入自动化、系统窗口自动化和工程代理操作不等同于真人小白认证。系统保存对话框的打开动作使用可见控件的 DOM 触发，取消动作只对属于测试包的“另存为”窗口发送 `IDCANCEL`；这一边界不冒充人工鼠标认证。

逐页非模型 UI、数据、旧包和保存门来自 rc2/d9 clean BUILD；rc4 的两个 scoped commit 只改 Codex structured-final developer 注入和协调重复 handoff 抑制，按审阅范围未重跑这些非模型门。rc4 只补无协议自然协作、真实 Codex 有用结果及完整 integration。

| 页面 / 范围 | 用户目标 | 实际操作路径与步数 | 已见障碍与处理 | 简化后的可见反馈 | BUILD 证据 | 状态 / 边界 |
|---|---|---|---|---|---|---|
| 欢迎页 | 从空白数据知道下一步并打开项目 | 启动 BAT → 欢迎页 → “打开文件夹” → 系统目录选择 → 进入项目，1 个主操作 | 旧页面有实现说明；现保留一句话目标、单一主按钮和最近项目 | 打开后直接进入项目；取消选择保留原项目 | [visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json)、`add-ai-visible-model-controls.png` | 已验证；可信键盘/鼠标自动化 |
| 项目切换 | 打开另一个项目，取消时不丢当前上下文 | 侧栏“打开/切换项目” → 系统选择器 → 已注册项目直接打开；取消保持在原页面 | 旧流程有“浏览/打开这个目录”重复确认；现选定后直接完成 | 取消时显示“已取消选择，原项目和草稿保留” | [visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json) 的 `folderPickerCancel*` | 已验证 |
| 添加 AI / 模板 | 用已有渠道和模型一次创建 AI，并保存可复用配置 | 成员管理 → 添加 AI → 名称/说明 → 渠道与模型 → 保存；已配置成员可“保存配置模板” | 模型手填和跨渠道残留容易出错；模型列表现以下拉为主，手动 ID 折叠到高级 | 保存后成员投影立即刷新；模板明确“不复制凭据、认证结论、会话或任务” | [visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json)、[board-recovery-7/result.json](../../dist/review-r87-final/rc2-board-recovery-7-20261018/result.json)、[mixed-gateway-probe2/result.json](../../dist/review-r87-final/rc2-mixed-gateway-probe2-20261018/result.json)；`memberManagementR81.test.ts`、`memberFirstUseR87.test.ts` | 添加 AI、模型发现和模板表单已验证；混合网关产品模型目录与成员绑定已验证，0 模型调用 |
| 房间 / 串内成员 | 知道谁会收到，并把同伴加入当前串 | 默认房间 → 详情 → 参与成员 → 添加到本串；串内 @ 只列本串 AI | 旧界面把房间名单、跟进名单和实际参与混在一起；现在分列 | 添加后 `members` 与串成员立即更新；@全体显示本串范围 | [rc4 最终证据](r87-rc4-final-evidence-20261018.json)；rc2 mixed-4 工程提示历史票 [result.json](../../dist/review-r87-final/rc2-mixed-natural-4/result.json) | 串成员 UI 已验证；rc4 无协议自然回合 6/6 成功、3 个计划子任务全 DONE、无额外 OPEN 任务 |
| 主池 / 串输入 | 用 Enter 发送、Shift+Enter 换行、IME 候选确认不误发、Esc/Tab 可操作 | 默认房间输入 → 选择“仅记录”或收件人 → 输入 → Enter/Shift+Enter/Esc/Tab | 旧验证漏掉组合态结束；脚本修正后，IME Enter 不发送，结束组合后 Enter 才发送 | 发送后清空成功草稿；Esc 只关浮层并保留正文；窄窗控件仍在视口内 | [visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json) 的键盘、IME、Esc、Tab、900px/DPR 1.5 检查 | 已验证；不是真人手测 |
| 文件预览 | 找到报告、阅读、保存原件或取消保存，不丢项目 | 文件与 Git → 文件树 → 单击报告 → 预览 → “下载原文件” → 保存或取消 | DOCX 快照需等待 ready 才能取原件；保存路径只由系统对话框或显式工程目录决定 | 取消后返回预览；项目目录字节不变；自然任务中的 v2 保存件与工作区字节一致 | [visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json)、[save-reopen.json](../../dist/review-r87-final/rc2-final-natural-1/save-reopen.json) | 已验证；打开保存框为 DOM 触发，系统取消仅针对 owned dialog |
| 成果 / 返工 / 验收 | 找到当前成果，提出修改并确认最新版本 | 串详情 → 交付与验收 → 找当前待验收版本 → “按这些意见修改”或“确认完成” → 精确验收 | 版本文件可能叫 `v2` 而交付 revision 是另一序号；界面分别显示文件名和交付版本 | 验收后只绑定当前 delivery；历史版本保留 superseded | [rc4 最终证据](r87-rc4-final-evidence-20261018.json)；rc2 历史精确验收 [result.json](../../dist/review-r87-final/rc2-mixed-v2-accept-1/result.json)；rc2 保存/重开 [save-reopen-confirmed.json](../../dist/review-r87-final/rc2-mixed-natural-4/save-reopen-confirmed.json) | rc4 根当前为 REVIEW，pending delivery revision 1；不冒充用户验收。rc2 工程提示根的 revision 3 验收只作历史 |
| 任务看板 | 从完成/失败/进行中状态定位到原任务 | 侧栏任务看板 → 当前项目 → 状态分组 → 卡片定位线程 | 旧看板混合业务状态和运行状态；现分列并在详情操作 | 看板只读，不拖卡改状态；失败/待验收原因可见 | [board-recovery-7/result.json](../../dist/review-r87-final/rc2-board-recovery-7-20261018/result.json) | 已验证 |
| 设置 | 找到 AI、外观、数据、恢复，不被工程项淹没 | 侧栏设置 → 按目的分组；“数据与存储”提供备份/导入；工程诊断在高级区域 | 程序路径、协议、诊断说明旧版占据常用页面；现收进高级 | 常用操作在首层；不提供无法执行的假开关 | [data-copy result](../../dist/review-r87-source/r87-data-copy-probe-2026-10-17T16-23-35-067Z/result.json)、[visible-usability-10/result.json](../../dist/review-r87-final/rc2-visible-usability-10/result.json) | 数据设置已验证；其他设置项由同一 BUILD 源码和页面路由检查覆盖 |
| 错误恢复 | 看懂“发生了什么、内容是否还在、下一步做什么” | 侧栏恢复检查 → 普通摘要 → 按需“查看详情” | 旧摘要直接打印 `pendingDispatchKeys` 等技术 ID；d9 已移入高级详情 | 普通摘要使用“待确认/中断/保护”等自然语言；不自动重发、不自动解除保护 | [board-recovery-7/result.json](../../dist/review-r87-final/rc2-board-recovery-7-20261018/result.json)；`localDataCopyR87.test.ts` 与恢复回归 | 已验证；本轮自然根未制造新的 UNKNOWN，原 UNKNOWN 保护语义由正式测试覆盖 |
| 数据备份 | 备份完整本地数据，正常关闭、复制、校验并自动重开 | 设置 → 数据与存储 → 备份全部数据 → 程序关闭 → 独立进度窗口 → 自动重开 | 在线复制 profile/SQLite 不安全；已改为关闭后完整根复制、逐文件 hash、scratch SQLite 校验 | 显示进度和失败原因；原根保留；完成结果跨重开可见 | [data-copy result](../../dist/review-r87-source/r87-data-copy-probe-2026-10-17T16-23-35-067Z/result.json) | 已验证：75 文件、0 模型调用 |
| 升级 / 使用已有数据 | 选择旧包或旧数据时，使用它当前真正保存的数据位置，而不复制陈旧目录 | 设置 → 选择已有数据 → 选旧包 → 选新副本位置 → 程序关闭复制校验 → 切换位置 → 自动重开 → 普通 BAT 再开 | 旧包曾经切换过数据位置时，物理 `server-data` 可能是陈旧 A；d9 改为优先读取有效保存位置，损坏/缺失指针拒绝而不静默回 A | 导入当前 B 的根身份、profile 标记和消息；新副本后再开仍指向 B | [old-package-ui-import-3/result.json](../../dist/review-r87-final/rc2-old-package-ui-import-3-20261018/result.json)；独立 d9 负例 `old-package-selection-d9bc8c8` | 已验证有效旧包 UI 路线；缺失/坏指针和备份容器由永久测试覆盖 |

## 当前候选与失败边界

最终双模型成功回合已按人类新授权切换到混合网关模型，rc4 无协议自然根当前真实结果为 6/6 调用成功：

- Claude 渠道：`deepseek-flash`。
- Codex 渠道：`ccs-new/glm-5.3-flash`，产品模型下拉和成员配置已实际核到，reasoning 为 `high`。
- 混合网关：产品子进程默认读取 `C:\Users\user\.codex\config.toml`，provider `custom`，本地 endpoint `http://127.0.0.1:15721/v1`，wire API `responses`；网关模型目录含 `ccs-new/deepseek-flash` 与 `ccs-new/glm-5.3-flash`。未记录任何凭据。
- 实际协作类型：Codex 在计划子任务读取同一 DOCX/PDF，独立给出表格、字体、元数据和内容流发现；DeepSeek 在后续计划步骤汇总写入文件，最后 integration 生成根交付。Codex 子任务、`coordination_steps.downstream.upstream`、manifest/hash 与最终文件均由聚合器绑定。
- 根 task `task_811f8365-3c39-4dc5-9614-4136282cda37` 为 REVIEW，pending delivery `dlv_turn_2470538f-94fa-4ef5-b48f-70d64d05fc2c`（revision 1）；`报告复核-v1.md` 26,876 B，SHA-256 `3dc68cdaffdeb3a89a2506aafa97f24f5eb01fcf5628ce020a8b9f15299fa27d`。
- 最终聚合 [r87-rc4-final-evidence-20261018.json](r87-rc4-final-evidence-20261018.json) 当前 `ok=true`，17 项检查全过；`releaseQualified=false`，等待审阅方独立核验。

rc4 根 `coordination_messages` 为 0，实际结果通过 3 个计划步骤的 `downstream.upstream` 引用传递；2 条与计划下游目标重复的 handoff 被审计后抑制，未生成额外任务。失败根继续保留并纳入聚合检查：mixed natural-1 的 5 分钟 deadline UNKNOWN、natural-2 的 10 分钟 deadline UNKNOWN、natural-3 的 GLM TaskComplete `turn.outputInvalid`、较早 `gpt-6-luna` 周额度 FAILED、无协议提示的早期 `outputInvalid`、rc3 重复 OPEN 子任务、rc4 提前关窗 UNKNOWN 和首次混合保存 CDP timeout。rc4 clean 复核根本身没有 UNKNOWN、FAILED、inflight 或额外子任务。

当前状态是工程/产品路线候选已聚合通过，等待审阅方有限独立核验；这里的自动化不等同真人小白认证或用户最终验收，包也保持冻结不变。

## 仍需保留的文案残留

本轮没有因为纯文案再冻结新包。逐页检查仍看到少量工程词：

- 添加 AI 页面仍出现“稳定 ID / 实例短标识”等身份说明。
- 未配置成员的输入区仍显示“未绑定 runtime”。
- 模板表单仍有“配置快照 / runtime”说明。

这些不构成新增功能阻断，但说明“工程文案全部清空”尚未完成；最终记录会继续如实列出，不用功能通过代替文案完成声明。
