# R106 统筹核对记录

日期：2026-10-24（Asia/Shanghai）。统筹会话 `01a16d02-2621-7330-afbe-b2d116627da4`；编码会话 `01a16bd8-dbb4-7553-93eb-aecb1395c860`。

**当前结论：R106 / V49 本轮验收与交付收口通过，开源源码比较已独立完成。** 1933 项最终测试通过；595 项包清单独立通过；Codex 原 DM 与单独房间请求均已得到本人可见回复。最终文档、原输入偏好恢复、沿用原数据的启动入口与备份均已核对，下方未通过的旧阶段记录均保留历史含义。

## 用户范围与分工

用户要求：去掉房间名前的 #；房间主池长正文只显示几行并可进入串内看全文；排查 Codex/DeepSeek 在房间及私信不响应、Claude 单独持续工作；本人研究指定开源项目；修复多项目房间无法直接切换。

用户另明确允许编码会话使用多个 `deepseek-flash / max` 子代理查找与修复，并明确开源项目由统筹本人阅读。已将四项产品问题实际派给编码会话，唯一用户 UI 操作者为编码主代理。按编码回报，三个准确 `newapi/deepseek-flash / max` 子代理已实际成功启动，分别负责正文、项目切换与 Codex 指纹。没有将工具元数据未列出该模型误记为调用失败。

开源研究已由统筹本人完成：[源码比较](r106-open-source-comparison-20261024.md)。没有执行对方安装脚本或将外部项目引入生产。

## 已独立核对的原现场

证据：`D:/zhongshuo/dist/review-r106-product-20261024/initial/evidence.json` 与同目录在线一致性备份。运行版本仍为 V47，数据仍在原 V44 的 `server-data`。

- 房间任务 #4：`task_645995ee-1124-421e-921a-1df002510959`；run `run_3bd033dd-d2a5-41c5-bbb7-38e059531abb`。初始快照时 task BLOCKED、run PARTIAL/PUBLISH，已经自然结束，无需强停。
- Codex 在该任务没有 turn、没有真实模型调用。事件 seq246 `run.stepFailed` 明确为启动前“有效执行配置已变化；未沿用旧会话”。
- Claude 五次真实调用全部成功，阶段为 INDEPENDENT → SYNTHESIS → RATIFY → SYNTHESIS.r1 → RATIFY.r1；并非双方均成功参与。
- 发布事件 seq396 明确 `overallConsensus=unconfirmed`、`deliveryStatus=blocked`，不能将其改称完整双人研讨成功。
- 私信“你好”任务 `task_80cdd749-571b-4b59-b375-3c44ea84a90e` 同样 BLOCKED、零 run/turn/真实调用，seq250 `task.contextAssemblyFailed` 为同一配置拦截。
- 初始已保全文档 25,556 字节，SHA-256 `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2`。这是 R106 用户后续任务的现场，不能用 R105 的 21,423 字节旧版本代替。

## 已发给编码方的审查要求

1. 未发起模型调用、排队占用、结果未知和真正上游无输出分别呈现；保留原有文档与失败，不重播整段业务。
2. 两人研讨因另一成员明确配置/能力失败而仅剩一份初稿时，不能无声继续多轮单人整合和自确认；保留成果并解释缺席/未完成，恢复仅处理未完成部分。
3. 稳定语义噪声与真实模型/渠道/权限/MCP 变化分开验证，不能自动刷新旧快照来绕过校验。
4. 当前 WIP 引入 Codex v2 hash：需明确旧 Codex 指纹版本及精确 v1 兼容，防止算法升级使所有稳定旧冻结任务失效。
5. 当前 WIP 引入零模型调用的配置准备：准备期间的真实执行配置变化须拒绝本次提交并保留输入，只允许可明确归属的初始化元数据变化；校验并发、异常与有界关闭。
6. 正文折叠保留原文、附件与复制/引用，窄窗按实际布局验收；同名房间跨三个项目连续/快速切换，以真正鼠标点击验收。
7. 只读复核导航补丁时发现 `persistNav` 的异步 bridge 导入后重新检查，会在外层释放导航意图/清除 open 状态后跳过正式 `navigation.set`。已要求补齐服务端偏好持久化和新导航使旧写失效的回归，不能只验证 localStorage 或地址栏。
8. 统筹已查看 V48 阶段截图 02/03：标题图标与用户正文折叠正确，但窄主池的 `primary.detail` / `root-next` 长交付摘要仍可占约十行。已要求同范围的辅助长摘要也有界，完整内容留在串/详情，不能只截原用户正文。
9. 编码主代理复审另发现 0-run DM 第二次显式恢复可能撞固定 dispatch key，以及配置准备返回到提交冻结之间缺少配置 receipt 绑定；已改为独立恢复意图键与事务内 receipt 复核，没有更新旧 scope 或绕过 UNKNOWN。

## 本地提交例外

