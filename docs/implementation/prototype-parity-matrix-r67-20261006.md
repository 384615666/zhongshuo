# R67 日常使用与数据继承收口矩阵（2026-10-06）

对象：`desktop-daily-win-v5`（BUILD `bld_fd6a5557b37a5bb9`，commit `1840b5e`，dirty=false，清单 591/591，verify-desktop-daily 绿）。
输入：`review-r66-daily-contracts-next-round-20261006.md` + 独立反例 `dist/desktop/review-r66-audit-20261006/`。
验证产物：交互门 `dist/desktop/gate-r67-*/result.json`（ok:true）；视觉门 `dist/desktop/visual-gate-r67/`（10 场景非空密度，vision 10/10）；升级门 `dist/desktop/upgrade-drill-r67-*/result.json`（ok:true+负对照 4/4）；全量 905/905+双类型门 0 错；`r67Contracts.test.ts` 6/6。

## A. 独立反例逐项收口

| 反例 | 修复 | 证据 |
| --- | --- | --- |
| P1-A 工作区保存恒崩（DTO 无 sha256）+105KB 只回 64KB | 新命令 `project.file.readFull`（全文+sha256+includeBytes 原字节，路径安全链同 read；≤256KB 有界）与 `project.file.originalFile`（原字节通道）；WorktreeBody 改走 readFull 并以**读取时快照字节**保存；旧 read 保持 64KB 提取窗（模型注入合同不变） | 交互门 G2：工作区 MD 排版+源码尾部标记可达（>64KB）；G3：另存落盘 sha256==readFull 快照逐字一致；合同测试 readFull/originalFile（BOM 原样/越界/白名单负例） |
| P1-B 换数据根草稿/未知账本失联+重发重复 | **逻辑数据根身份**：`app.identity` 懒建 `root-identity.json`（dataRootId 随目录复制）；持久化键升 v2=`v2.<dataRootId>|<user>`；**双通道可信继承**（新格式快照内嵌 dataRootId 本地自证——旧路径已改名/移动也可继承；旧格式交 `app.rootIdentityOf` 只读核对旧目录标记）；合并语义=pendingSends 按键取新/账本 commandId 并集/草稿 24h TTL 沿用；旧键原样保留；无关根/他用户不混入 | 交互门 G1：**真实完整目录复制（含 profile）+真实启动器重开**——未知横幅恢复且 commandId 逐字一致；同号重试服务端消息数 0 增（恰一次）；普通草稿/仅记录意图/就绪附件全恢复 |
| P2-A 恢复三态第二次轮询倒退 startup+弹窗 | 来源按**首次成功快照的实体签名**固定（startupSignatureRef）；持续同一运行中新实体=runtime（toast+侧栏，永不转 startup/不弹窗）；全消→null；再出现=runtime；启动自动弹仅首查一次 | 交互门 G4 六态：注入→首轮 runtime 无弹窗→第二轮仍无弹不改判→清除→注意消失→再注入仍 runtime→真实重启→startup 自动弹一次→关闭后不再自动弹 |
| P2-B 工作区 HTML 仍源码 | WorktreeBody 与上传/正式成果共用同一风味分发（MD→MarkdownView/HTML→隔离 iframe/其余源码） | 交互门 G2：工作区 HTML iframe（sandbox=""）渲染 |
| §3 升级判据自比较无效/回退只证 SQLite | 验证器重写 `verify-upgrade-r67.cjs`：基线先存（全树 sha256+逻辑事实全列）；负对照 4 项**实跑**（blob 内容变更/消息正文变更计数不变/凭据变更/账本漂移——每个都让门失败）；回退=**升级前完整数据根**整目录快照→v4 可开+全树一致；全程 ZS_REAL_DISPATCH_GUARD=1+real_calls=0 | 升级门 ok:true（47→48+备份+全树零漂移+版本门拒含明确报错）；README v5 继承/回退步骤重写（回退=完整根+匹配程序，不再只替换单文件） |
| §4 视觉 9 对+材料口径 | R67 视觉门：**非空密度夹具**（第二成员/看板 3 卡自然完成/归档房间/搜索命中 8+条）、加载稳定等待（无「连接服务中/正在装载」）、逐场景实际视口入 manifest（s10=900×700） | vision 复核 formal 10/10（成员 4 卡含有效来源/看板分组卡/归档行/搜索命中）；HTML 正式侧独有已在 manifest 标注 |

