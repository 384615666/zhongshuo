# 众说

众说是一个 Windows 本地多 AI 协作工作台。以文件夹作为项目，在房间里交代工作，让不同 AI 分析、执行和核对，在同一条对话里查看进展、文件成果并继续修改。

![众说房间界面](docs/user-guide/images/02-workspace.png)

## 日常使用

打开 **设置 → 操作手册** 查看图文教程，或阅读仓库内的 [操作手册](docs/user-guide/README.md)（[离线 HTML](docs/user-guide/index.html)）。教程包含 19 张带编号的截图，从打开项目、添加 AI 到发出第一条消息逐步说明。

- **项目与房间**：每个项目对应本地工作文件夹，房间按话题组织任务。
- **多人协作**：用自然语言说明谁先做、谁核对；在原对话串中补充要求。
- **私信**：与一位 AI 独立讨论，每条新私信保持独立上下文。
- **任务与成果**：查看执行进展、停止或继续工作，预览、保存文件并提出修改意见。
- **本地资料**：聊天、附件、设置和任务记录保存在本机。

AI 成员使用电脑上已安装、登录并配置的 Claude 或 Codex 渠道。第三方兼容模型由对应渠道配置。

## 从源码构建

准备 Windows、Node.js 24 或更高版本、pnpm 和 Git：

```powershell
git clone https://github.com/384615666/zhongshuo.git
cd zhongshuo
pnpm install --frozen-lockfile
node scripts/make-desktop-daily.mjs desktop-daily-win-local
```

构建结果位于 `dist/desktop/desktop-daily-win-local/`。双击其中的 `start-desktop.vbs` 启动应用，再按图文手册选择项目和添加 AI。该目录也附带离线操作手册。

## 开发与验证

```powershell
pnpm typecheck
pnpm typecheck:hifi
pnpm test
pnpm build:ui
```

默认测试使用本地、模拟或临时数据；真实模型测试使用单独配置，GitHub sandbox 测试也使用独立配置。它们会消耗模型额度或写入远端仓库，需明确选择对应测试后再运行。

| 目录 | 内容 |
| --- | --- |
| `src/contracts` | 命令、事件与数据契约 |
| `src/domain` | 路由与任务领域规则 |
| `src/persistence` | SQLite、迁移与持久化 |
| `src/adapter` | Claude、Codex 及模拟执行端 |
| `src/daemon` | 调度、协作与执行服务 |
| `src/ui` | Electron 桌面客户端与正式 React 界面 |
| `docs/user-guide` | 面向用户的图文操作手册 |
| `tests` | 单元、集成、界面及单独配置的执行端测试 |

`hifi-prototype/` 是交互原型，有独立的 package.json；正式应用源码在 `src/`。

修改用户功能或按钮入口时，同时更新手册步骤和对应编号截图。`pnpm build:ui` 会从同一份手册源码生成应用内版与离线版；`node scripts/capture-user-guide.cjs` 可用独立示例项目重新采集截图。

## 许可证

众说自有代码使用 [MIT 许可证](LICENSE)。随项目保留的第三方代码与资源使用各自许可证，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。
