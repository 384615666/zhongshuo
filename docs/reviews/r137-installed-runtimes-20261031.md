# R137：本机 Harness 桌面版与 Pi 安装器实测

用户已在本机安装官方 Harness 桌面版及全局 Pi，要求实际尝试。核对版本分别为 DSH 0.2.1-rc.5、Pi 1.4.0。使用现有 CLI 管理的模型配置和凭据，在新建的独立目录中验证；未把旧项目、聊天或私有资料交给模型，未改写 CLI 的模型或凭据配置。

## 实际结果

| 渠道 | 配置模型 | 真实 turn | 结果 |
| --- | --- | --- | --- |
| Harness | `magpie/newapi/deepseek-flash` | 3 | 默认模型读取随机 marker 文件、跨进程原会话追问、显式选择含斜杠 provider 的模型并传入 low 等级，全部成功 |
| Pi | `magpie/newapi/glm-5.3-flash` | 2 | 文件读取和跨进程冷续接成功，实际 provider 为 `magpie`、model 为 `newapi/glm-5.3-flash` |

各轮均独立核对会话、文本和实际进程退出，退出码全部为 0。Pi 的受管 job 活跃子进程最终为 0，句柄已释放；另外做零推理的空闲 RPC 进程树取消核对，无遗留。Harness 模型目录读取到 19 项；Pi 默认模型及可用思考等级读取正常。用量来自 CLI 返回，费用仅在 CLI 提供估算时注明 estimated，不冒称渠道账单。

本轮共 5 个真实 turn，文件读取可能产生多条内部助手响应，不把 turn 数冒称 HTTP 请求数。无自动重试或额外质量对比。默认及显式调用的报告在 ignored `dist/r137-real/harness/`；Pi 的脱敏报告及受管退出证据在 `dist/r137-real/pi/`。这些含本机路径的原件不提交到公开源码。

## 实测暴露并修复的兼容问题

1. **Harness Windows 桌面入口**：实际 `dsh.cmd` 调用桌面 Electron，设置 `ELECTRON_RUN_AS_NODE=1`，传入 `--expose-internals` 及 ASAR 内的专用 CLI。原 npm-only 入口解析无法识别。现在支持该准确布局，也支持直接指定 `DeepSeek Harness.exe`；不通过 shell 执行批处理内容。环境仅传给该子进程，元数据和受管执行使用相同规则，未修改宿主进程环境。
2. **Windows `%~dp0` 与 Pi PATH**：该宏自身含目录分隔符；旧替换丢失分隔符。另 Windows PATH 中同时存在 Pi 的 Unix 无后缀 shim 和 cmd，原搜索错误优先选择 Unix 脚本。两者均修正，官方 Pi 安装器和 npm shim 均可读取。
3. **执行身份核对**：ASAR 内的虚拟路径不能用普通 Node `stat` 作为真实文件。现在以实际桌面 exe、ASAR、shim、环境及配置摘要核对；Pi 安装器当前版本文件参与身份摘要，升级后不默默沿用旧启动身份。
4. **Harness 模型编号及思考等级**：配置的 provider ID 可以含 `/`。连接插件按已配置 provider 的最长前缀解析，不在第一个斜杠处分割。`off` 在众说通用设置中映射为 `none`，执行时映射回官方 `off`。插件版本更新为 0.1.1。
5. **安装入口一致性**：适配器和独立安装脚本共用同一解析模块。便携包在 setup 脚本旁附带 `executable.mjs`，安装脚本可直接使用桌面安装器提供的 `dsh`，不要求用户改成 npm 安装。

已通过官方桌面 CLI 在本机创建众说专用 `zhongshuo` profile 并安装连接组件。安装只作用于这个专用 profile，未改默认/Web/OpenDesign profile，也没有重新安装 Harness/Pi。正式交付时把该组件来源更新为稳定的交付包路径。

## 验证与交付

新增本地安装器回归覆盖桌面 argv/env、ASAR 身份、布局拒绝、Pi shim 优先级和受管环境透传。相关后台/适配器 50 项通过，插件 14 项协议测试通过，双 TypeScript 检查及新增代码 lint 通过。

默认完整回归 312 文件、2726 通过、9 跳过、0 失败；跳过为 8 项显式开启的官方 Pi 测试及 1 项 Windows 文件 symlink 权限。运行命令 `node node_modules/vitest/vitest.mjs run --maxWorkers=4 --reporter=json --outputFile=dist/r137-full.json`。本轮本机真实 CLI 测试另行显式执行，未在默认回归中消耗额度。

V74 包的源码身份、文件校验与包内验证在交付时补记。只读/受限编辑/图片/格式修复的首版边界延续 R136，本轮不扩大权限宣称。