## B. 衍生真缺陷（复核点名方向上额外发现并修复）

| 缺陷 | 修复 |
| --- | --- |
| 文件-only AI 派发在输入组装处恒 BLOCKED（`empty-root-message`——R66 只证明了建卡，正是复核「不能只证明建了一张 BLOCKED/AUTO 卡」的反面实证） | turnInput 允许空正文+有附件（无附件仍拒——不构造空输入）；合同测试：FakeWorker 真实消费→startTurn 实际输入含附件全文标记；交互门 G5：UI 发送→任务自然 **DONE** |
| 保存过导航偏好的用户（activeProjectId 已设）+无记忆路径 → boot 永远 pending（恢复轮询等全部挂起） | loader ready 条件去掉 activeProjectId==='' 误要求（G4 调试中发现：恢复状态 true 但 UI attr=0 的根因） |
| 工作区保存点击时重读磁盘（快照语义缺失） | 保存用读取时快照字节；磁盘变更拦截提示先重新加载（快照键=resource:revision，重载后替换） |

## C. P4 控件与既定原型功能补齐

- **共享 `Select` 组件**（components/ui）：全页接入（搜索范围/类型/会话、看板范围/项目/房间、成员项目/绑定渠道/权限、归档筛选、恢复对账判定）+`pdf-zoom` 统一为同一形态；键盘/Esc/IME 沿原生（原型同形态）。交互门 G6：aria-label/焦点可达断言；原生展开=系统标准层（不可截图，manifest 如实记录）。
- **添加成员**（无用户延期依据→补正式合同）：`member.create`（迁移 048 description 列；自动加入未归档房间/不自动协调者/不进在途研讨——原型「添加后会怎样」三条如实）+AddMemberModal；同名不合并=项目级实例。
- **搜索「侧栏可见项目」**：`search.query scope=visible`（navigation 偏好；无偏好=全量；ACL 不变——他人 DM 仍不返回；project 显式范围不受可见集限制）——合同测试正反例。
- 搜索空态改原型居中 EmptyState；全局默认 claude 未配模型名在成员页明示（用户 v3 startupFailed 根因的界面正解）。

## D. startupFailed 脱敏诊断（只读，不重放）

事件 payload（code/phase/classification/message 字段级）：`phase=startTurn, classification=uncertain, message="Claude 需显式模型（ZS_CLAUDE_MODEL / options.model）——默认配置模型不被 CLI 接受"`；进程登记：adapter=claude、pre-launch（pid=null，从未启动）。结论：全局默认 claude 渠道未配置模型名，成员未绑定→派发即启动失败。用户 UNKNOWN/保护/审计事实未动。

## E. 未覆盖/延期（如实）

- HTML 交互网页（脚本/表单）仍不支持（静态隔离预览如实说明）；OCR/模型图片输入未认证（能力门语义保持）。
- Select 展开态为系统原生层（与批准原型一致的原生 select 形态）——展开视觉效果不可截图核验，以收起态视觉+aria/键盘断言代替（manifest 已注明）。
- 继承演练的「等待期新编辑/早崩/TTL」其余分支沿既有 r62/r63 合同（本轮 G1 覆盖主线+同号恰一次）；隔离失败负例沿 r63 P2。
- Android/安装器/签名/自动更新/价值评价/DEV-11/并行写入/G5 既有延期不变。
