# R113：公开 main 的 V56 Windows 测试包

用户要求生成当前版本供实机测试。本轮从公开 main 的 `387c037825f451ea3eee5ac013f09db1bdf790da` 重新构建程序，保留现有功能与并发调度方式。

## 产物

- 目录：`dist/desktop/desktop-daily-win-v56-r113-public-main-20261027/`。
- BUILD：`bld_8e8a703bde78686e`，源码工作区 clean，`dirty=false`。
- 通用压缩包：`dist/desktop/zhongshuo-v56-windows-x64-20261027.zip`，220629960 字节，644 个文件。
- ZIP SHA-256：`0d27f5e3599a170a0b17b9c2a82c9943bfed044b3cd3012d7eaea98f0a484d0b`，同目录附 `.zip.sha256`。
- 通用包附简短启动说明、MIT 许可证、第三方许可证与14章17图操作手册。通用 ZIP 没有聊天数据库、账号资料、本机数据目录和专用启动器。

本机交付目录另附与上一包逐字节相同的 `start-existing-data.bat/.vbs` 和简短升级说明，供当前用户退出旧版后沿用原数据。它们在生成通用 ZIP 后才加入，仅保存在 ignored 交付目录；没有实际启动或搬迁用户原数据。

## 检查

- 重新计算全部613个程序文件的SHA-256，与随包清单一致。
- 压缩包完整解码CRC检查通过，文件数一致。
- 包内与离线手册正文一致，17张图片各自存在；设置中独立手册入口加载14章17图，图片全部成功加载，手册页没有应用操作桥。
- 隔离启动实际随包main/preload/renderer与随包Node/daemon，正常关窗退出码0，daemon.pid移除；测试库0个模型执行轮次、0次真实模型调用。
- Electron验证宿主与随包electron.exe逐字节一致。已查看实际设置手册截图。
- 前一轮同一源码的排队、任务隔离、跨项目调度及Codex通知归属共4文件54项模拟测试通过。本轮打包未改执行代码，不重跑已通过的源码套件。

本次验证证据保存在 ignored `dist/r113-package-review/`。首轮构建的根目录日志被计入dirty，移入dist后重新clean构建；首次UI辅助验证将外部wrapper传给已装配的便携exe，被其应用入口忽略后超时，未产生模型调用，进程查询确认该测试daemon已退出。随后使用字节相同的Electron宿主加载随包入口，完整检查通过。辅助验证的原始结果保留。
