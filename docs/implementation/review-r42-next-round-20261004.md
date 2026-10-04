# 第四十二轮复核与第四十三轮指令（2026-10-04）

基线 `8f49f5c`。本次只读检查源码与证据，执行迁移专项测试和纯分类反例；没有修改产品源码、v5程序、server-data或用户回填。本文件与独立probe为新增复核材料。

## 1. 用户回填已经完成，不再等待或要求重做R1–R7

唯一人工结果原件：`D:\zhongshuo\dist\desktop\dev25-dual-win-v5\RESULTS\SHORT-REGRESSION.md`。

原图：同包 `RESULTS/shots/`；尺寸和逐文件SHA256：`RESULTS/V5-SCREENSHOTS-20261004.json`。

- R1/R2/R4：用户确认PASS。
- R3：用户追加明确确认“已重启，而且自动恢复”，该功能PASS；私信消息区被压成小条的布局问题另列。
- R5：设备区可见、实际LAN地址复制成功，按已观察范围PASS；监听选择框与运行事实不同步另列。
- R6：关闭预览没有反应，FAIL；未补造图表/翻页/缩放各子项通过。
- R7：Word标题、正文与表格已有显示，但区域过小，完整能力判定BLOCKED。布局问题不能归为用户个人阅读偏好。

当前整组未全通过；Android等待R6/R7收口。已有通过结论按v5范围保留，不要求再做D1–D10。

GLM编码阶段未写v5，与用户之后合法执行演练、Codex按明确授权代填结果/归档截图要分开叙述。不得删除新增回填来恢复“目录零变化”。

## 2. 第四十二轮已核实的正向结果

- 新迁移042使用seq处理恢复事件，补041的NULL旧行；本次独立执行 `tests/integration/legacyProtectionUpgrade.test.ts`，**3/3通过**。没有重跑全量846套件。
- Word新版metrics已具有真正的非隔离样式泄漏负对照、Shadow内部有效样式computedStyle、真实altChunk开关对照、正常内嵌图片解码、页眉文本和外链关系被消费的证据。原先几个假覆盖已改善，不需要重选预览引擎。
- 操作入口与许可材料已有源码修订，实际下一包仍须核对生成结果。

“已有专项测试通过”不等于下列实际反例已覆盖。

## 3. 最高优先：处理用户真实显示/关闭缺陷

### 统一隐藏契约

v5原包CSS的独立计算样式反例已在人工结果记录中，证据：

`D:\zhongshuo\dist\desktop\review-v5-manual-20261004\hidden-style-result.json`。

添加hidden后：`.pool`仍flex、`.composer`仍flex、`.attach-preview`仍block；`.thread`控制组才变none。当前42源码style.css仍只有个别组件的hidden规则，没有修此缺口。

先修宿主视图的隐藏契约，与关闭/切换时的资源释放、代次失效保持一致。实际关闭后预览必须不显示且不占空间；切私信后主池及主池输入区必须不继续占空间。禁止以classList.contains('hidden')或DOM存在与否替代computedStyle/实际可见区域的验证。

### 阅读空间

用户图1/图3为真实现场：私信只见细条，Word是狭小区域和嵌套滚动；主池和仓库/工具区仍占大量空间。

- 聊天主内容区优先；非当前视图和相关输入区真正收起，常驻仓库/工具信息不能压缩核心阅读区。
- Word/PPT正常文档提供足够阅读区域，并有可展开或可调节的预览方式；保留提取文本与视觉分列，但不要让重复内容抢占所有可用高度。
- 不靠浏览器缩小到特殊缩放比例或手动改CSS作为产品解法。
- 用实际打包页面，在用户宽屏尺寸与常规窗口尺寸下测切换、关闭、重开、滚动、视觉分页/图片/表格和资源清理；验证不能只用不具备CSS/布局的VM桩。

### 监听控件

