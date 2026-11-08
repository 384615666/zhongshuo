# R197 图片气泡 / 图片路径 / 右键复制 / 通知图标

用户 2026-11-08 基于已安装 beta.41 发来截图反馈五项：

1. 图片气泡上方空出一大截（「你修改前端的东西你自己截图看一下你自己做得对吗？」——本版所有界面结论都用隔离 Electron 真实截图核对，见证据目录）；
2. 引用只能引文字，图片不能引用：引用内容含图片时把图片绝对路径附上；
3. 复制带图片的消息只复制图片名称：要复制图片绝对路径；
4. 众说的消息提示图标是一个黑图；
5. 图片右键不能复制，要求增加复制功能。

口径：只改界面/显示与只读路径获取；不改 schema（保持 61）、权限分级、audience、图片能力门与消息/任务合同；不迁移用户数据。

## 1. 图片-only 气泡贴合

- `MessageView` 对「本人消息 + 正文为空 + 有图片附件」输出 `data-zs-image-only="1"`；新样式把该气泡内边距 10/14px 收紧为 4px，图片网格与附件区的多余上间距归零（含对 `.msg-list.is-replies .msg-human-bubble` 高特异性覆盖）。
- 实测（隔离截图，1360×900）：气泡 228×234、图片 220×220，气泡内边距 4px、图片顶距气泡顶 5px（修复前为 10px 内边距 + 8px 网格上间距 + 9px 附件区间距 ≈ 27px 空隙感）；对话串与私信两种容器均验证。
- 带文字的消息、AI 消息、纯文件消息样式不变。

## 2. 引用带图片绝对路径

- 对话串、私信、房间主池三处的「引用」在生成引用文本时调用新 lib `imageAttachmentPaths.ts`：收集消息图片附件（正式附件 + 文件变更里带 artifactId 的图片，按 id 去重）；项目内图片用 `sourcePath` 经 `absoluteProjectPath` 拼出真实绝对路径；上传图片调新增只读命令 `attachment.absolutePath` 取路径。选中文字优先，图片路径始终追加；取不到路径时只写文件名，不伪造。
- 引用文本格式：`[图片] 文件名` 换行 `绝对路径`，多项之间空行。
- 实测：引用图片-only 消息后，引用卡显示 `[图片] 猫猫图片.png` 与 `…\attachment-paths\5f32d9fa56968b2a-猫猫图片.png`，路径文件真实存在。

## 3. 复制带图片绝对路径

- `MessageView.copyMessage` 与房间主池 `RootCardActions.copy` 都改为「正文 + 非图片附件名 + 图片段」，复制结果不再只有图片名称；复制按钮原有的「已复制/复制失败」反馈保留。
- 实测：消息复制到剪贴板为 `[图片] 猫猫图片.png\r\nD:\...\attachment-paths\5f32d9fa56968b2a-猫猫图片.png`；房间主池复制同样带路径；两条路径均在磁盘上真实存在。

## 4. Windows 通知图标黑块

- 根因（已复现）：`scripts/lib/brand-icon.ps1` 把 ICO 的 7 个尺寸帧全部写成 **PNG 压缩帧**；Windows 通知身份图标（AUMID 注册的 `IconUri`）与经典图标 API（`System.Drawing.Icon` 走同一 GDI 路径）按传统 DIB 解析，把 PNG 字节当位图数据 → 彩色噪点/黑块；Electron/Chromium 能解 PNG 帧，所以通知正文里的品牌小图正常。
- 修复：`brand-icon.ps1` 改为传统 BMP/DIB 帧（BITMAPINFOHEADER 40 字节、biHeight=2×size、32bpp BGRA 自下而上 XOR、1bpp AND 掩码 4 字节对齐），ICONDIR 契约（7 帧/type=1/256 写 0/planes=1/bitCount=32）与 base64 输出不变；新增 `scripts/verify-brand-icon-r197.cjs` 做结构、System.Drawing 像素、Electron nativeImage 三层验证。
- 实测：`verify-brand-icon-r197.cjs` **145 项通过**——7 帧前缀 `28000000`、非 PNG、System.Drawing 取 32×32 与 logo 参考图 mean/max/alpha 距离 **0/0/0**、提取 PNG 与参考 sha256 相同、nativeImage `isEmpty=false`/256×256；修复前 PNG-in-ICO 对照 mean 59.4652 / max 220.3333（噪点图存证）；`build-ui`+`pack-daemon`+`pack-desktop` 通过，包内 ICO 与生成字节一致、`brandWindowsExecutable` 复核 `Frames=7/Verified=true`，产物 EXE 关联图标 32×32 与 logo 距离 0。
- 边界：本机未安装，**未实机观察 toast**；Windows 通知/AUMID 图标缓存可能在升级后仍需刷新（图标文件名因内容哈希变化会改变路径，有助于缓存失效，但不能保证立即刷新）。

## 5. 图片右键复制

