# 众说功能分批与发布依赖 v1.23

2026-09-26。C8/R10 设计交付。逐项映射主设计 §27 的 **137 项**，完整需求不删除；“首版子集”与完整对标范围分开，未列首版子集的功能全部保留在 FULL。不是完成度报告，所有正式工程能力均须按工作包另验收。M3 即 v0.1。

## 工作包与先后

原 DEV-01—20 沿主设计 §20.1；新增如下，不新开多包 workspace。

| 包 | 批次 | 前置 | 交付与验收 |
|---|---|---|---|
| DEV-21 | M0/M1/M2/M3 分段 | DEV-01/03/06，M1 依 DEV-08，AUTO 依 DEV-11 | 模板、输出 schema、注入/恢复；PP-01—12 |
| DEV-22 | M3 | DEV-02/05/06/17/21-M3；UI 依 DEV-14 | DM 后台执行、历史/附件 audience、停止重启；DM-BASE-01—08 |
| DEV-23 | M3 | DEV-02/05/13/17/21-M3；DM 提醒依 DEV-22 | 提醒/通知、跟进与 occurrence 恢复；REM、FOLLOW |
| DEV-24 | M3 | DEV-04/17/19；DM 资源依 DEV-22 | 七类附件、评论、导出、共享预览；WPV-01—36 |
| DEV-25 | M3 | DEV-05/13/14/17；远程 DM 依 DEV-22 | 本机/LAN 浏览器、配对/吊销、HTTPS/WSS；RT-21/LAN-01—08 |
| FULL-11 | v0.1 后 | M3 命令面、DEV-25/RT-21；外部成员依 FULL-06 | MCP 12 工具、认证/版本/审计；RT-28 |

M0：DEV-01 → DEV-02/03 → DEV-04/05 → DEV-06 → DEV-07/17/21-M0，G3 真实闭环。M1：DEV-08/09/21-M1 + G4 价值对比。M2：DEV-10/11/12/21-M2（改文件保持单写者）。M3：DEV-13/14/18/19 → DEV-21-M3/22 → DEV-23/24/25 → DEV-15 → DEV-16。依赖可满足时分模块施工，跨包 schema 先固定。DEV-20 完整加固后续，B6 原生限制不能后置。

DEV-16 的前置改为 DEV-10—15、DEV-17—19、DEV-21—25 和 G2/G3/G4；M3 六项必须齐备。DEV-15 必须在最后新增 native/解析依赖后重验安装包，不能复用更早空壳打包结果。

## 附件四能力与导出

各格式独立标 保存/预览/提取正文/交给模型。任何一种未实现不得以“可上传”冒充全部支持。

| 格式 | 保存 | 预览 | 提取正文 | 交给模型 |
|---|---|---|---|---|
| 文本/代码/Markdown | hash/版本副本 | 转义文本/安全 Markdown | 编码与大小限制后文本 | 通过 audience/context grant 注入 |
| 图片 | 原件 | 解码像素、限尺寸 | OCR 为可选能力，未实现标不可用 | 仅认证支持图片的 runtime，不能拿路径冒充已读 |
| PDF | 原件 | 隔离渲染页 | 提取文本；扫描件 OCR 单列 | 受限文本或已支持的页图 |
| DOCX | 原件 | 安全转换/排版预览 | 有序段落与表格 | 提取文本，标明版式损失 |
| XLSX/CSV | 原件 | 分页表格 | sheet/单元格范围 | 选区+范围/截断标记，不执行公式/宏 |
| PPTX | 原件 | 幻灯片预览 | 按页文字与备注范围 | 页文本/图片依能力 |
| 音视频 | 原件 | 浏览器受支持格式播放；不支持明确说明 | 转录单列，未实现禁用 | 仅经认证的输入形式；无转录不能谎称已理解 |

HTML 附件禁止脚本与网络访问，以受限 sandbox 预览；未知/可执行格式只保存/下载不运行。源码目录与附件副本分开；导出 Markdown、HTML、Word（DOCX）由 DEV-24 交付，导出同样过滤 audience，HTML 静态化、资源本地打包，Word 需实际打开检查。文本/代码/Markdown 评论锚点首版；PDF/表格/视频等其余锚点依 FULL-03，不删除完整需求。

