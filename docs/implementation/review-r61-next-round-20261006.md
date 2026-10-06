# R61复核与R62长批次指令（2026-10-06）

基线 `98e6d4e`；交付 v5=`bld_292768533f1c899c` / commit `978c8527` / dirty=false。复核只写本文及独立证据，不改产品、不构建覆盖产物、不启动用户数据根、不提交推送。独立证据根：`dist/desktop/review-r61-audit-20261006/`。本轮起止工作区已有 `scripts/verify-ppt-esc-r61.cjs` 修改，归属不由复核认领，不重置。

## 1. 已确认与验证边界

- 用户 v4 结果继续有效：G1/G3/G4/G5/G8/G10 PASS；G2单项目一张R55卡=正常观察；G6部分通过、收藏需补测；G7用户报告保留；G9用户确认无新agent回复=NOT_RUN。尚未收到v5 R1/R2或Android v6回填。
- v5应用清单 **591/591** hash与bytes一致，BUILD身份吻合，`package-identity.json`留档。
- 独立 **冻结v5 React页面 × 当前正式daemon/FakeWorker** 基本收藏切换：按钮/DB 0→1→0，已通过；不是只检查信封或本地日志。见`early-crash-result.json.favorite`。
- 定向integration：`hifiDraftPersistence` / `storeLinks` / `attachmentChannels`，**3文件23/23通过**。未独立重跑全量879、GitHub网络测试、R61整套三连或全部Esc演练；879/879为GLM报告口径，不改其原记录。
- **hifi typecheck退出0；主typecheck退出2、22个错误**，见`checks.json`及`root-typecheck.log`。测试绿不等于check全链绿。
- 主门失败由新增`hifiDraftPersistence.test.ts`直接导入浏览器store导致NodeNext/无DOM配置重新纳入hifi源：显式扩展名、隐式any与window诊断共22项。按Node/浏览器代码适用配置正确拆分并纳入check；不得用any、ts-ignore或把新测试移出所有类型门伪绿。
- R61三连原记录中`v5favoritesOk`、`v5quoteOk`实际均true；§4是聚合门的反例，不能反向改写这些实际通过事实。

## 2. P1：20秒未知窗口之前崩溃，原信封仍会丢失并产生重复消息

**独立真实页面反例已复现**：`early-crash-result.json`、`early-crash-probe.cjs`、`prepare-probes.mjs`。

1. 用冻结v5页面发送唯一标记的线程仅记录消息；正式daemon已提交，测试转发层只扣回执，保持产品20秒unknown窗口不变。
2. 落库后约2ms读取快照：正文已持久化，`pendingSends={}`，未出现结果未知横幅。原commandId=`cmd_h3eghgoy`。
3. 对独立隐藏BrowserWindow执行真实`forcefullyCrashRenderer()`，收到`render-process-gone reason=crashed`，测试控制器只重载自己的窗口；正式daemon和已提交事实保留。
4. 重载后正文恢复，但原commandId/重试横幅仍缺失；按实际可用的“保存记录”再次发送，commandId变为`cmd_ruemjctu`，库中该消息 **1→2**。`real_calls=0`。

覆盖边界：实际v5 React/UI资源与真实renderer进程故障，正式当前命令层/worker；测试控制器重载自己的窗口，不声称重新验证了候选main的自动重载/启动器优雅停机。

根因：RoomPage/DmPage/ThreadPage只在`await sendEnvelope(env)`返回unknown后才`parkUnknownEnvelope`。完整信封在内存中预先构建，不等于在IPC之前已耐久保存。R61草稿崩溃演练先等待unknown横幅（20秒）再Page.crash，因此仅证明已park后的恢复。

**R62必须**把完整发送意图在交给bridge之前耐久落账，区分sending/unconfirmed/已结算；重载后无法确认的在途项恢复为需人工同号同参确认，不能当普通未发草稿换新号重发，不能自动发送。已收到ok/明确拒绝与草稿、附件、队列清算要有一致性收口，避免先删信封后清草稿之间的崩溃重新暴露可重复发送内容。存储失败应明确处理，不能继续按“已安全保存原信封”提示。

三种目标共同实现，冻结原target/body/mentions/intent/attachmentRefs/imageAck/attachmentRanges/commandId及草稿代次；等待期新编辑与新资源保持。工程补：提交前/服务提交后回执未达/20秒之前/unknown横幅后/回执已达清算期间的故障窗口、切目标与多份未知队列。正式DB与信封逐字断言，最终候选交付形态至少证明“提交已成功、20秒前renderer崩溃→同号重发恰一次”。不要要求用户造竞态。

## 3. P1/P2：损坏或更高版本草稿快照被静默覆盖；普通草稿TTL偏离批准约定

`persistence-snapshot-probe.mjs`原样bundle产品store，在**自身内存localStorage**核验，结果`persistence-snapshot-result.json`：

- 支持的v1正例能恢复正文与`cmd_must_not_be_lost`。
- `v=2`不支持快照（内含完整未知信封）或缺末尾括号的损坏JSON，`initDraftPersistence`都继续`persistSnapshot()`：原记录被覆盖为空v1，未知信封丢失，`draftPersist={mode:'on',error:null}`。这是数据被销毁并伪正常，不是合理的降级恢复。
- 已保存48小时前的普通草稿仍恢复。store注释把“普通草稿亦无过期”写作既定约定，但批准的`docs/dev-briefs/prototype-default-ai-input-result.md` §3.3明确 **updatedAt + 普通草稿24小时过期**。

