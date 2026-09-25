# Runtime 注入协议核对与验证矩阵

日期：2026-09-20。范围：本机 CLI 帮助、参数解析和生成协议类型，不含真实模型请求、权限行为或沙箱认证。补充 2026-09-17 报告，不覆盖该报告的历史版本与结果。

## 已核对的事实

| 项目 | 本机结果 | 能证明什么 |
|---|---|---|
| Claude 版本 | 2.1.278 | 与主设计此前的 2026-09-20 记录相同 |
| Claude 文件参数 | 帮助在 `--bare` 说明中提及 `--system-prompt[-file]` 和 `--append-system-prompt[-file]`；向后者传不存在的文件，退出并报 `Error: Append system prompt file not found:` | 参数被识别，缺文件被拒绝；不等于文件内容已送达模型 |
| Claude 快照 | 帮助声明 `--system-prompt-snapshot <on\|off>` 默认 on；首次请求记录系统提示词，后续 request/resume 重放，直到 conversation compacted；off 每次重新渲染；recording 尚未启用的路径可能无效 | 是帮助声明的行为，必须按实际路径验证，不能仅检查 daemon 文件 hash |
| Codex 版本 | 0.155.1 | 相对同日此前记录的 0.154.0 有变化；这不是工程依赖已锁定 |
| Codex 生成工具 | `app-server generate-json-schema` 与 `generate-ts` 均成功生成 | 可按安装版本固化协议类型，不需要用真实模型请求猜字段 |
| ThreadStartParams / ThreadResumeParams | 均有 developerInstructions；Resume 必填 threadId | 该版本 schema 存在对应注入字段，不等于 resume 的有效提示词已验证 |
| TurnSteerParams | required 为 expectedTurnId、input、threadId | adapter 必须映射内部 turn 与 provider turn，不能省略 expectedTurnId |
| TurnStartParams | 含 outputSchema、approvalPolicy、sandboxPolicy、approvalsReviewer | 参数存在，不证明审批通道、策略执行和拒绝后恢复有效 |

Claude 帮助关键原文：

```text
every later request and resume sends the record as-is, even when
a later launch passes different text, until the conversation is compacted.
off: never record; the prompt is rendered fresh every request
(for iterating on prompt text). No effect where system-prompt
recording is not yet enabled.
```

本次参数探测使用 `claude --bare -p --append-system-prompt-file <不存在的临时文件> test`，在文件校验失败处退出，没有进行模型调用。不要将此命令的非零退出码误判为参数不存在，也不要为复验改成真实项目文件或真实凭据。

可复跑命令（输出目录须使用独立临时目录，不覆盖项目）：

```powershell
claude --version
claude --help
codex --version
codex app-server generate-json-schema --out <临时目录>/schema
codex app-server generate-ts --out <临时目录>/types
```

正式实现时记录二进制路径/版本、生成命令与 schema hash；升级只使旧能力记录成为旧版本证据，不自动迁移为新版本 supported。官方生命周期说明见 [OpenAI App Server](https://developers.openai.com/codex/app-server)；本机生成类型决定该安装版本的精确字段。

## 待执行的真实路径验证（PP-01 / PP-02）

使用独立测试会话和无敏感信息的提示词标记 A/B，不读取生产会话，不修改全局 CLI 配置。以下均为待执行用例，不能因 schema 生成成功勾选通过。

| ID | 路径 | 必须验证 |
|---|---|---|
| V01 | 新会话首请求 | A 文件/协议字段进入实际请求；记录应用模板版本/hash、runtime/adapter 版本与有效 snapshot 配置 |
| V02 | Claude 默认 on，原会话 resume | 应用继续传绑定 A；启用 recording 时实际重放 A。隔离测试额外故意传 B，确认帮助声明的“仍重放 A”是否在该路径生效，不将该故意错配用于产品运行 |
| V03 | Claude on，compact 后续接 | compact 后重新渲染仍使用绑定 A；应用升级到 B 后的旧会话不能误读最新版。记录 compact 是否确实发生，不凭上下文长短推断 |
| V04 | Claude 显式 off | 独立测试确认每次重新渲染；产品 adapter 恢复旧会话仍只能传绑定 A，off 不等于允许热替换 |
| V05 | recording 不支持/未知；新建 B 会话 | 支持情况如实标 unsupported/unverified；新建会话 B 必须使用 B，不复用 A 的 providerSessionId。不将 on/off 无差别直接解释成验证通过 |
| V06 | Codex App Server start/resume/steer | start 与 resume 使用绑定文本；steer 仅追加活跃目标，错误 expectedTurnId/已结束目标拒绝且不串入新 turn；exec 通道不能代替本项 |

优先使用该 runtime 支持的受控请求观测或测试传输，记录实际应用模板片段的 hash/标记，避免归档整份含机器信息的系统提示词。若只能让模型回答标记，那只能证明行为探测结果，不能证明逐字一致；必须在结果中标注证据等级。快照系统尚未启用的分支记录为不适用或未验证，不能冒充覆盖了启用分支。

B6/RT-23 另行验证计划档直接编辑/shell 写入、原生允许/拒绝、续接既有规则及 Windows 沙箱失败不降级。本矩阵不为这些权限行为作认证，也不为实际软件勾选 PP 通过。