## 逐项分批表

验收列中的 G0—G5、DM-BASE/MCP-BASE/FOLLOW/LATE/E11/LAN 见 development-baseline-v1.23.md；AT/RT/TH/ALL/WPV/PP 沿现有规范。每项 ALL 验收必须对照 §27 本行完整描述，FULL 完成不能只跑首版子集。

| ID | 功能 | 首版批次 / 包 | 首版子集 | 完整范围包 | 前置 / 后置原因 | 验收 |
|---|---|---|---|---|---|---|
| START-01 | 创建与引导 | M0 / DEV-04/07 | 本机项目文件夹、默认房间与稳定身份 | FULL-01 | DEV-17/18/14 | G3/TH；ALL-START-01（本表逐项索引） |
| START-02 | 引导 Agent | M3 / DEV-14 | 可关闭的本机引导；不新增隐式模型调用 | FULL-01 | DEV-17/18/14 | ALL/G5；ALL-START-02（本表逐项索引） |
| START-03 | 真实任务闭环 | M0 / DEV-01/07/17 | 默认发送/仅记录、线程与目标隔离 | FULL-01 | DEV-17/18/14 | G0/G3/TH；ALL-START-03（本表逐项索引） |
| START-04 | 团队组建 | M0 / DEV-04/06/07 | 项目内成员配置与持久 ID；多人邀请后续 | FULL-01 | DEV-17/18/14 | G3/RT-23；ALL-START-04（本表逐项索引） |
| START-05 | 人类加入 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-START-05（本表逐项索引） |
| START-06 | 浏览器与手机 | M3 / DEV-25 | 本机与局域网浏览器；移动 PWA/push 后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT-21/LAN；ALL-START-06（本表逐项索引） |
| START-07 | 教程场景 | M3 / DEV-14/15 | 首版场景帮助与故障说明 | FULL-01 | DEV-17/18/14 | G5；ALL-START-07（本表逐项索引） |
| START-08 | 循环工作模板 | M3 / DEV-23 | 有界提醒/模板；复杂自动化扩展后续 | FULL-01 | DEV-17/18/14 | REM/G5；ALL-START-08（本表逐项索引） |
| START-09 | 可读帮助文档 | M3 / DEV-14/15 | 首版场景帮助与故障说明 | FULL-01 | DEV-17/18/14 | G5；ALL-START-09（本表逐项索引） |
| SPACE-01 | 空间创建与切换 | M0 / DEV-04/07 | 本机项目文件夹、默认房间与稳定身份 | FULL-01 | DEV-17/18/14 | G3/TH；ALL-SPACE-01（本表逐项索引） |
| SPACE-02 | 完整导航 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-SPACE-02（本表逐项索引） |
| SPACE-03 | 空间资料 | M0 / DEV-04/07 | 本机项目文件夹、默认房间与稳定身份 | FULL-01 | DEV-17/18/14 | G3/TH；ALL-SPACE-03（本表逐项索引） |
| SPACE-04 | 管理设置 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-SPACE-04（本表逐项索引） |
| SPACE-05 | 加入协议 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-SPACE-05（本表逐项索引） |
| SPACE-06 | 空间删除 | M3 / DEV-04/14 | 归档/恢复/明确删除应用记录；不删项目源码 | FULL-01 | DEV-17/18/14 | RT/G5；ALL-SPACE-06（本表逐项索引） |
| SPACE-07 | 套餐与计费入口 | v0.1 后 | 无首版子集，完整保留 | FULL-10 | 商业及账号数据策略待定 | ALL-SPACE-07（本表逐项索引） |
| SPACE-08 | 空间信息接口 | M3 / DEV-14 | 本地可授权项目/成员查询；MCP 映射 FULL-11 | FULL-01 | DEV-17/18/14 | MCP-BASE/G5；ALL-SPACE-08（本表逐项索引） |
| MEM-01 | 成员列表与详情 | M3 / DEV-14/18 | 成员详情、消息入口；Apps 等随所属 FULL | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT-26/G5；ALL-MEM-01（本表逐项索引） |
| MEM-02 | 服务器角色 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-MEM-02（本表逐项索引） |
| MEM-03 | 邀请和移除 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-MEM-03（本表逐项索引） |
| MEM-04 | 账号与成员分离 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-MEM-04（本表逐项索引） |
| MEM-05 | 个人资料 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-MEM-05（本表逐项索引） |
| MEM-06 | 账号删除路径 | v0.1 后 | 无首版子集，完整保留 | FULL-10 | 商业及账号数据策略待定 | ALL-MEM-06（本表逐项索引） |
| MEM-07 | Agent 管理权限与操作卡 | M3 / DEV-14 | Agent 提案由人处理，不自助扩权；完整角色后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | E11/G5；ALL-MEM-07（本表逐项索引） |
| HOST-01 | 连接执行机 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-HOST-01（本表逐项索引） |
| HOST-02 | 执行机详情 | M3 / DEV-13/14/15 | 本机状态/停止/卸载保留数据/Windows；多机后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT/G5；ALL-HOST-02（本表逐项索引） |
| HOST-03 | 本地服务职责 | M0 / DEV-05/06/17 | 本机进程、停止与运行状态；完整生命周期 M3 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT-07/G3；ALL-HOST-03（本表逐项索引） |
| HOST-04 | 多机与恢复 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-HOST-04（本表逐项索引） |
| HOST-05 | 旧服务迁移 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-HOST-05（本表逐项索引） |
| HOST-06 | 断开与删除区分 | M3 / DEV-13/14/15 | 本机状态/停止/卸载保留数据/Windows；多机后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT/G5；ALL-HOST-06（本表逐项索引） |
| HOST-07 | 停止、卸载与清理 | M3 / DEV-13/14/15 | 本机状态/停止/卸载保留数据/Windows；多机后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT/G5；ALL-HOST-07（本表逐项索引） |
| HOST-08 | 平台限制 | M3 / DEV-13/14/15 | 本机状态/停止/卸载保留数据/Windows；多机后续 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | RT/G5；ALL-HOST-08（本表逐项索引） |
| HOST-09 | 迁移能力状态 | v0.1 后 | 无首版子集，完整保留 | FULL-05 | ADR-10 同步/身份传输待更新，不能据此开工 | ALL-HOST-09（本表逐项索引） |
| AGENT-01 | 创建与持久身份 | M0 / DEV-04/06/07 | 项目内成员配置与持久 ID；多人邀请后续 | FULL-04 | DEV-05/10/21/23 | G3/RT-23；ALL-AGENT-01（本表逐项索引） |
| AGENT-02 | 详情面板 | M3 / DEV-14/18 | 成员详情、消息入口；Apps 等随所属 FULL | FULL-04 | DEV-05/10/21/23 | RT-26/G5；ALL-AGENT-02（本表逐项索引） |
| AGENT-03 | 资料自维护 | v0.1 后 | 无首版子集，完整保留 | FULL-04 | DEV-05/10/21/23 | ALL-AGENT-03（本表逐项索引） |
| AGENT-04 | 九类 runtime 目录 | v0.1 后 | 无首版子集，完整保留 | FULL-04 | DEV-05/10/21/23 | ALL-AGENT-04（本表逐项索引） |
| AGENT-05 | 选择与切换 | M0→M2 / DEV-06/10 | Codex 与 Claude 的已认证路径；其他引擎归 FULL | FULL-04 | DEV-05/10/21/23 | RT-23/B6；ALL-AGENT-05（本表逐项索引） |
| AGENT-06 | 认证和 API key 入口 | M0→M2 / DEV-06/10 | Codex 与 Claude 的已认证路径；其他引擎归 FULL | FULL-04 | DEV-05/10/21/23 | RT-23/B6；ALL-AGENT-06（本表逐项索引） |
| AGENT-07 | 私有持久工作空间 | M0 / DEV-04/17/21 | 应用数据目录草稿、项目上下文与会话隔离 | FULL-04 | DEV-05/10/21/23 | PP-05/TH；ALL-AGENT-07（本表逐项索引） |
| AGENT-08 | 浏览与维护 | M3 / DEV-19/24 | 项目文件与托管草稿分开浏览，权限逐资源验证 | FULL-04 | DEV-05/10/21/23 | WPV/G5；ALL-AGENT-08（本表逐项索引） |
| AGENT-09 | 知识与隔离 | M0 / DEV-04/17/21 | 应用数据目录草稿、项目上下文与会话隔离 | FULL-04 | DEV-05/10/21/23 | PP-05/TH；ALL-AGENT-09（本表逐项索引） |
| LIFE-01 | 状态与原因 | M0 / DEV-05/06/17 | 本机进程、停止与运行状态；完整生命周期 M3 | FULL-04 | DEV-05/10/21/23 | RT-07/G3；ALL-LIFE-01（本表逐项索引） |
| LIFE-02 | 自动空闲与唤醒 | M3 / DEV-13/14/23 | 有限唤醒、重置范围、删除成员保留历史 | FULL-04 | DEV-05/10/21/23 | REM/RT/G5；ALL-LIFE-02（本表逐项索引） |
| LIFE-03 | Start/Stop | M0 / DEV-05/06/17 | 本机进程、停止与运行状态；完整生命周期 M3 | FULL-04 | DEV-05/10/21/23 | RT-07/G3；ALL-LIFE-03（本表逐项索引） |
| LIFE-04 | 三类重置 | M3 / DEV-13/14/23 | 有限唤醒、重置范围、删除成员保留历史 | FULL-04 | DEV-05/10/21/23 | REM/RT/G5；ALL-LIFE-04（本表逐项索引） |
| LIFE-05 | 删除 Agent | M3 / DEV-13/14/23 | 有限唤醒、重置范围、删除成员保留历史 | FULL-04 | DEV-05/10/21/23 | REM/RT/G5；ALL-LIFE-05（本表逐项索引） |
| REM-01 | 定时跟进 | M3 / DEV-23/21 | 一次/循环提醒、owner、幂等与恢复合并 | FULL-04 | DEV-05/10/21/23 | REM/PP/G5；ALL-REM-01（本表逐项索引） |
| REM-02 | 提醒管理 | M3 / DEV-23/21 | 一次/循环提醒、owner、幂等与恢复合并 | FULL-04 | DEV-05/10/21/23 | REM/PP/G5；ALL-REM-02（本表逐项索引） |
| REM-03 | 恢复边界 | M3 / DEV-23/21 | 一次/循环提醒、owner、幂等与恢复合并 | FULL-04 | DEV-05/10/21/23 | REM/PP/G5；ALL-REM-03（本表逐项索引） |
| DIAG-01 | 故障指引 | M3 / DEV-13/14 | 脱敏诊断与可解释错误 | FULL-04 | DEV-05/10/21/23 | RT/G5；ALL-DIAG-01（本表逐项索引） |
| DIAG-02 | 诊断与反馈 | M3 / DEV-13/14 | 脱敏诊断与可解释错误 | FULL-04 | DEV-05/10/21/23 | RT/G5；ALL-DIAG-02（本表逐项索引） |
| EXT-01 | 独立进程接入 | v0.1 后 | 无首版子集，完整保留 | FULL-06 | 受限凭据/外部成员生命周期 | ALL-EXT-01（本表逐项索引） |
| EXT-02 | 设备授权登录 | v0.1 后 | 无首版子集，完整保留 | FULL-06 | 受限凭据/外部成员生命周期 | ALL-EXT-02（本表逐项索引） |
| EXT-03 | 设置与状态 | v0.1 后 | 无首版子集，完整保留 | FULL-06 | 受限凭据/外部成员生命周期 | ALL-EXT-03（本表逐项索引） |
| EXT-04 | 框架接入指南 | v0.1 后 | 无首版子集，完整保留 | FULL-06 | 受限凭据/外部成员生命周期 | ALL-EXT-04（本表逐项索引） |
| EXT-05 | 事件桥边界 | v0.1 后 | 无首版子集，完整保留 | FULL-06 | 受限凭据/外部成员生命周期 | ALL-EXT-05（本表逐项索引） |
| CH-01 | 公开和私密 | M3 / DEV-14/17 | 本机房间成员/读取范围；多人角色扩展后续 | FULL-01 | DEV-17/18/14 | TH/G5；ALL-CH-01（本表逐项索引） |
| CH-02 | 创建频道 | M0 / DEV-04/07 | 本机项目文件夹、默认房间与稳定身份 | FULL-01 | DEV-17/18/14 | G3/TH；ALL-CH-02（本表逐项索引） |
| CH-03 | 加入、退出与成员 | M3 / DEV-14/17 | 本机房间成员/读取范围；多人角色扩展后续 | FULL-01 | DEV-17/18/14 | TH/G5；ALL-CH-03（本表逐项索引） |
| CH-04 | 频道级角色 | v0.1 后 | 无首版子集，完整保留 | FULL-01 | DEV-17/18/14 | ALL-CH-04（本表逐项索引） |
| CH-05 | 权限特殊规则 | v0.1 后 | 无首版子集，完整保留 | FULL-01 | DEV-17/18/14 | ALL-CH-05（本表逐项索引） |
| CH-06 | 个人侧栏 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-CH-06（本表逐项索引） |
| CH-07 | 归档、恢复与删除 | M3 / DEV-04/14 | 归档/恢复/明确删除应用记录；不删项目源码 | FULL-01 | DEV-17/18/14 | RT/G5；ALL-CH-07（本表逐项索引） |
| MSG-01 | 消息输入 | M0 / DEV-01/07/17 | 默认发送/仅记录、线程与目标隔离 | FULL-02 | DEV-17/22；公共会话与 audience | G0/G3/TH；ALL-MSG-01（本表逐项索引） |
| MSG-02 | 提及和关注 | M0→M1 / DEV-01/08/21 | 结构化提及、跟进名单与有界互唤 | FULL-02 | DEV-17/22；公共会话与 audience | AT-09/FOLLOW/E11；ALL-MSG-02（本表逐项索引） |
| MSG-03 | 表情反馈 | M3 / DEV-18 | 惰性表情反馈，不唤醒模型 | FULL-02 | DEV-17/22；公共会话与 audience | G5；ALL-MSG-03（本表逐项索引） |
| MSG-04 | 消息操作 | M3 / DEV-18/24 | 消息操作、版本和显式删除，不重放执行 | FULL-02 | DEV-17/22；公共会话与 audience | TH/G5；ALL-MSG-04（本表逐项索引） |
| MSG-05 | 图片分享 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-02 | DEV-17/22；公共会话与 audience | WPV/G5；ALL-MSG-05（本表逐项索引） |
| MSG-06 | 消息记录规则 | M0 / DEV-01/07/17 | 默认发送/仅记录、线程与目标隔离 | FULL-02 | DEV-17/22；公共会话与 audience | G0/G3/TH；ALL-MSG-06（本表逐项索引） |
| THR-01 | 创建与打开 | M0 / DEV-01/07/17 | 默认发送/仅记录、线程与目标隔离 | FULL-02 | DEV-17/22；公共会话与 audience | G0/G3/TH；ALL-THR-01（本表逐项索引） |
| THR-02 | 独立串内回复 | M0 / DEV-01/07/17 | 默认发送/仅记录、线程与目标隔离 | FULL-02 | DEV-17/22；公共会话与 audience | G0/G3/TH；ALL-THR-02（本表逐项索引） |
| THR-03 | 订阅与阅读 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-02 | DEV-17/22；公共会话与 audience | RT-26/TH/G5；ALL-THR-03（本表逐项索引） |
| DM-01 | 私信（1 对 1） | M3 / DEV-22/21 | 项目内人对 Agent 普通一对一；其他主体组合 FULL-02 | FULL-02 | DEV-17/22；公共会话与 audience | DM-BASE/PP-05；ALL-DM-01（本表逐项索引） |
| DM-02 | 私信能力 | M3 / DEV-22/21 | 项目内人对 Agent 普通一对一；其他主体组合 FULL-02 | FULL-02 | DEV-17/22；公共会话与 audience | DM-BASE/PP-05；ALL-DM-02（本表逐项索引） |
| JOINT-01 | 创建与邀请 | v0.1 后 | 无首版子集，完整保留 | FULL-09 | FULL-05；ADR-10 联邦同步待更新 | ALL-JOINT-01（本表逐项索引） |
| JOINT-02 | 共享数据 | v0.1 后 | 无首版子集，完整保留 | FULL-09 | FULL-05；ADR-10 联邦同步待更新 | ALL-JOINT-02（本表逐项索引） |
| JOINT-03 | 跨空间边界 | v0.1 后 | 无首版子集，完整保留 | FULL-09 | FULL-05；ADR-10 联邦同步待更新 | ALL-JOINT-03（本表逐项索引） |
| ATTN-01 | Activity 聚合 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-ATTN-01（本表逐项索引） |
| ATTN-02 | 阅读位置与 Saved | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-ATTN-02（本表逐项索引） |
| ATTN-03 | 搜索 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-ATTN-03（本表逐项索引） |
| ATTN-04 | 结果导航与范围 | M3 / DEV-18/19 | 导航、阅读、收藏、搜索及范围过滤 | FULL-01 | DEV-17/18/14 | RT-26/TH/G5；ALL-ATTN-04（本表逐项索引） |
| ATTN-05 | 推送设置 | M3 / DEV-18/23 | 本机通知与执行分离；Web Push 后续 | FULL-01 | DEV-17/18/14 | REM/G5；ALL-ATTN-05（本表逐项索引） |
| ATTN-06 | 执行与通知分离 | M3 / DEV-18/23 | 本机通知与执行分离；Web Push 后续 | FULL-01 | DEV-17/18/14 | REM/G5；ALL-ATTN-06（本表逐项索引） |
| TASK-01 | 三种任务创建 | M0→M2 / DEV-07/08/09/11 | DIRECT→研讨→AUTO；可选验收按项目策略 | FULL-02 | DEV-17/22；公共会话与 audience | AT/G4/RT-25；ALL-TASK-01（本表逐项索引） |
| TASK-02 | 任务元数据 | M3 / DEV-11/14/19 | 本地任务看板/元数据/合法状态转换；不把对标五态替代内部状态机 | FULL-02 | DEV-17/22；公共会话与 audience | RT-25/26/G5；ALL-TASK-02（本表逐项索引） |
| TASK-03 | 五种对标状态 | M3 / DEV-11/14/19 | 本地任务看板/元数据/合法状态转换；不把对标五态替代内部状态机 | FULL-02 | DEV-17/22；公共会话与 audience | RT-25/26/G5；ALL-TASK-03（本表逐项索引） |
| TASK-04 | 认领与释放 | M3 / DEV-11/14/19 | 本地任务看板/元数据/合法状态转换；不把对标五态替代内部状态机 | FULL-02 | DEV-17/22；公共会话与 audience | RT-25/26/G5；ALL-TASK-04（本表逐项索引） |
| TASK-05 | 看板与任务线程 | M3 / DEV-11/14/19 | 本地任务看板/元数据/合法状态转换；不把对标五态替代内部状态机 | FULL-02 | DEV-17/22；公共会话与 audience | RT-25/26/G5；ALL-TASK-05（本表逐项索引） |
| TASK-06 | 拆解与审阅 | M0→M2 / DEV-07/08/09/11 | DIRECT→研讨→AUTO；可选验收按项目策略 | FULL-02 | DEV-17/22；公共会话与 audience | AT/G4/RT-25；ALL-TASK-06（本表逐项索引） |
| FILE-01 | 共享与下载 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-FILE-01（本表逐项索引） |
| FILE-02 | 预览类型 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-FILE-02（本表逐项索引） |
| FILE-03 | Files 集合 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-FILE-03（本表逐项索引） |
| FILE-04 | 访问与留存 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-FILE-04（本表逐项索引） |
| COMMENT-01 | 评论入口与线程 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-COMMENT-01（本表逐项索引） |
| COMMENT-02 | 五类锚点 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-COMMENT-02（本表逐项索引） |
| COMMENT-03 | 限制和版本 | M3 / DEV-19/24 | 附件七类四能力、版本预览；评论先文本/代码/Markdown，其他锚点 FULL-03 | FULL-03 | DEV-24；资源版本/解析器 | WPV/G5；ALL-COMMENT-03（本表逐项索引） |
| APP-01 | 四类应用 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-01（本表逐项索引） |
| APP-02 | 应用管理页面 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-02（本表逐项索引） |
| APP-03 | 注册与凭据 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-03（本表逐项索引） |
| APP-04 | 私有分享与市场发布 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-04（本表逐项索引） |
| APP-05 | 所有权管理 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-05（本表逐项索引） |
| APP-06 | Agent 辅助管理 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-06（本表逐项索引） |
| APP-07 | 安装与授权边界 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-07（本表逐项索引） |
| APP-08 | 发现与安装卡 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-08（本表逐项索引） |
| APP-09 | 卸载与撤销 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-09（本表逐项索引） |
| APP-10 | 身份登录体验 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-APP-10（本表逐项索引） |
| DEVAPP-01 | 脚手架与模板 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-DEVAPP-01（本表逐项索引） |
| DEVAPP-02 | 共享头像组件 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-DEVAPP-02（本表逐项索引） |
| AUTH-01 | 标准 OIDC | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-01（本表逐项索引） |
| AUTH-02 | 精确回调 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-02（本表逐项索引） |
| AUTH-03 | 交换与 session | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-03（本表逐项索引） |
| AUTH-04 | 身份模型 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-04（本表逐项索引） |
| AUTH-05 | 服务器信息与权益 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-05（本表逐项索引） |
| AUTH-06 | 每次请求授权 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-06（本表逐项索引） |
| AUTH-07 | Agent callback | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-07（本表逐项索引） |
| AUTH-08 | 可诊断拒绝 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-AUTH-08（本表逐项索引） |
| MANIFEST-01 | 发现与模式 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-MANIFEST-01（本表逐项索引） |
| MANIFEST-02 | 完整字段 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-MANIFEST-02（本表逐项索引） |
| MANIFEST-03 | 操作声明 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-MANIFEST-03（本表逐项索引） |
| MANIFEST-04 | CLI 与凭据 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-MANIFEST-04（本表逐项索引） |
| DEVAPP-03 | 公开契约与兼容 | v0.1 后 | 无首版子集，完整保留 | FULL-07 | installation/grant/OAuth 设计 | ALL-DEVAPP-03（本表逐项索引） |
| EVENT-01 | App 到 Agent 入站事件 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-EVENT-01（本表逐项索引） |
| EVENT-02 | 资源绑定 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-EVENT-02（本表逐项索引） |
| EVENT-03 | 事件字段和幂等 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-EVENT-03（本表逐项索引） |
| EVENT-04 | 来源与信息边界 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-EVENT-04（本表逐项索引） |
| NOTIFY-01 | App installation 数据投影 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-NOTIFY-01（本表逐项索引） |
| NOTIFY-02 | 平台到 App 事件 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-NOTIFY-02（本表逐项索引） |
| NOTIFY-03 | 双向通道分离 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-NOTIFY-03（本表逐项索引） |
| CLI-01 | 渐进迁移 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-01（本表逐项索引） |
| CLI-02 | 三种认证 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-02（本表逐项索引） |
| CLI-03 | 受 proof 约束登录 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-03（本表逐项索引） |
| CLI-04 | 独立存储与刷新 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-04（本表逐项索引） |
| CLI-05 | 请求和锁约束 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-05（本表逐项索引） |
| CLI-06 | 共享实现范围 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-06（本表逐项索引） |
| CLI-07 | 兼容与发布 | v0.1 后 | 无首版子集，完整保留 | FULL-08 | FULL-07/可靠事件 | ALL-CLI-07（本表逐项索引） |
| UI-01 | 关系图与帮助入口 | v0.1 后 | 无首版子集，完整保留 | FULL-01 | DEV-17/18/14 | ALL-UI-01（本表逐项索引） |

## 首版额外设计项

§27 的 137 项不是众说新增功能全集：Git 客户端（DEV-12/14，RT-24）、可选任务验收（DEV-14，RT-25）、共享预览（DEV-24，WPV）、MCP 预留（DEV-01/02/05，MCP-BASE）、默认单写者与前像恢复（DEV-04/12/13，RT-07/08/09）仍为首版要求。并行写入增强/worktree 标延期，不混入 M3 验收；MCP 本体另归 FULL-11，不能因没在 137 项里而漏掉。