施工中 HEAD 新增 `138e99966cc1c7c21a9096cd96740b8318ca80f2`（`fix(nav): preserve cross-project room open ownership`）。来源已确认为导航子代理 Avicenna 的本地提交，统筹独立核对仅包含 `src/ui/hifi/loader.ts` 与 `tests/browser/r90SidebarRooms.test.ts`，其余原有 WIP 仍保留。统筹另通过 `git ls-remote` 核对远端仍为 `ef03b4dddd22806976a220554c8a56ba9bc0d378`，本地 0 behind / 16 ahead，没有推送该提交。没有 reset/revert 或重写历史，后续导航 WIP 亦保留进最终包。统筹未执行任何提交或推送。

## 当前验收状态

最终采用 V49 / `bld_49b786e55f9b69ef`，原生窗口路径指向 `desktop-daily-win-v49-r106-final-20261024/ZhongshuoDual/electron.exe`。统筹已核对最终源码回归、包完整性、独立新取的 UI 图与 metadata，以及实际数据库中的调用、可见回复、文档和占用事实。R105 / V48 阶段证据没有代替最终 V49 证据。

历史阶段：V48 / `bld_8a9e6ee64bfe59fd` 仅为阶段候选。首个并发全量 1924 项有 5 项失败；中途单进程全量 1931 项仍有两个显式 v1 用例失败，后续相关源码修复后定向导航/scope 28 项通过，V48 稳定全量 1931 项通过。之后又补齐 receipt/重复 0-run 恢复与长辅助摘要，最终以 V49 的新测试和新图验收。上述失败与中间日志原件全部保留。

V49 的 595 项清单由统筹独立重新计算，无不符；daemon SHA-256 为 `f56a44ae228c240b9f5c6820643324a09c8d2e90569793857bec1eb6b1a30501`，记录在 `coordinator-manifest-v49.json`。已读取 `full-suite-receipt-final.log`：231 文件 / 1933 测试通过，排除具有外部副作用的 githubSandbox。双类型通过，commands / Room 的 22 项既有 lint 未冒称全仓通过。

**V49 首组误标截图已重采**：统筹实际查看旧截图 07/08 后发现均为空白的 VoiceMeeter-backup 房间；进一步计算 07/08/09/10 四张 JPEG 的 52,477 字节内容与 SHA-256 完全相同，配套四份 TXT 也相同。误标原件保留并作废，对应事实使用新 verified 文件名逐场景重采。旧组原件没有用来证明长正文/辅助摘要/原房间失败提示。

编码方确认是 `r106SaveUi` 跨 REPL cell 捕获旧绑定，旧 04–12 helper 票均保留并撤回相应场景证明，详见 `evidence-errata.json`。统筹已实际查看新 `verified-01/02`（原 DM 未派发/收到 Codex 回复）、`verified-04`（窄卡正文五行和辅助摘要三行）、`verified-06/07`（第二/第三项目）、`verified-09`（单独 Codex 房间可见回复）。对应 metadata 绑定 V49 窗口路径、build、route、独立文件 hash；04–07 图片实际 hash 已重新核对一致。

**Codex 房间可见回复已补齐验证**：双成员 root `task_0d669626-32e9-41b9-9025-12f163745cce` 已 DONE，但按 R104 短交流策略只发布主持者一条合并回复；这没有被用来声称 Codex 本人可见回复。随后仅 @Codex 的新根 `task_b35adcf9-0638-401c-a915-39956237b075` 为 DIRECT / DONE，数据库真实消息作者为 Codex、正文为 `R106_CODEX_ROOM_OK，已收到`，统筹同时查看了 verified-09 实图。

## 统筹最后只读状态核验

记录：`dist/review-r106-product-20261024/coordinator-final-state.json`。

- 新增真实调用共 5 次（账本 id15–19），4 次成功、1 次短答/claims 输出合同错误；该失败在同一运行的有限 `.fx` 补交后成功。原失败未删除或改成成功。
- 原 DM 旧 scope 的原始字符串逐字节相同，前后 SHA-256 均为 `90d198a99fc157ccc93438aad439ef1275f0c223029dde38229d791ce0721927`。
- 原房间 #4 仍为 BLOCKED、原 5 次调用不变，原业务未被重做或伪造完成。
- 需求文档仍为 25,556 字节、SHA-256 `744d45626e056c061facf05f6a0632ab18d80b63298983a7e95364d9b70ab3d2`，与最初取证一致。
- 全库在途 / UNKNOWN turn 为空，未释放写租约数为 0。
- 现有启动设置 `ui.autoOpenProjectPath` 的优先级保留；已设置默认项目 A 时，正常重开回 A 不作为跨项目点击回归。正式导航偏好对 B / C 的 revision47 / 48 另有记录。

最终报告：[R106 产品修复与验证](r106-product-repair-20261024.md)。交付包：`D:/zhongshuo/dist/desktop/desktop-daily-win-v49-r106-final-20261024`；沿用原数据入口 `start-existing-data.vbs` 已实际读取核对，仍指向原 V44 `server-data`，旧目录需保留。最后在线备份 `final/state.sqlite` 的实际 hash 与 `final/backup-record.json` 相符，完整性检查记录为 `ok`；最终 daemon 文件仍匹配前述独立核对 hash。续工文件顶部已指向本轮 R106，原两人独立研讨输入偏好已恢复。
