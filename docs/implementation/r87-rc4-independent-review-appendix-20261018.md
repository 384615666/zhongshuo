# R87 rc4 有限独立评审

结论：本次评审无阻断项。普通中文请求的 DeepSeek + GLM 协作缺口已关闭，可以交付本候选开始日常使用。本结论针对本轮已批准的有限范围，不代表真人已验收软件或已验收测试任务。

候选：`D:/zhongshuo/dist/desktop/desktop-daily-win-v26-r87-rc4-20261018`，BUILD `bld_da8c2e34f5842bd5`，运行源码 `16700ed86a65de28e6ca506c79f4dbf4804f1175`，文档提交 `f1da3df`。595 个程序文件在冻结包和实际自然测试副本内均逐字节匹配清单；交付包无 server-data。

审阅输入是已封存的 `docs/implementation/r87-rc4-final-evidence-20261018.json`，SHA-256 `9e6c4edce9173d567ba3c01168fe57050d080862d0715a25eca2cbe02d2e2df0`。本地原件与已推送 Git 对象相同。保持原票 `releaseQualified=false` 与原 hash，不回写历史票；本评审作为独立结论附录。

## 独立核验

- `rc4-final-16700ed-confirmed/result.json`：33 项通过。只复制明确属于工程合成根的 SQLite/WAL/SHM 到审阅方 scratch，再连接副本；核验完整性、真实调用、持久化人类正文、模型计划、三条依赖边、交接完整内容、当前交付和实际报告字节。
- 原生配置为 Claude `deepseek-flash` 与 Codex `ccs-new/glm-5.3-flash / high`；6 条实际调用和 6 个 turn 全部成功。Codex 的 `response_model` 未回显；报告的是已核实的请求与成员绑定身份，不声称后端回显了模型名。
- 两条人类消息和两份成员说明均未夹带 TaskComplete/schema/JSON/Markdown/answer 等协议提示。协调计划逐字对应成功 DeepSeek turn 的原生控制结果；3 个计划子任务 DONE，实际下游输入含准确上游结果、源 turn 和交付 manifest。
- 两条抑制记录对应真实作者与消息 hash；完整消息无损保留在计划接收者的序列化输入内，未生成额外任务。此自然根走模型生成计划与步骤上游依赖，`coordination_messages=0`；不将它冒称为本根新证明了动态带外交接。
- 当前根任务真实状态 `REVIEW`，delivery revision 1 / `pending` / `reviewed_at=null`。报告 `报告复核-v1.md` 为 26,876 字节，SHA-256 `3dc68cdaffdeb3a89a2506aafa97f24f5eb01fcf5628ce020a8b9f15299fa27d`，实际应用后的改动集与当前交付绑定。报告中有 GLM 的具体跨格式发现及正确预算结论。
- `codex-transport-16700ed-confirmed/result.json`：8 组、60 项通过。使用准确 Git 源码构建适配器和本地 owned Node mock，检查新会话/恢复、只读/完整权限、纯图片字节/文字输入；站立提示与结构化终态说明在原生 developerInstructions，未污染人类输入，outputSchema、权限、恢复身份和 effort 保留。这不是新增真实 Codex、识图或提供方调用认证。
- `handoffs-16700ed/result.json`：5 个正式 worker 场景、71 项通过。动态 A→B→C→B→A、未获准成员、评审写入、UNKNOWN 和非法结果边界仍成立；UNKNOWN 不自动重放，失败不冒充已接收。
- `rc4-final-16700ed-confirmed/historical-artifact-hashes.json`：54 份历史原件实际 hash 全相等。原失败、工程提示正例和前候选均保持原事实。完整测试 JSON 的原 hash 与 1259/1259 结果已独立核对，首次 WPS/Microsoft Office 检测失败未抹除。

## 范围与交付口径

从 rc2 到 rc4 的产品源码只修改 Codex 适配器与成员交接模块。此前 rc2 的 UI/数据/保存/返工验收证据作为旧 BUILD 范围保留；未声称在 rc4 重新跑过这些原生路径，也未将 rc4 的待验收交付说成用户已验收。

本次没有新增真实模型调用，没有接触用户文档、数据根、凭据或重置券；没有修改、暂存、提交或推送产品源码。审阅只写自己的 ignored 工程目录。没有为凑验收数量再开新的开发批次。

自有探针的原始失败也保留：transport 首版遗漏 mock model/list 的 high 元数据；rc4 首版未处理手递消息在接收输入中的多层 JSON 转义。这些经定位均为审阅夹具假设，修正后的确认票另存，不归为产品缺陷。

建议交付时给用户一个明确的 rc4 启动入口、当前已验证的两个模型，以及程序内“使用已有数据”入口。用户可以开始做实际任务；无需再执行历史回归清单。
