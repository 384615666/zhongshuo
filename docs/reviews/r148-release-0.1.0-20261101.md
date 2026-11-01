# R148 正式发布 0.1.0（2026-11-01）

用户明确要求将当前图标修复版本发布为 0.1.0。公开仓库为 `384615666/zhongshuo`，远端 main 已包含用户安排其他 AI 完成的首页与 README；本次在独立发布分支合入 R145—R147，再统一正式版本号，不改首页设计。

## 版本与源码

根 package.json、安装发行元数据、便携元数据均为 `0.1.0`。构建器同时支持稳定版与 beta；Windows 四段版本将稳定版映射为 `0.1.0.65535`，高于同核心版本的所有 beta.N（N < 65535），可从 beta.3 覆盖更新。对外名称、文件名与 GitHub tag 使用 `0.1.0` / `v0.1.0`。

发布继续采用当前用户安装范围、原 AppId/数据目录、七尺寸原生图标与内容哈希快捷方式图标。用户运行中的安装与数据不覆盖。全部源码来自公开克隆及其派生分支，没有引入旧私有仓库历史、未跟踪审计或用户运行文件。

## 发布流程

冻结源码后构建正式安装器，验证文件清单、版本、图标及 CLI 生命周期；用隔离目录实际测试 beta.3→0.1.0 安装升级、运行中维护拒绝、历史保留和卸载数据保留。通过后将源码发布到公开 main，创建绑定源码提交的 `v0.1.0` tag、上传 EXE/SHA256/构建元数据，再将 GitHub Release 标为正式版和 latest。发布文本见 `docs/releases/0.1.0.md`。

## 正式发布结果

- 2026-11-01 14:53（Asia/Shanghai）正式发布：[众说 0.1.0](https://github.com/384615666/zhongshuo/releases/tag/v0.1.0)。Release draft=false、prerelease=false、latest=true；未登录请求确认 latest API 与安装包下载均可公开访问，下载 HEAD=200。
- tag `v0.1.0` 精确指向冻结程序源码 `46e96a6394230bb0d8ba015bda5cc07ebc9fd2fe`，公开 main 已同步。后续本发布记录不改变 tag/安装包源码身份。最新首页与 README 已合并，原私有历史没有引入。
- 安装镜像 `bld_c3d7de0e4422245c`，clean 源码，660 文件逐项 SHA256/隐私扫描通过；便携源镜像 `bld_a2689639641120d7`。Windows 数字版本 `0.1.0.65535`，用户可直接从 beta.3 升级。
- 安装包 `Zhongshuo-Setup-0.1.0-x64.exe`：158174405 字节，SHA256 `6da931962e24c6ce10a92844f3176b5e1fd41b4cd77b96f06bedb82c5bcfc4a2`。已上传 EXE、`.exe.sha256`、`.release.json`；发布前将 GitHub 三个资产的服务端 digest/字节数与本地逐一核对，全部一致。GitHub 自动源码归档绑定相同 tag。
- 默认完整回归 **321 文件、2800 通过、14 跳过、0 失败**。主工程与界面 TypeScript、新改代码 lint 通过。首轮2799通过/1失败来自R147后遗留的源码字符串断言（AppId现为统一变量），已同步检查进程和窗口共用AppId；定向及最终完整回归通过，不把初轮失败抹掉。
- 正式安装器实际 **beta.3→0.1.0 安装/重复启动/活动状态拒升级卸载/记录和存储标记保留/卸载文件保留32项**通过。独立数据、独立程序目录，用户运行中的 beta.3 EXE 与数据保持；安装验收临时使用的应用卸载登记已按完整原值还原。测试卸载后发现原快捷方式缺失，已按原 beta.3 安装目录恢复桌面、主程序、手册和卸载4个入口，并校回正确图标和AppId。
- 最终镜像 CLI 生命周期 **34项**、实际原生 EXE/Shell快捷方式/窗口HICON/任务栏属性 **7项**通过，正常停机退出0，0模型调用；与首个正式镜像660个有效载荷文件字节一致（最终源码仅同步测试断言），最终安装包仍再次完成升级验证。
- 待公开范围的 Gitleaks 8.30.1 扫描0告警，新增提交作者/提交者均为 GitHub noreply 地址；没有凭据、数据库、个人 CLI 配置或未跟踪R130/R131审计文件入包或入提交。原工作区已快进到发布源码，额外本机续工文字保留为未提交修改；选择性备份保留在 ignored `dist/release-workspace-backup` 及本机 stash，不上传。

证据在独立发布 worktree 的 `dist/release-audit/`：`full-final.json`、`final-gates.json`、`final-payload.json`、`gitleaks-final.json`、`upload-verified.json`、`public-release.json`。最终安装报告 `dist/release-install/aede704a-796d-45bd-8bd9-07dad870d3be`；CLI报告 `dist/r146-package/76d7b4a0-8cf4-40df-9bc6-187e8deade39`；原生报告在主目录 `dist/release-0.1.0-ui/28a19a08-d98c-4086-97a4-bd2c02b661b1`。全部 ignored，不随发布。