**R62必须**有快照schema/版本/每条字段校验与版本迁移；不支持或损坏原文先保全/隔离，显示可理解的恢复失败，不覆写唯一原记录或静默清掉未知信封。对能恢复与不能恢复的事实明确分列，不能恢复时不自动派发。沿已批准24h实现普通草稿updatedAt/过期；未确认发送独立账本不受普通TTL清理。缺上传文件的在途项不复活，说明需重新选择。无需为已明确约定再问用户。

补证：支持版本往返、未来版本拒覆盖、损坏JSON/字段损坏、读取与写入失败、24h边界、未知账本超TTL仍存在、不同数据根/用户/项目/目标隔离。保留R61原演练，修订扩张为“所有崩溃窗口”的声明。

## 4. P2：包验证器未汇总新增收藏/引用判据，非零bat退出也可通过

`scripts/verify-hifi-package-r61.cjs`计算`f.v5favoritesOk`/`f.v5quoteOk`（约217行），但约431行的`f.pass`完全未包含二者；bat判据仅`typeof f.batExit.code === 'number'`。

`package-verdict-probe.mjs`读取真实run1报告，对**原聚合表达式**作隔离负对照（不改原报告、不重新运行启动器）：

| 改动 | 原聚合判定 |
|---|---|
| 原报告事实 | true |
| v5favoritesOk=false | **仍true** |
| v5quoteOk=false | **仍true** |
| batExit.code=7 | **仍true** |
| pptxVisualOk=false（受控正对照） | false |

**R62必须**把新增项纳入最终总pass及summary，bat严格===0。收藏以实际目标消息/当前用户的DB事实+按钮状态判定，不用全库总行数代证；引用以实际目标草稿、refs、正文、摘录内容、自动呈现判定。缺项/undefined/异常不能由空集合every或兜底true放行。正式负对照每个新门都能让总pass=false且退出非零，原正常路径仍通过。无需把负对照当作重跑用户测试。

## 5. 外部资源回退与材料口径剩余

R61阶段D现已证一份文本附件在恢复根previewText成功、blob manifest复制、MD导出有该附件。接受这部分增量；**不能据此宣布远程CA/设备凭据恢复已验证**：

- 演练原根inventory只有backups/blobstore/local.token/locks，未创建remote/ CA；`remoteCaLikeFiles=['local.token']`只是正则`/ca|cert|remote/`误匹配local，不是CA证据。
- tokenHashBefore在阶段D末尾才取，随即读取比较；没有演练前基线，也没有核恢复根对应凭据；“原凭据不变”目前判据不足。
- 当前说明第4步容许最小回退新根重生凭据，与用户已批准“不换不重生CA/保留配对”的需求不能混用。补完整闭环：一致性DB快照+同批blobstore、local.token、remote/证书/设备关联事实，演练前/后/恢复根对照；恢复后CA指纹/配对归属相同。**只用独立演练身份，不触碰用户v6或真实CA**。普通服务证书因SAN变化需重签与CA更换分列，不把二者混称。
- 旧程序仍是当前源码+子集迁移模拟，边界如实；有真实旧binary则另列实际验证，不把新门或新路径重定位能力倒推给历史binary。
- 更新最终矩阵旧行（“草稿按合同不跨崩溃”、r60仅DB回退已全收口）及readiness旧v4待测状态，保留git/报告历史，不覆盖旧证据。
- 455ms是**dev Electron + daemon预先就绪**条件，不是完整便携启动器冷启动；保持分列，无需为了漂亮数字扩大实测范围。
- PPT full下Esc的原生键演练记录已读，用户现场未复现保持未复现；“最可能按了宽”只能标假设。宽模式新增语义也补实际矩形+原生键断言，不能仅按full正例泛化。无需让用户回忆或重复造焦点竞态。
- 签名价格/信誉等未核声明移为待核，当前无需用户采购或选择安装器，不作发布授权。

## 6. 长批次的后半段：补既有Git只读入口，交付一次

先完成§2–§4实质修复和证据，再按既定H3/DEV-14计划接入新界面的 **Git历史、提交差异、merge父选择**。后端`git.history`/`git.commitDiff(parentOid)`/`parentsMeta`和legacy父选择早已存在；只复用接入新UI，不重复实现，不操作用户仓库的提交/推送/拉取，不增加Git写能力。独立本地fixture覆盖根提交/普通提交/双父merge，选定父OID与返回/显示绑定，快切父/项目迟到不污染，binary/截断/省略如实，非Git目录友好。新界面git.status/diff已有，矩阵需写“历史/merge尚缺”，不能笼统写Git读视图全未接。

本批按小提交施工、统一交付结果；包含源码修复后的main+hifi typecheck与相关完整检查，失败实际登记。只交一个新独立修复候选（如v6），准确BUILD/清单/材料门，同产物必要三连及新增故障专项，零真实模型调用；v5和旧包/用户回填原地保留。

用户仍只需R1收藏/R2文件引用、摘录与宽/全屏Esc（约5–10分钟）；可先在v5测，或尚未开始时等修复候选做一次。已收到v5通过就继承，未改变的手测不要求重复。G9无自然新回复保持NOT_RUN；Android仍按现有DEV25 v6指南独立回填，不阻塞桌面工程。工程竞态/版本损坏/回退/三连自行完成，不让用户查SQL、PID或制造崩溃。

约束保持：A+Word；B不集成；零新增真实模型调用；v6用户CA/数据/RESULTS、历史证据不动；价值评价/DEV-11/并行写入延期；G5不连带宣布。当前无需新增采购/账号/设备资源。
