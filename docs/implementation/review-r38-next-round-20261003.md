# 第三十八轮复核与第三十九轮建议（2026-10-03）

基线：`a94328f`。本次只读检查源码和包，使用真实 `dispatchDaemonCommand` 在独立进程的内存数据库中执行最小反例；没有启动模型或 worker，没有修改 v2/v3、业务库和产品源码。

## 1. 已确认与本次不扩大的结论

- v3 包的实际文件已独立逐个核对冻结清单：`bld_f4d26d38592bb521`，583/583 SHA256 一致。
- D1—D10 的 v2 本次人工/自动证据收案保留，不要求用户重复整套。
- PPT 的解压/转换已接入 parsePool 子进程；缓存命中原件核验已落地。不要重复实现这些已有修复。
- 接受“审计缺事件”更正：按实际 v2 事件核对原报告的推断，在原报告追加勘误并保留原记录；失败原因呈现仍是必要修复。
- 154×3 和其他数字仍属于 GLM 的验证报告；本次未重新跑全套，不把这些数字写成本次独立复跑。
- 现场列表清空的报告中正文称根因确认，continuation 仍称路径比较为“候选根因”。须以冻结复现时间线/调用栈区分实证根因和防御措施，不把防御修复自动等同根因取证。

## 2. P1：新“恢复执行”入口的派发守卫不完整

### 2.1 在途 DM / UNKNOWN 都被正式命令接受

锚点：`src/daemon/commands.ts` 的 task.redispatch（3532 起）；`src/persistence/stores/dm.ts` 的 interruptedTasks；`tests/integration/dev25FieldFixes.test.ts` 的中断恢复测试。

派发前只用 `agent_turns.dispatch_key LIKE 'task:' || taskId || ':%'` 查在途 turn，漏掉 DM 初始键 `dmtask:<taskId>:initial`。同时该 SQL 把 UNKNOWN 排除于在途检查之外，没有验证实际退出、恢复对账或遗留保护是否收口。

在内存库通过正式 conversation.create/message.submit 建 DM，然后登记旧 run/turn、将已领取的 initial outbox 置 done（没有执行真实 runtime）。实际结果：

```json
{"runStatus":"INTERRUPTED","turnStatus":"UNKNOWN","accepted":true,"enqueued":true,"newOutbox":1,"realCalls":0}
{"runStatus":"RUNNING","turnStatus":"RUNNING","accepted":true,"enqueued":true,"newOutbox":1,"realCalls":0}
```

这是**命令入口错误放行并新增 outbox 的证据**，不是已经发生并发模型调用的证据；worker 后续仍可能阻挡部分情形。但正式“恢复执行”入口不能依赖这些偶然的后续阻挡。

现有 3/3 测试把 UNKNOWN 未对账直接重派当成功，是测试合同问题。要求：

- 通过 `workflow_runs.task_id` 等正式归属查询所有相关 turn/run，覆盖 DM、房间、提醒、修复和重派，不能由键前缀推测执行归属。
- RUNNING/WAITING/STOPPING、在途或未确认退出、UNKNOWN 未对账时不得新建派发。
- “中断”与“可重派”分列。服务端返回可恢复性、拒绝原因和目标执行版本，前端不能仅由 INTERRUPTED run 显示可执行按钮。
- UNKNOWN 先走既有恢复取证、对账及保护解除合同。显式点击按钮不等于旧执行已经退出；未取得事实不得自动重放或借新 run 绕预算。
- 恢复校验目标 run/turn、任务版本、停止代次、权限、会话归档/暂停状态与额度；失败事务不新增 outbox/run/turn，不复活已取消任务。
- 检查 `stop_generation > 0` 一票否决与既有“历史停止不阻断新合法派发”的快照合同，避免把历史停止等同本次停止。
- 如果远程端不能完成所需对账，显示回服务机核对的入口与原因，不强行重派。

### 2.2 恢复一次后再中断，第二次恢复撞唯一键

同一任务的非格式修复键固定为 `task:<taskId>:redispatch`。已有 done 行被 already 检查跳过，后续 INSERT 却不回收/版本化，撞 UNIQUE。

最小反例：第一次恢复成功→该 outbox 置 done→登记第二个 INTERRUPTED run→再调用 task.redispatch：

```json
{"firstAccepted":true,"secondAccepted":false,"secondError":{"code":"STORAGE_UNAVAILABLE","message":"数据库事务失败：UNIQUE constraint failed: outbox.dispatch_key","retryable":false},"redispatchRows":1}
```

要求：新恢复意图绑定明确的源执行与版本；同意图/同 commandId 重试返回同结果，新一次合法中断可产生新意图。连续恢复、重启、同号重试和双端同时点击均需反例。不要盲删旧派发行破坏审计，也不要仅为绕唯一键随机造新号允许重复执行。

## 3. SVG 自写净化仍有确定漏口

