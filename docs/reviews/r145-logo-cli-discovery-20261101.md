# R145 正式 logo 与本机 CLI 自动发现（2026-11-01）

用户要求后续项目 logo、安装包统一使用根目录 `logo.png`，首页与 README 交其他 AI；并要求对未安装 Claude/Codex 的用户按实际已安装的受支持 CLI 准备默认 AI。

## 实现

- 新增根目录 `AGENTS.md` 与 `docs/implementation/branding.md` 记录唯一 logo 源。便携包与安装包共享 `scripts/lib/brand-icon.mjs` / `.ps1`，用 Windows 自带 System.Drawing 等比生成七尺寸 ICO，随包带原 PNG；安装器、快捷方式、卸载列表、桌面窗口使用新图标。保留原图背景与留白。首页与 README 未修改。
- 原有发现机制只支持 Claude/Codex，现扩展至共享目录中的 Claude、Codex、DeepSeek Harness、Pi。仅采用正式适配器能够解析且确实存在的程序入口，未知/缺失入口不自动添加。Codex 补充 PATH 原生程序回退，保持既有 npm shim 优先与显式绑定失败不回退的语义。
- 首次默认项目、打开项目继续扫描；新建房间未显式指定成员名单时重新扫描，新增成员只进入本次新房间，不改旧房间名单与协调者。指定名单时保持选择；同 commandId 重放不重复扫描、添加或建房。远程入口不触发本机自动发现。
- 成员页新增「扫描本机 AI」，显示新增、已有与未采用原因；无可用 AI 的房间提示安装配置 CLI 后扫描或手动添加。已有成员的名称、启停、模型、权限、绑定保持原值。
- Claude/Codex 仍沿用现有的明确可识别默认模型要求，缺模型/配置不确定时说明原因，不猜测模型。Harness/Pi 可由 CLI 自行解析默认模型；Harness 还检查众说 profile 连接组件文件，缺少时提示运行随包 setup.cmd，不自动安装或覆盖配置。发现程序不等于登录、模型或连接组件协议已认证。

## 验证与边界

证据目录 `dist/r145/`（ignored，本机）：

- 三组最终相关回归去重 **123 项通过、0 失败**，`verification.json` 汇总。涵盖零 CLI、仅 Pi、全部四渠道、Harness 缺组件、Claude 缺模型、原生 Codex、首启、建房补扫、重放、旧名单、显式名单、禁用成员、远程不扫描及既有成员/Codex 回归。
- `tests/browser/memberChannelsR136.test.ts` 的两组真实 Electron 渲染交互均通过，每组 35 项界面断言，包含扫描按钮、检测结果与原因呈现。界面桥使用合成回执，无供应商请求。
- 已跟踪后台源码/测试加本轮新测试的 TypeScript 检查通过；hifi TypeScript 通过。全工作区原命令仍有 13 处错误，全部位于原有未跟踪 R130 审计测试/辅助文件；原文件未改。详见 `typecheck-workspace.log`。
- 本轮新增/其余修改文件 lint 通过；`commands.ts` 10 项、`Room.tsx` 12 项既有 lint 与 HEAD 逐规则/消息对照完全一致，新增 0，见 `lint-baseline.json`。
- UI 与 daemon 构建通过。多尺寸 ICO 已生成（53686 字节），256 像素帧目视确认；`node scripts/make-windows-installer.mjs --validate-template --version beta.2` 成功编译带新图标的 Inno 模板。源 logo SHA256 为 `5f32d9fa56968b2a1d749db1c94a1605e076d71e19867b7d0b31c94c0fcf5076`。

模板编译产物仅用于验证，不是可交付的新应用安装包。本轮未重新安装、未发布、未改用户运行数据或 CLI 配置，真实模型调用为 0。pnpm 在现有 node_modules 联接目录上触发安装自检并被自身保护拒绝，后续直接使用既有 Node 工具入口完成检查，未重装或删除依赖。过程中新增测试的类型断言换行及 UI 断言计数已修正，以上数字均来自最终通过报告。
