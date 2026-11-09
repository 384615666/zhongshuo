# R212：运行时修复合并发布 1.0.2

用户明确要求打包发版更新安装包。本轮将 R210 Harness 安装入口修复和 R211 Claude 代理、安装完整性检测合并为 1.0.2，Windows 文件版本 1.0.2.65535；数据 schema 保持 61。操作手册版本行同步，首页和 README 不在本轮改动范围。

仅制作 Windows 安装包及 SHA256、版本元数据。现有内部装配镜像仅用于安装器构建，不单独发行或开展便携版验收。用户自行安装；本轮不安装/升级/卸载任何用户程序、不修改系统代理、第三方 CLI 配置或用户运行数据。

## 发布前验证

- R210/R211 合并定向 18 文件、208 项通过；版本测试另 3 项通过。
- 默认完整套件首轮覆盖 388 文件、3488 项：3458 正常通过、3 预期失败、15 跳过、12 失败。四个旧夹具文件依赖本机 CLI，改用本地引用/状态夹具；两个测试缺少开发命令入口，恢复本地 bin；两条时序相关用例单独通过。最终对所有失败涉及的 7 个文件补跑 49/49，通过集合替换首轮对应文件后没有未收口失败。不是单次全量全绿；原始 `dist/r212/full-tests.json`、补跑 `final-rechecks.json`、合并 `combined-regression.json` 均保留。
- 根/hifi 类型检查、本轮文件 lint 与 diff whitespace 检查通过；Inno 模板编译通过。
- 发布使用干净源码构建，依赖及编译器只恢复到仓库 ignored 的开发工具目录，不执行用户应用安装。SheetJS 0.20.3 归档 SHA512 与锁文件完全一致。
- 本机 Claude CLI 默认 npm 入口仍缺少原生程序；此次众说更新提供正确识别和提示，不将该第三方安装问题宣称已修复。

## 构建与交付

- 源码提交：`f2f76da`（R210/R211 与版本准备）、`3344950`（旧测试夹具隔离）、`ceccd48`（原生平台包落地复制），最终代码提交 `ceccd48ca88cf0f4123d1870c92047cf1f1184af`。
- 构建采用同盘干净 worktree `dist/r212-source`，避免跨盘依赖被 esbuild 写为绝对开发路径。此前 C 盘构建被隐私门禁拒绝，未交付。
- 旧 Node 24.14.0 在本机 Unicode 目标目录的递归复制出现静默漏拷贝，使用 bundled Node 24.22.1 重试；随包许可证取官方同版本 LICENSE。Windows 下平台包的嵌套 junction 改为先 realpath 再逐包复制，最终载荷不含 junction。构建中所有失败候选均保留日志，不作为交付物。
- 内部装配 BUILD `bld_f7484fd5f358c59e`（clean、633 文件）；安装器 BUILD `bld_45eb936fc249956a`（clean、670 文件）。清单逐项长度/SHA256 通过，`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`。
- 安装镜像内的 Node、setup `--plan`、后台 IPC、Claude 代理保留与占位诊断、配置模型保留、拒绝绕代理直连、Harness/Pi 缺失入口、零模型账目与正常退出等 **21/21** 通过。测试使用独立数据目录、合成配置及本地假入口；未运行安装器，不冒充已安装程序验收。
- 安装包 `dist/installers/Zhongshuo-Setup-1.0.2-x64.exe`：**160,976,533 字节**；SHA256 `662d4e4b5f3fe32df9b319d522b2353239b59fe5602709c53b60fe8665a90a0a`，未签名。附 `.exe.sha256`、`.release.json`，文件资源版本 1.0.2。
- 源码三提交和 tag `v1.0.2` 已推送公开仓库；tag 指向 `ceccd48ca88cf0f4123d1870c92047cf1f1184af`。GitHub Release「众说 1.0.2」已发布（draft=false、prerelease=false、Latest=true）：https://github.com/384615666/zhongshuo/releases/tag/v1.0.2 。
- exe、`.exe.sha256`、`.release.json` 三项已上传，服务端 digest 与字节数逐一匹配本地文件；发布后匿名 API 再核对三条公开资产 URL，安装包公开 HEAD 为 302→200、Content-Length=160976533。
- 发布通过临时 bare 仓库直连 GitHub，保留原仓库 URL rewrite；未将 GitHub 凭据配置给第三方镜像。TLS 验证未关闭，系统代理与用户应用配置未修改。
- 发布证据：ignored 的 `dist/r212/public-release.json`、`uploaded-assets.json`、`public-download-headers.txt`、`delivery-verification.json`、`payload-verification.json` 与构建/测试原始日志。内部装配镜像仅为安装器中间产物，未单独发行或验收便携版。
