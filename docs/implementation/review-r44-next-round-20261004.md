# 第四十四轮复核与下一步（2026-10-04）

基线`6409fe4`。独立跑`legacyProtectionUpgrade.test.ts`与`dmReviewContract.test.ts`，2文件7/7通过；没有重跑全量850项。读取U6原始布局metrics与源代码，工具可见性/草稿保留的改善有证据支持。用户v6四项按本次范围收案，见`dev25-v6-short-regression-record-20261004.md`；七张原图复制归档后哈希一致。

本次未修改产品源码或演练库。新增用户结果/截图/指纹清单位于v6 RESULTS；工程探针在独立`dist/desktop/review-r44-independent/`。v5历史原件不动。

## 1. 可以推进Android，不重复Windows短回归

R6/R7/V1/V2按用户报告与补确认记PASS。先将V2结束的仅本机监听恢复LAN，确认实际192.168.1.100地址可达，再用现有Android手机验收。v6对应CA文件SHA-256=`c7655e12c4102fad83bf1b0f9d26fb667c81e9a568d1df624475321eef42b9b0`；端口以当前面板为准。不要用198.18虚拟网卡地址。

Android指南仍写「v2运行中」，需独立补充为当前v6及其实际CA/地址，不为材料调整重发包或重导同一根。记录手机/Android/浏览器实际版本；本轮没有新设备/服务需求。

后台恢复用确定步骤：手机后台期间，由桌面在同一会话发一条唯一标记的「仅记录」消息，回前台检查标记与状态恢复；不要假定种子首任务60秒停滞窗在用户多次操作后仍可用。手机吊销放最后；其它设备若已连接可顺带观察不受影响，未观察的部分另记工程覆盖。

## 2. [P1] 044将损坏probe字段当作缺字段

`src/persistence/migrations/044-turn-protection-evidence-complete.ts`：先把null/数组/非对象probe归成null，再用reason兜底。因而以下四种**已经带probe字段**的审计被判released：

```json
{"released":true,"reason":"protection-released-no-os-process","probe":null}
{"released":true,"reason":"protection-released-no-os-process","probe":[]}
{"released":true,"reason":"protection-released-no-os-process","probe":false}
{"released":true,"reason":"protection-released-no-os-process","probe":"broken"}
```

复现脚本/原始结果：`dist/desktop/review-r44-independent/boundary-probe.mjs`、`boundary-result.json`。这是纯函数损坏证据反例，未证明用户真实库已有此形态，也没有新派发或模型调用。

区分`Object.hasOwn(p,'probe')`与结构校验：reason兼容只允许真正缺字段；已有字段但损坏应保守retained。完整Job证据仍优先于滞后probe，缺probe的受控旧兼容正例也保留。044已提交，对已应用044的库按版本化迁移收口，覆盖44→最新、预算/审计不变、幂等及文件库重开，不反复改历史迁移。

## 3. [P2] 返工输入期间仍会换提交目标

补manifestHash及currentReview优先的修复成立；但`dm-review-reject`在点「要求修改」创建输入框时没有捕获review，只在**提交意见时**重读state.dmActive。

独立VM原样抽产品处理器：打开输入时目标A，写「对A交付的意见」，将state切换到B，再点提交，实际task.review参数是task_B/delivery_B/revision2/hashB，意见仍为A。没有真实后端执行此误审，不宣称用户现场已发生。

产品`renderDm`轮询会更新dmActive/currentReview，且没有删除返工输入框；一次性pendingFocus消费后尤其可能从定位交付变成另一pending。现有测试只设静态currentReview≠pendingReview诱饵，没有覆盖打开→输入→刷新/切会话→确认。

在用户打开返工输入时固定task/delivery/revision/hash及会话身份；确认只审该快照。若当前目标已变化，保持原绑定由后端拒过期，或明确作废意见并让用户重新确认；不能把旧意见自动套到新交付。同一DM不同任务、同任务版本更新、跨DM切换都加受控同步点；真实fake链断言A/B实际review状态，错误路径零误审。accept为单击操作另按其快照语义验证。

## 4. 材料收尾与包的选择

- 用户截图已足以收案，不要求再补这些Windows截图。PPT随包样本只有三页且无表格页；指南的「表格页显示网格」应配真实表格样本或从此次用户判据删除。预览功能已有工程表格测试不等于该种子存在表格。
- v6是r43产物，不含044/DM返工/工具入口修复；手测结论不得连带认证r44源码。修上述两条时保持运行中v6稳定。
- dirty对应材料的「21个文本文件、10件二进制」计数不符：`git diff --name-status 8f49f5c ab89219`为25项=21修改+4新增，其中DOCX/PDF为**8件**、文本为**17件（13修改+4新增）**。cmp只证明共同前缀，不足以证明全部文本差异逐字节一致；未留存构建时diff字节，完整dirtyDiffHash成分原因应写“不能完全重建”，不用“差异仅可来自…”作已证结论。保留BUILD原值，588文件清单和renderer对照证据仍有效，不为报告措辞让用户重测。
- Android可以在v6现有数据/CA上先测；GLM在独立环境完成工程边界及必要测试。Android回填后集中收失败再做**一次必要的最终候选**，同一冻结产物完整三连、清单/真实启动器/升级旧演练库验证。如果计划复用现有server-data及CA，先在副本证明迁移/备份/回退，再交付具体方案，不能擅自覆盖用户库或要求清库。
- DEV-25范围收案后按M3剩余项与DEV-15安装/升级设计推进，DEV-16兼容/G5仍按正式矩阵处理；当前不宣布发布通过。

继续A+Word、B不集成不下载，零新增真实模型调用。保留r20/r25/通知/D1–D10证据；价值评价、DEV-11、并行写入维持原约定。