`src/daemon/pptxPages.ts:353` 的 svgWellFormed 只逐项验证双引号属性，不验证所有属性文本均被解析。以下纯字符串同时通过 svgWellFormed 和 schema 2 缓存校验：

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720"><image href=https://example.invalid/unexpected.png x="0" y="0" width="100" height="100"/></svg>
```

```json
{"unquotedExternalImageAccepted":{"ok":true},"cacheAccepted":true,"networkRequests":0}
```

本次没有发网络请求，也没有宣称已利用漏洞；证据是**未加引号的外部 href 被当受控 SVG 放行**。这已违反“无外链、严格白名单”的当前合同。

要求：引入成熟 HTML/SVG 净化器（DOMPurify 为优先候选），在对应 DOM 上配置严格标签/属性/协议白名单；额外禁外部资源请求。DOMPurify 默认配置本身不等于全离线资源策略。保留缓存结构、预算、原件身份与执行隔离校验。至少补无引号/单双引号、命名空间、外链资源与畸形标签反例，不再靠持续扩张正则兜底。

## 4. 附件成熟组件路线（用户本轮要求一起通知 GLM）

### 4.1 优先完成 PPT 替代原型

暂停扩大自写 XML→SVG 排版能力。已有安全修复保留；在独立目录实际验证 **PPTX→本地 LibreOffice 无界面转换 PDF→现有 PDF.js 预览**。转换只用于视觉预览，不自动替换正文提取、表格值或模型输入。

- 使用合法的真实格式样本，包含中文、图片、图表、组合形状、主题/母版、不同页序；比对实际页面，不能仅以 PDF 文件存在、页数正确或提取到文字判成功。
- 记录转换引擎版本、字体、效果限制、时延、内存与依赖体积；输出及截图归档。LibreOffice 不承诺所有复杂 PowerPoint 特效完整还原，差异如实报告。
- 子进程/进程树可终止，独立临时目录和 profile，不抢占用户已开的 Office，不覆盖原件。禁宏执行与不受授权的外部资源加载，失败明确呈现。
- 衍生预览与原 attachment 的 hash/revision/归属绑定；派生 PDF 不能跨会话借缓存绕权限，也不表示图片模型输入已认证。
- 依赖优先先置于验证工作目录；当前常见路径未发现 LibreOffice。不要要求用户先购买或安装，先做可运行原型并给出随包/独立安装方案及实际体积，再讨论正式部署选择。缺资源则给出准确阻碍与已完成材料，不写“方案已评估”冒充运行通过。

### 4.2 其他格式分批采用成熟库

- PDF.js、Mammoth、SheetJS 保留已验证的解析链与产品约束，避免重写已有能力。
- Markdown 优先 markdown-it；HTML/SVG 净化优先 DOMPurify。先固定版本与配置、补既有恶意样本/无外链行为验证。
- CSV 的自写解析器评估 Papa Parse；DOCX 导出的手写 OOXML 评估 docx。按必要性分批替换，保留已验证编码/值缓存/预算/导出权限/文件完整性/Word 实开验收。
- “开源引擎转换文档”和“众说管理归属、草稿、水位、缓存、预算、权限”分工明确。换库不豁免产品层修复。

官方依据：

- LibreOffice Windows 无界面及转换参数：https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html
- LibreOffice 支持的格式与 PDF 导出：https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html
- DOMPurify：https://github.com/cure53/DOMPurify
- markdown-it：https://github.com/markdown-it/markdown-it
- Papa Parse：https://www.papaparse.com/docs
- docx：https://github.com/dolanmiu/docx

## 5. 交付与用户验收顺序

- 先修 §2/§3 并完成正式链反例，再准备固定候选包和短回归指南。当前 v3 README 仍要求 D1—D10，未给出六项短回归的前置状态与独立模板；证书指纹“文件属性有 SHA256”与“切具体 IP 监听”也仍有不适用描述。补成不需要开发者工具/SQL/Node 的具体步骤，前置状态工程侧准备，输出实际路径。
- 独立目录不代表继承同一 CA。新数据根生成新 CA 时如实要求核对新指纹；“IP 换了 CA 不变”不能外推为跨包/数据根永远同根。旧 v2/v3 与原结果不覆盖，不复制私钥给客户端。
- 新包工程侧先完成相关协议、双端页面、真实 .bat 启动器、进程收拢及冻结身份核对。用户只做受影响项短回归；通过后 Android 按实际组合单独收案，不重复 D1—D10。
- Android 资源已确认，等具体步骤即可；小屏关键按钮不可达属于功能可用性缺陷，不能以“视觉问题不扣功能”排除。
- 当前不需要用户立即做新增判断或购买资源。开源预览效果、体积和部署材料就绪后，再提出必要的产品取舍。
- 零新增真实调用；旧实测与通知成果不重跑；FULL-03/OCR/PWA/Push 继续按原归属；价值评价暂缓；DEV-11/并行写入增强不开放；DEV-15/16/G5 不提前通过。
