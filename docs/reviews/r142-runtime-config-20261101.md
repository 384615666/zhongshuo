# R142：MCP/Skill 验收复核与网关配置独立性

根据用户提供的本机 R141 报告复核。Magpie 是个人网关，不能作为其他用户的安装前提；原验收覆盖的是报告列出的实际 CLI/模型组合，不代表已经测试所有网关与供应商。

## 结论和修复

1. **产品没有硬编码 Magpie 依赖。** DSH 从当前 profile 的官方模型服务读取供应商，Pi 从 CLI 模型目录读取。用户可使用 CLI 支持的官方服务、其他网关或本地服务。原报告中的 Magpie 型号是测试环境；不应复制给其他用户作为默认设置。Pi 的 MCP 默认 codemode 与 direct 是原生展示方式，不需要强制改成 direct 才能使用。
2. **修复 Pi MCP 配置身份缺口。** 原执行配置摘要没有包含用户级及项目级 `mcp.json`。已经排队的任务或待续接私信，可能在工具配置变化后仍匹配旧身份。现把实际存在的两类 MCP 文件计入摘要，内容只存 hash，不记录配置或密钥；发生变化时在启动前拒绝旧执行，用户需按当前配置明确继续。没有 MCP 文件的安装保持原身份算法输入，不制造无关失效。
3. **修正 Harness 配模文档。** `dsh web` 使用 web profile，众说固定使用 zhongshuo profile；用户只在 Web 设置自定义供应商，众说不一定读得到。文档现明确专用配置文件和保留已有条目的做法，没有自动复制其他 profile、凭据或权限。不能简单改成 `dsh --profile zhongshuo web`：当前连接组件只接受众说的专用参数，也没有 web-app bundle。
4. **安装器没有覆盖供应商配置。** setup 调用官方 `plugin add`，上游仅初始化不存在的 profile，保留已有 patch 和 bundles。R141 中替换整份 patch 导致模型消失是验收脚本写法问题，现有追加逻辑应保留，不加入 Magpie 专属分支。

依据：锁定的官方 DSH 0.2.1-rc.5 桌面 ASAR 中 app-boot/config-editor/plugin operations 实现，以及 [官方 profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、[供应商配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。CLI 参数以锁定的 Pi 1.4.0 本机实现为准。

## 本机 R141 验收脚本另行修复

原脚本未跟踪，属于用户另一轮工作；本轮只在本机修正该文件，不把整份原脚本或原 R141 报告加入本轮公开源码提交。原件保存在 ignored `dist/r142-review-backup/verify-mcp-skill-r141.original.mjs`。

- 原清理登记的是整个 `skills` 根目录并递归删除，存在误删其他技能的风险。现仅登记并清理本次新建的 `zs-test` 子目录；已有同名技能直接拒绝，保留原文件。
- 原 Pi 清理在已有同名服务器时漏还原，且 apply 提前失败也可能删除尚未修改的 MCP 文件。现以实际修改标记控制清理，原文件按字节还原，包括原同名服务器；原来没有文件时只删除本次创建的文件。
- Claude 原配置也按原字节还原，避免无必要的 JSON 重写。Harness 追加前补换行，兼容原配置末尾没有换行的情况。
- 去掉测试脚本的个人网关和固定安装目录默认值，默认沿用 CLI 已配置模型，增加 `--model`、`--effort`、`--executable` 参数；原验收历史的实际型号不作改写。

原报告的“九项配置还原通过”不能单凭脚本证明其他原有技能内容也完好；本轮没有据此声称已恢复历史上可能缺失的技能，也没有重建用户配置。

只读检查 R141 的 16 份报告及 assets，未找到个人技能备份或运行前技能清单；验收用 `zs-test-SKILL` 不是个人技能备份。因此可以确认旧清理代码有误，但无法仅根据现有证据列出历史上实际受影响的个人技能。另，R141 的 10 轮应理解为运行时 startTurn 账本尝试，其中两轮在供应商请求前失败，不能直接等同于 10 次付费供应商推理。

## 验证

MCP 身份新增 4 个回归，含用户级/项目级配置创建与更改、会话噪声排除、摘要不泄漏正文，以及旧授权在 spawn 前被拒绝。前两项在原实现均失败；修复后 8 个配置用例和 4 文件 66 个相关回归通过。双 TypeScript、改动代码 ESLint、UI/离线手册构建通过。

官方 Pi 1.4.0 本地固定响应 5/5 通过，未配置 Magpie：模型/等级读取不启动 MCP canary、没有供应商请求，正常结果规则与禁工具补交保持。该元数据用例在修复前也通过，故不把“查询模型会启动 MCP”列为已确认缺陷。证据 `dist/r142-official.json`。

R141 脚本仅提取配置 apply/revert 类，在临时 HOME 参数目录测试：四渠道保留既有其他技能、拒绝同名技能覆盖、还原配置原字节、Pi 只删除本次新建配置，共 9 项通过；原脚本的四个渠道负对照均检出问题。`rmSync` 额外校验目标只能位于夹具目录并拒绝技能根目录。未执行脚本的真实用户配置分支、prepare 或模型任务。证据 `dist/r142-script-safety.json`。

默认完整回归 316 文件、2765 通过、14 跳过、0 失败（含保留的既有预期失败反例），原件 `dist/r142-full.json`。官方 Pi 的 5 项显式本地测试已另行通过，不把默认跳过当作完成验证。本轮没有真实模型请求，也没有重跑 R141 真实 MCP/Skill 验收。

## V78 交付

- 稳定目录 `dist/desktop/desktop-daily-win-v78-r142-runtime-config-20261101`，ZIP 同级。程序 clean 源码 `e2d7a10339366ada5055372d688f8f77700d7853`，BUILD `bld_df3992438fc6001d`。
- 622 程序文件 SHA256 一致；ZIP 652 文件 CRC 通过，220454707 字节，SHA256 `57eb7184c493a8d8f1ebc3d2cbaf1179de62d48602346cdc2808078ee857637d`，不包含用户运行数据或 R141 验收脚本。
- 实际包内 Electron/Node/daemon 非主屏隔离数据根完成 14 项四渠道入口与本机 CLI 模型目录检查，正常停机、退出 0，未新增推理。证据位置见 `dist/r142-package-verify.log`。
- 沿用原数据 bat/vbs 与 V77 字节相同。正常退出旧版后使用 `start-existing-data.vbs`；不自动重跑旧任务，不复制供应商、凭据、权限或其他 profile。
- 仅本地提交，不推送。R141 报告保持原件未跟踪，原 R130/R131/R141 续工和其余未提交工作保留；本机 R141 脚本修正独立于公开源码提交。
