# R66 桌面前端逐项矩阵（2026-10-06）

对象：`desktop-daily-win-v4`（BUILD `bld_bfeb48c4bb82b07b`，源码 commit `6536301`，dirty=false，清单 591/591）。
输入：`desktop-daily-v3-user-feedback-20261006.md`（八项反馈+文件-only 决定）、`review-r65-preview-and-parity-next-round-20261006.md`、独立反例 `dist/desktop/review-r65-feedback-audit-20261006/`。
验证产物：交互门 `dist/desktop/parity-r66-r66-*/result.json`（ok:true）；视觉门 `dist/desktop/visual-gate-r66/`（10 组成对+vision 复核）；升级演练 `dist/desktop/upgrade-drill-r66-*/result.json`（ok:true）；包级 `verify-desktop-daily-r63 --src v4`（ok:true）；全量 899/899+双 typecheck 0 错。

## A. 用户八项反馈逐项收口

| # | 反馈 | 处置 | 状态 |
| --- | --- | --- | --- |
| 1 | 搜索组件丑、全软件统一 | LibraryPage/Members/Activity/Pending/Board/Archive 统一 `.page-filters`+`.select`+`.input`+seg+EmptyState+card；带图标搜索框 | 已还原（s2/s3/s8 成对图） |
| 2 | 点「项目」白屏+形态不对 | 根因=ProjectMenu 内联 filter selector 违反快照稳定（全库唯一处）→useMemo 修；TitleBarBoundary（标题栏降级最小控制条）+MenuBoundary（菜单自隔离）；入口还原原型「项目管理 · [分支] · 项目名 ▾」+后台任务真实计数 | 已修（G1：root/titlebar 存活、零 console 错误） |
| 3 | 成员管理界面不对 | 原型卡片 grid+筛选行+配置 runtime 弹窗；runtime 四态+**有效来源**（未绑定→全局默认 ZS_RUNTIME 如实分列）；房间名单/说明保留 | 已还原（s2 成对图；G8） |
| 4 | 恢复弹窗几分钟后突现 | 三态分类：启动已有（一次自动开）/运行中新失败（就地 toast+侧栏标记，不弹遮挡）/普通排队（中性分节，非故障）；30s 轮询保持 | 已修（G7：真实 stall+pending 证明「普通排队」、无误弹/误标） |
| 5 | 右上角导出=会话导出混淆 | 收进 DM 头部 ⋯ 菜单，命名「导出会话记录（MD/HTML/DOCX）…」；单文件保存移预览「下载原文件/另存为」 | 已修（G6：菜单项+exports 真实产出） |
| 6 | 不能只发文件 | UI+命令层打通：空正文+就绪附件可发（默认 AI；仅记录零任务）；任务标题=📎 文件名；真正空白仍拒；图片门空正文→EMPTY_MODEL_INPUT 双端拒绝 | 已修（G4+fileOnlySubmit 5/5） |
| 7 | HTML 浏览显示原文 | HTML 默认隔离页面预览：sandbox="" iframe+注入 CSP（default-src 'none'）+base target=_blank——脚本禁用/不联网；说明行如实 | 已修（G3：srcdoc/CSP/base/sandbox 断言；s5 成对图） |
| 8 | 像文件阅读器一样浏览 | MD 默认排版阅读（h1/表格/列表/加粗）、源码可切换且>64KB 尾部可达（readFull 全文=与 64KB 模型提取窗分列）；预览内「下载原文件」（originalFile sha256 对账+主进程另存为窄桥） | 已修（G2/G3+s4 成对图） |

## B. R66 范围逐项

| 项 | 状态 |
| --- | --- |
| P1 白屏根因+同类 selector 全量扫描（唯一处）+标题栏/portal 故障隔离 | 已修已验 |
| P2 MD/HTML/源码阅读切换进入实际组件分支；完整文件 vs 提取窗分列；技术说明入「文件信息」 | 已修已验 |
| P2 DM 布局原型 320/440/480 降级（收列表→单区切换；Esc/隐藏区保留状态沿用组件合同） | 已还原已验（宽 596px≥480；900px 单区零溢出，输入区切「对话」可达） |
| P3 文件-only UI+服务端合同（body 可空+superRefine；标题推导；dm 标题）；未知信封**完整意图身份**比较（正文+意图+@+附件集合——文件-only body 皆空不再误判） | 已修已验 |
| P3 图片门空正文分支（服务端 EMPTY_MODEL_INPUT+UI 前置拦截）；图片能力门/版本/hash/范围/出站账本/同号重试/预算合同保持 | 已修已验（负对照） |
| P4 统一筛选/下拉/菜单（六页）；成员页原型化；搜索收藏原型化（tabs+筛选行+真实 search.query） | 已还原已验（s2/s3/s8/s9） |
| P4 活动/待我处理原型外壳（分节/seg/EmptyState）；归档管理页+路由+设置嵌入（恢复=真实命令；此前误标「未接入」已纠正） | 已还原已验（s9） |
| P5 会话导出收菜单；下载原文件（attachment.originalFile+zs:saveAs 窄桥：路径由用户选/renderer 不可指定/64MB 上限/sender 白名单） | 已修已验（hash 对账；桥存在性；不触真实对话框） |
| P5 恢复三态；runtime 有效来源（member.runtime.effective：binding/global-default/unresolved） | 已修已验 |
| P5 startupFailed 只读诊断：不读 payload/不重放——以 effective 来源+事件时序呈现（用户数据零接触；恢复动作仍由用户显式发起） | 已按只读边界完成 |
| 迁移 | **047=补 navigation_preferences.pinned_project_ids_json**（R65 遗留真实缺陷：navigation.get 引用列缺失→applyServerNavPrefs 恒失败→重开侧栏空；冻结 001–046 未动） |
| persistNav 空可见集不落服务端（防首启零项目毒化偏好） | 已修已验（diag 定位→047 后装载正常） |
| v3→v4 升级演练（用户真实数据根全量副本） | 46→47+pre-v46 备份+事实逐项一致+blob hash 全对；再开稳定零额外备份；旧包直开升级库被版本门拒；备份恢复后旧包可开；**用户原根前后 hash 不变** |
| desktop-daily-win-v4 | bld_bfeb48c4bb82b07b/591/591/dirty=false；launcher 验证 ok（绑定弹窗形态更新后） |

## C. 真实能力限制与延期（如实）

- HTML 交互网页（脚本/表单）暂不支持——静态隔离预览如实说明，不退回整页源码。
- 搜索范围=当前项目/全部可访问项目（服务端无「侧栏可见集」检索范围命令，不虚构第三档）。
- 「添加成员」按钮不设（member.create 属 DEV-10 后续）——不放假成功入口；成员页给出如实话术。
- 图片 OCR/模型图片输入未认证：能力门语义保持（仅发送文字/仅记录）。
- 视觉门数据密度：正式侧为夹具单项目（manifest 已逐场景标注 approvedDiffs）；原型 s5 无 HTML 通道（用户批准新增能力，正式侧独有）。
- 既有延期不重开：Android、安装器/签名/自动更新、价值评价、DEV-11、并行写入、G5。
- 矩阵 F 其余页（活动流无原型对应页——保持 R55 真实实现+R66 统一外壳）。
