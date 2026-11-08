# R198 Windows 通知图标黑块（真正根因与修复）

用户 2026-11-08 在安装 beta.42 后回复「问题还在」，附通知截图：通知头部仍是黑色方块，正文品牌小图正常。

## 复现与定位（本机对照实测）

beta.42 已把 ICO 的 7 帧从 PNG 压缩帧改为传统 DIB 帧，且验证：系统经典图标 API 取 32×32 与 logo 逐像素一致、PE 图标 `Frames=7/Verified=true`、安装目录快捷方式/注册表 `IconUri`/exe 三处都指向新图标。但用户通知仍黑。

本机做了四组对照（都用 Windows 系统通知，截图只包含本应用通知）：

| 对照 | AUMID 注册表键 | 快捷方式图标 | 通知头部结果 |
| --- | --- | --- | --- |
| A | 无（删掉整键） | exe 图标 | **「众说」+ 品牌图标（正确）** |
| B | 仅 DisplayName，无 IconUri | exe 图标 | 占位字形（不是品牌图标） |
| C | IconUri = exe 路径 | exe 图标 | 不显示图标 |
| D | IconUri = 随包 ICO | 随包 ICO | **黑色方块（用户看到的现象）** |
| E | IconUri = PNG | 随包 ICO | 黑色方块 |

补充：用真实安装版 AUMID `com.zhongshuo.desktop.app` 删除该注册表键后再发系统通知，同一快捷方式/同一 AUMID 下头部正常显示「众说 + 品牌图标」。因此黑块不是图标文件格式问题（beta.42 已证明图标文件正确），而是 **AUMID 注册表键存在时 Toast 平台改用 `IconUri`/注册表显示名**，而该路径在此系统上渲染为黑块/占位字形（ICO、PNG、exe 三种 IconUri 都试过）。

## 修复（beta.43）

- `src/ui/windowsAppIdentity.ts`：用 `windowsNotificationIdentityReset(appId)` 取代原来的 `windowsIdentityRegistration(appId, icon)`，只生成 `reg delete HKCU\Software\Classes\AppUserModelId\<本应用 AUMID> /f`；AUMID 必须是 `com.zhongshuo.*`。
- `src/ui/main.ts`：安装版启动时调用该重置（键不存在时 reg delete 失败静默忽略，不影响启动）；不再写 DisplayName/IconUri。
- `packaging/windows/zhongshuo.iss`：删除 [Registry] 中的 DisplayName/IconUri 两条写入；快捷方式仍带 `AppUserModelID` 与品牌图标，通知名称/图标由「众说」快捷方式提供（对照 A 已验证）。
- 通知正文品牌图（Electron Notification icon）、通知点击激活、任务通知逻辑与权限不变。

## 验证

- 本机对照截图证据：`dist/r198-before-black.png`（键存在 → 黑块）与 `dist/r198-after-logo.png`（键删除、同一真实 AUMID → 众说 + 品牌图标），均为系统通知截图的裁剪，ignored。
- `tests/unit/windowsIdentityR163.test.ts` 更新：只删本应用 scoped 键、非法 AUMID 拒绝、main 不再写 AUMID DisplayName/IconUri；安装器快捷方式 AUMID 断言保留。定向 3 文件 15 项通过。
- hifi tsc 0；根 tsc 29 条既有本机未跟踪夹具错误（本版 0 新增）。
- 全量套件与干净 worktree 构建/打包复验见交付记录；本机未安装，未在安装版上实测升级后的第一条通知。

## 交付

- 版本 `0.1.3-beta.43`（numericVersion `0.1.3.43`），程序提交 `5a095d7`。
- 干净 worktree `dist/r198-source` 构建：便携镜像 BUILD `bld_78d3bb1f94d5ef83`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_4963e33c797e994d`（安装镜像 668 文件 MANIFEST；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.43-x64.exe` **160,491,524 字节**，SHA256 `b0c2d0aa4e20e8ace178ac336945c212bf8999d43d1b71b6f9aa87c8beac7013`，未签名；本记录提交后推送 `main`（`5a095d7` + 记录提交）、创建 tag `v0.1.3-beta.43` 与 GitHub Release「众说 0.1.3-beta.43」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.43.md`）；用户自行安装。
- 未在本机安装/升级/卸载、未操作用户数据、未调用真实模型。升级后启动一次应用即删除旧注册表键，之后通知图标来自「众说」快捷方式。

## 已知边界

- 通知头部名称改为由快捷方式文件名提供（「众说」），不再是注册表 DisplayName；本机实测显示一致。
- 若用户手动固定到任务栏的快捷方式在桌面/开始菜单被删，通知图标可能退回系统默认——属 Windows 侧行为。
- 旧的「Electron.lnk」清理（R158/R162）逻辑保留；不再重建 AUMID 注册表键。
