# R70 文件阅读器可靠性与视觉收口（2026-10-07）

主交付 **desktop-daily-win-v8**。输入：`review-r69-reader-regressions-next-round-20261007.md` + 独立证据 `dist/desktop/review-r69-audit-20261007`（repeat/ui-result.json 五类反例、ppt-media-repeat CSP 命中、identity.json）。ZCode 对照沿用 R69 映射表（`zcode-preview-mapping-r69-20261007.md`）——本轮零新选型、零新渲染库。

## 1. 独立反例逐项修复（全部先修后验）

| # | 独立反例 | 根因 | 修复 | 门证据 |
| --- | --- | --- | --- | --- |
| 1 | 中文路径串读（甲文↔乙文同标签同内容；a-b.md≡a_b.md） | `registerWorktreeResource` 把非 ASCII 压成 `_`——不同路径碰撞成同一资源 ID | 资源 ID=`res_wt_<projectId>_<encodeURIComponent(规范路径)>`（无损可逆；跨项目独立；路径分隔统一 `/`） | G1：两中文文件=两标签+各自内容/标题/读命令路径；标点对 4 标签各自内容 |
| 2 | Excel 切「数据录入」几秒后弹回「补助模块」 | 每次 render 新建 `ArrayBuffer`（`.buffer.slice`/`bytes.slice(0)`）→ 引擎视同一文件为新输入重开；房间 5s 轮询重渲染触发 | `FileStage` 按装载快照 `useMemo` 稳定 bytes 引用（`stableBytes/stableArrayBuffer`）+装载缓存（切标签回来自缓存——身份不变不重开） | G2：切表后 12s（跨两轮询）+打草稿后仍「数据录入」，canvas hash 变化且保持 |
| 3 | PPT 内嵌图片 naturalWidth=0（24 条 CSP `img-src 'self' data:` 拦 `blob:zsres://app/…`） | 渲染器把内嵌媒体转为本地 blob URL，CSP 未放行 blob: | `index.html` CSP `img-src 'self' data: blob:`（只放行本地 blob——外部资源边界不变） | G4：用户真件第 5 页 3/3 张解码、第 28 页 4/4；CSP 违规 0；视觉帧 ours-ppt-media-p5 真实 3 图 |
| 4 | 切标签/收起回位丢失（PPT27→1、PDF3→1、Word300→0） | 阅读状态在易卸载组件 state；`goToPage` 把 setState 嵌进 setDoc updater（React 非法模式——页码从不真正落状态，R69 门只断言输入框值未暴露） | ① 新 `readerState.ts`：按 资源+读取版本 存 PPT 页/缩放、PDF 页/缩放、Excel 工作表、Word scrollTop；关闭标签清理 ② goToPage 改直接 set（docRef） ③ 首挂保留恢复值 | G3：PPT 切标签回 27、PDF 回 3、Word 回 300、收起重开回 27 |
| 5 | PDF 缩窄后 canvas 越界（389 stage/453 canvas） | 宽度 observer `useEffect([])` 初跑在 loading 态 null 节点——永不生效 | 观察器挂在常驻 `.pdf-stage`（loading 也渲染）+doc 就位再校正；宽高都重算 fit；DPR 感知渲染 | G5：初始无越界；缩窄到 343 画布 287 无横向溢出（滚动条消失） |
| 6a | Word wrapper 灰底 rgb(128,128,128)+30px padding | docx-preview 渲染后追加默认样式，覆盖先注入的自定义样式 | 渲染后**内联覆盖**（style 优先级高于样式表）+纸张阴影样式后置追加 | G6：wrapper bg=rgba(0,0,0,0) pad=0px；视觉帧顶部无灰带 |
| 6b | presentation/grid/zoom-in/zoom-out 图标=黑圆 | Icon 映射缺这四名→fallback 圆 | 补四个真实线性图标（描边 path 组） | G6：iconsBad=[]（G4 场景 DOM 断言） |
| 7 | delivery.document 报告≠AI 实际产出文件 | fake 无落盘副作用；成果列表无文件入口 | ① fake 脚本项 `writeFile`（cwd 内安全写盘）+`ZS_FAKE_WRITE_FILES` 编排 ② TaskComplete.files 列出真实文件 ③ 报告视图「涉及文件」逐项「打开文件」→注册工作区资源→同一阅读器（报告与文件分列） | G7：两文件真实落盘（197B/57B）→成果报告列两文件→点开在阅读器显示真实内容（R70-DELIVERY-FILE） |
| 8 | 事实回填缺失（hash/大小停留占位；delivery bytes 用长度冒充） | FileStage 未调 applyWorktreeRead；DeliveryDocView 丢弃 hashMatch/bytes | ① 装载后 `applyWorktreeRead`（hash/size/mimeType/编码真值） ② `LoadedFile.delivery` 携带 hashMatch/真实字节数；另存与说明均用真实值 | G7/G1 读取命令路径核验；`FileStage` 事实回填链（类型+mimeType 修正） |
| 8b | **衍生真缺陷**：房间线程「附件」页对记录串恒空 | `threadAttachments` 选择器按 `m.threadId===thread.id` 过滤——锚消息 thread_id=null 结构性不可见；loader 水合的 threadAnchors.formalAttachments 是另一片 | 选择器并入锚附件（threadAnchors[tid].formalAttachments） | G8 已发消息入口（记录卡→线程→附件页→六入口.md 打开） |
| 8c | **衍生真缺陷**：透传 TaskComplete 破坏 resultKey 绑定（全量 19 例失败） | 我的 F7 第一版透传保留脚本占位 resultKey:'rk'，与 worker 校验 `result_<turnId>` 不匹配 | resultKey 一律以 turn 绑定值为准（脚本占位不可信） | 19 例全绿复跑；G7 复跑仍全链 |