- 消息内图片（单图/多图缩略图）右键 → 共享 `Menu` 两项：**复制图片**（`data-zs-copy-image`）、**复制图片路径**（`data-zs-copy-image-path`），容器 `data-zs-image-menu`；复制图片优先页面已加载的 data URL，否则向 daemon 取预览；先走 preload 图片剪贴板桥，失败回退 canvas + 浏览器剪贴板，再失败中文 toast。
- 共享预览大图右键 → **复制图片** / **另存原件**（`data-zs-preview-image-menu` / `data-zs-copy-image` / `data-zs-copy-image-download`）；工具栏与菜单内部右键不接管，右键不进入拖动/指针捕获。
- 新桥：`main` 的 `zs:clipboard.copyImage` 做可信来源、`data:image/` 前缀、24MB 上限与 `nativeImage` 解码校验，写入系统剪贴板；preload 暴露 `window.zsClipboard.copyImage(dataUrl)`。本机 Electron 44 的剪贴板走 W3C 异步 `clipboard.write([ClipboardItem])`（旧 `writeImage` 已移除），按实际 API 实现。
- 实测：消息图片右键菜单出现并复制后，系统剪贴板含 1.27MB `image/png`；预览右键同样；右键复制图片路径写到剪贴板且文件存在。

## 6. 图片绝对路径命令（新）

- `attachment.absolutePath`：`{attachmentId, conversationId?}` → `{attachmentId, filename, mime, path, bytes}`；audience 与 `previewImage` 完全一致、仅 `image_file`、远程通道 FORBIDDEN；在 `{appData}/attachment-paths/` 生成 `{hash前16位}-{安全化原名≤40}.{ext}` 的**真实副本**（不是硬链：按路径改写图片不会影响内容寻址的托管原件），同名同大小复用；路径必须落在 appData 内。
- 集成测试 `tests/integration/imageAttachmentPathR197.test.ts` 6 项：路径与字节等于原件、重复调用同路径、非图片拒绝、跨会话/越权拒绝、不存在附件拒绝、中文与非法字符安全化。

## 验证与证据

- 隔离 Electron 截图/验收脚本 `scripts/capture-r197-ui.cjs`（隔离数据 + 假运行时 + 真实 daemon）**23/23 断言通过**；三阶段截图 `dist/r197-ui/r197-verify7/`：`01-thread-image-only.png`（图片-only 气泡，5px 顶部距离）、`03-image-context-menu.png`（图片右键菜单）、`04b-quote-dock.png`（引用卡带 `[图片]` 与绝对路径）、`05-preview-image-menu.png`（预览右键菜单在可视层最上方）、`06-room-card-copy.png`；`preview-menu-diag.json`、`icon-checks.json` 同目录。
  - 说明：截图 harness 需要关闭 CSS 动画（隐藏窗口里动画停在首帧会拍到 opacity 0），本轮把注入样式改为 `animation:none`；这不改产品样式。
- 大套件：380 文件请求/379 执行，**377 通过 / 2 跳过；3393 通过 / 3 预期失败 / 16 跳过 / 0 失败**（`--maxWorkers=4`，约 236 秒；排除默认禁用的 GitHub 远端沙箱与 Word COM 验收）。
- hifi tsc 0；根 tsc 维持既有 29 条本机未跟踪夹具错误（本版文件 0 新增）；eslint 改动文件无新增；`build-ui` / `pack-daemon` 通过。

## 交付

- 程序提交 `9d797f7`（版本 `0.1.3-beta.42`，numericVersion `0.1.3.42`）。
- 干净 worktree `dist/r197-source`（status 0，`dirty=false`）构建：便携镜像 BUILD `bld_e4675a2e79e5f8fe`（clean、632 文件 MANIFEST 逐项 SHA256）、安装器 BUILD `bld_427e44bbcb9e533a`（安装镜像 668 文件 MANIFEST；payload-audit `files=668`、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。
- 安装包 `dist/installers/Zhongshuo-Setup-0.1.3-beta.42-x64.exe` **160,489,293 字节**，SHA256 `ee47fa06f66ca584e21f889fdc06377f1e8b07971b50ab44ec2ffb26247eb5f5`，未签名，附 `.sha256` / `.release.json`；本记录提交后推送 `main`（`9d797f7` + 记录提交）、创建 tag `v0.1.3-beta.42` 与 GitHub Release「众说 0.1.3-beta.42」（assets：exe + `.sha256` + `.release.json`，正文取 `docs/releases/0.1.3-beta.42.md`）；用户自行安装。
- 未在本机安装/升级/卸载、未操作用户运行数据、未调用真实模型；未实机验证 Windows toast 显示与 >24MB 图片复制降级路径。

## 未验证边界 / 已知取舍

- 通知图标修复是格式层证据（系统经典 API 可读 + PE 校验），未安装看 toast；AUMID 图标缓存可能需要重装或手动刷新。
- 图片路径副本位于应用数据目录、按内容哈希命名；不额外清理（体积与图片原件相同，删除后下次复制/引用会重建）。
- 引用/复制文本里的路径按纯文本/Markdown 呈现，未对反斜杠做额外转义。
- 图片-only 判据=正文为空且有图片附件；若同时带非图片文件，文件 chip 间距也会按 4px 紧凑气泡显示。
