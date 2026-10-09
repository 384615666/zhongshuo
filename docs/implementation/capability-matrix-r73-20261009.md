# 能力矩阵 R73（2026-10-09）——页面切换、预览布局与导航取消

> 基线：`capability-matrix-r72-20261008.md`。本轮差异：文件页→房间自动收起、预览真分隔条、真放大、导航意图取消、PPT 页级 render-ready。
> 交付：`desktop-daily-win-v11`（bld_87d8fd4ec1c6283c / ed39838 / 593/593）。

## A. 预览与页面切换（本轮新增/修复）

| 能力 | 实现 | 工程验证（r73 门/启动器复证） | 边界 |
| --- | --- | --- | --- |
| 文件页→房间自动收起 | hidden+explicitShow（两处 openPreview 统一；effect 含 s.resources） | G1：真实侧栏点击、草稿/标签/阅读位置保留、重开标签=1、不乒乓、在途不回弹；启动器复证 ✓ | 触屏未测 |
| L3/L4 真分隔条拖动 | usePreviewWidth（380 下限/双击复位/不棘轮） | G2：边界贴合±4、双向 rect 变化、最小宽、940px 降级无双线程/多输入条/裁剪；启动器 608→460 ✓ | 触摸板未测 |
| 真放大/还原 | paneCls 消费 maximized（frameless !important 压回）；Esc（弹层优先） | G3：rect 铺满工作区、菜单 Esc 优先、Esc/按钮还原±8、sheet 保持；DM/文件页共用 ✓（启动器） | — |
| 导航意图取消 | lib/navIntent 登记簿+定位链 intent 贯穿 | G4：B 保持/零偏好写入/无旧错误/不重试；未取消正例/冷房间/最新 tab 全过 | 触屏/多窗未测 |
| PPT 页级 render-ready | RenderedSlide data-zs-render（页+代次绑定） | G5：82/82 ready、0 失败（页级完整记录） | 非像素级对照 |

## B. 既有能力回归（必要项，不重跑历史清单）

| 项 | r73 门 |
| --- | --- |
| 文件树 20–32MiB 真件（R72 P1） | G6：82 页 |
| 阅读位置/页码保持（R70/R72） | G6：切 XLSX 回 PPT 页码 40 |
| 另存原字节（R72） | G6：sha256 一致 |
| XLSX 69913 行滚动（R72） | G6：aria+bottom scrollTop |
| Git 中性→仓库往返（R72 P2） | G6：neutral→repo |
| r72 门整体回归 | ok:true errs=[]（realCalls 6×0） |

## C. 交付形态

| 项 | 结果 |
| --- | --- |
| v11 清单 | 593/593（bld_87d8fd4ec1c6283c / ed39838 / dirty=false） |
| r63 --src v11 | ok:true，realCalls=0 |
| 启动器发布协议复证（三项反馈修复） | ok:true（自动收起/拖动 608→460/放大铺满+Esc；console 0；realCalls 0） |
| 源码形态 | 全量 921/921；typecheck 0/0 |

## D. 边界（如实）

- XLSX 上传主进程 15s 超时环境抖动（门内重传吸收，take-10 干净）；如再复现按独立反例。
- 触屏/触摸板拖动、<940px 分隔条细分、逐页像素级对照未覆盖（沿用 R72 登记）。
- 既有延期（Android/签名/价值评价/DEV-11/并行写入/G5）不动。