## 2. 验证总账

- **verify-daily-r70.cjs**（每反例一 Gate，独立 root×8，全 UI 真链）：`{"ok":true,"errs":[]}`——G1 身份/G2 切表保持/G3 阅读状态/G4 PPT 媒体+图标/G5 PDF resize/G6 Word 实样式+红字+高亮/G7 交付真文件/G8 六入口（草稿/已发/文件树/DM/关全部再首开/快切）。**realCallRoots=[0,0,0,0,0,0,0,0]**（8 根独立核）。
- 视觉 `visual-pairs-r70.cjs`：8 帧（五参考类型+TXT/PNG+PPT 图文页）+Word 红字/高亮补帧，**全部 PASS**；每帧记录整窗 {2560×1380,DPR1} 与**实际预览 rect**（x=1932,w=620——两者分列不混同）+当前阅读状态（页/表/缩放）。
- 旧门回归：verify-daily-r69 全绿（realCalls=0）——R69 全判据在 R70 代码上仍过。
- 全量 vitest **917/917**（含 resultKey 修复后复跑）；主/hifi typecheck 0 错。
- 打包门与升级负例见 §3。

## 3. 发布形态复核（v8）

- v8=`bld_6d502ccefe8159b3`（commit `33230aa`，dirty=false，593/593）；`verify-desktop-daily-r63 --src dist/desktop/desktop-daily-win-v8` ok:true（独立副本×真实启动器，realCalls=0）；升级门 `verify-upgrade-r67` ok（负对照 4/4：blob/msg/token/outbox；旧程序开升级库被版本门拒）。
- 发布 zsres 协议下 blob: 图片（G4 的 CSP 判据在 dev zsres://app 同协议验证；v8 包内 index.html 同字节）。

## 4. 判据修正声明（R69 漏判教训）

- R69 总门曾把 `xlsxTabSwitch=false` 记为 ok=true——R70 总门**所有必要判据进 errs 数组**（任一 false/undefined 即 exit≠0）；本轮 18 轮迭代中每个假阴性都被翻成 FAIL 再修（valueTracker 探针假象、`# G8` 渲染后无井号、CSP fetch 探针等断言层缺陷同样修正，不以断言修复冒充产品修复）。
- 视觉整窗≠预览区：pairs.json 逐帧记录 paneRect/bodyRect/DPR/reader 状态。

## 5. 未覆盖/边界（如实）

- Emulation 拉宽被窗口实际尺寸钳制——G5 wide 为信息项（必要判据=初始+缩窄=独立反例本体）。
- PDF 连续滚动模式未做（单页+页码，与参考图一致）；PPT「选择元素」为 ZCode 特有（未移植）。
- Excel 引擎行高/字号与参考有差（视觉 info，不阻断识读）；回退网格无样式（引擎可用路径为主）。
- 既有延期不扩：Android/安装器/签名/价值评价；HTML 交互（脚本仍禁）。
