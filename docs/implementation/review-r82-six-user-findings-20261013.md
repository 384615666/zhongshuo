# R82 用户六项反馈与独立源码复核

当前 HEAD `0e0257c`，分支 `codex/full-implementation`。用户测试的是 R82 的 v21 首版候选。六项反馈未通过，不能把工程门通过代为用户验收或继续宣布首版阻断全部关闭。

## 用户事实与本次明确决定

1. 项目管理打开后卡在搜索，点其他位置不能关闭，界面无法操作。
2. 执行成员应默认全部权限、图片默认可发送给模型，不要求用户选择识图资格。
3. runtime 配置缺少思考等级。
4. 房间成员与房间设置两个入口打开同一个界面。
5. 输入区按钮及符号位置不一致，用户提供了局部截图。
6. 回复串缺少发起消息；成员正常回复显示了大段 JSON、ID/hash/内部字段，用户提供了整窗截图。

已专门向用户澄清权限范围，用户选择原话：**与 CLI 全权限模式一致，可读写整个电脑并执行命令**。此决定替代先前的默认只读、仅项目内授权政策，不再以旧 R82 约束阻止新实现。保留已有用户显式选择的只读设置，不把模板偏好、实际权限或旧任务快照混为一谈。产品全权限可用不等于允许工程在用户原文件上制造验收变更；工程仍用自有独立目录、合成文件和已有账号。

必要多次真实调用的既有授权有效；优先当前可达、实际配置的 Claude 渠道。R82 报告记录 deepseek 的 402 与后来 GLM 成功，不应自动改用户渠道或假定余额恢复。图片和思考参数的必要真实验收可用合成输入完成，不发送用户测试文档。

## 源码证据（尚未独立原生复现菜单卡死）

- `src/ui/hifi/components/TitleBar.tsx` 的 ProjectMenu 自行绘制在 `.zs-titlebar` 内，使用 autoFocus 和全窗遮罩，未使用共享 Menu 的外点与 Escape 处理。`src/ui/renderer/hifi-flag.js` 标题栏为 `-webkit-app-region:drag`、极高层级，只有指定 no-drag 类例外。检查拖动区域、portal/遮罩及命中层级是具体调查方向，不直接宣称已经证明唯一根因。
- R82 启动器探针的按钮 helper 使用 DOM `element.click()`。此路径不能单独证明无边框窗口实际鼠标命中及外点关闭；下一轮必须补真实鼠标/键盘验收。
- `src/ui/hifi/pages/Room.tsx` 两个房间菜单入口均调用 `setSettingsOpen(true)`。回复区域仅渲染 `replyThreadMessages`；锚消息已经读取，但没有放在回复消息列表内。用户看不到完整对话的反馈有直接源码依据。
- `src/adapter/claude/cliAdapter.ts` 把 `structured_output` JSON.stringify 后作为 `message.completed.text` 发出；`src/daemon/dispatchWorker.ts` 对 message.completed 直接落普通回复；`MessageView` 将正文作为 RichText。因此正式协议与普通对话显示没有分层。原始合同可保留在交付及诊断，不能全部作为正常回复展示。
- 正式 runtime/模板中思考等级尚未接线，原型及 loader 却有 effort 字段。测试 fixtures 中 Codex model/list/TurnStart 等协议具备相关字段，不能继续仅显示原型值。
- 本次独立运行 R82 三个专项文件 `writeAdapterInputsR82`、`projectWriteAccessR82`、`writeCertificationR82`，18/18 通过。未重新运行 1017 全套、发布包、真实账号或鼠标菜单复现。

## 官方文档核对（OpenAI Docs）

2026-10-13 实际打开 https://developers.openai.com/codex/app-server （重定向 https://learn.chatgpt.com/docs/app-server）。官方要求 model/list 的模型、默认强度与 supportedReasoningEfforts 按实际返回值使用，而不是硬编码示例；inputModalities 描述输入能力。turn/start 的 effort 可以覆盖思考强度，后续同线程会继承。

官方兼容规则：旧 model/list 缺失 inputModalities 时按 text/image 处理。真实渠道请求失败仍应如实给原因，不能“所有模型都已认证”的假状态，也不能再以离线工程证书作为正常图片发送的人工开关。

## R83 方向

先复现并修复全局菜单阻断、完整会话与用户可读回复，再落新默认权限、自动识图和真实思考强度；统一重复入口与共享控件。验收用普通自然语言，不在合成用户消息里提示 resultKey/TaskComplete/JSON schema。源协议、实际落盘与 UI 体验分列；同一最终包由真实启动器复证这六项。迁移 001–050 冻结，必要新迁移只追加。