用户图2实际监听=0.0.0.0/LAN、地址可复制，但下拉为“仅本机”。展示当前事实/已保存配置与未应用编辑要清楚区分；刷新不能覆盖正在编辑的值，也不能把LAN实际运行呈现成已应用回环配置。邻接操作用独立环境验证。

## 4. 迁移分类器仍有保守判定缺口

位置：`src/persistence/migrations/042-turn-protection-state-backfill.ts:35`。

纯函数反例已经执行：

```json
{"kind":"recovery.protectionReleased","payload":{"released":true,"protectionRetained":true},"classified":"released"}
```

另一个无完整释放证据的输入：

```json
{"kind":"recovery.protectionReleased","payload":{"released":true,"probe":{"result":"alive"}},"classified":"released"}
```

当前分类只要released===true即返回released，没有检查矛盾，与报告“矛盾一律retained”不符。probe alive并不在所有情形下都否定可信Job完整结束证据，所以补测时要区别“有可信managedEvidence的完整释放正例”和“缺证据且信息冲突”；不能简单再写一个不分事实层级的否决条件。

还需按既有保护合同复核 `executed + exitFact:'exited'` 的处理：042直接将其回填released，但当前 `recovery.releaseProtection` 明确拒绝周期快照exited观察（含旧版本观察），因为它不能证明全部受管进程结束。**历史审计曾写释放与当前具有完整退出证明不是同一事实**。不能仅因字符串为exited就追认成新标准下的完整证据；可信no-os-process/managed-Job正例则不能误拦。

脚本与结果：`dist/desktop/review-r42/protection-classification-probe.mjs`、`protection-classification-result.json`；纯函数、零DB、零worker、零模型。不宣称实际旧库已经出现此矛盾或产生重复调用。

修正分类器和对应升级/准入反例，保持预算与审计不变。若042已作为版本化迁移冻结，不用静默改写既有历史来修复已回填的错误行：针对已应用042的库也明确安排兼容修复、重开同判及范围审计。普通失败、不完整证据、可靠解除各自分列。

## 5. 支持现场与材料还需同步

- 只读事实在 `docs/implementation/dev25-v5-precondition-support-20261004.md`：实际PPT位于Lab Room的根消息线程；42的addendum和指南仍写默认房间直接消息行芯片，不符当前v5。
- 当前seed仍使用room.list.items[0]，没有明确绑定默认房间。下一包按固定房间身份种子并将最终房间/线程/附件身份写入seed事实，指南按真实入口编写。
- 首次桌面空侧栏与后续R3重启恢复PASS分别保留。工程自测增加全新数据首启、seed完成后自动装载，不能reload或手动打开后才判“首启自动可见”。
- 远程线程根消息/根附件未呈现的读取缺口单独登记并按已批准范围修复，不自动扩大为新增远程Office视觉预览项目。
- 随包NOTICE引用的相对路径要在最终包真实解析存在，不仅统计文件数或源tarball一致。
- 最早全量测试1项失败且名称丢失，只能登记未定位；以后全量原始日志按runId完整留存，不将截尾输出当完整诊断，更不能把未再复现写为已定位。

## 6. 下一轮交付要求与用户负担

保持PPT A+Word、B首版不集成；当前不需要用户重新选型或准备新资源。

先修已复现的隐藏/关闭、聊天与预览空间、监听显示，补迁移边界和真实页面反例。源码收敛后集中出独立v6候选，包含042及必要兼容收口、样本和材料修订，做最终验证器同冻结产物三次完整序列、文件身份核对、真实启动器和种子自测。

v5及用户原始回填/原图保持原地；相关证据可复制归档但原件不覆盖。用户下一次只针对R6/R7和相邻视图切换、监听显示做短回归；R1–R5已有通过范围保留，工程若修改其合同则明确说明需要追加的局部验证，不默认再跑七项。

闭环前不安排Android手测、不宣布G5。零新增真实模型调用、原真实批次与通知证据保留；价值评价、DEV-11和并行写入状态不变。
