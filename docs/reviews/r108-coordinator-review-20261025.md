# R108 / V51 统筹独立验收

日期：2026-10-25（Asia/Shanghai）。统筹会话 01a16d02-2621-7330-afbe-b2d116627da4，编码会话 01a16bd8-dbb4-7553-93eb-aecb1395c860。用户授权先实现 F1/F2/F3 和补交重复展示，并继续推送 GitHub。

## 交付范围与结论

四项已实现，并按下述验证边界交付：房间/串/私信共用执行状态；正式发送前保存可信原请求，异常后只读找回；任务完成/需处理的持久去重桌面通知；明确补交链的原答折叠与有效版展示。没有扩展其他九项开源吸纳建议。

最终包：`dist/desktop/desktop-daily-win-v51-r108-usability-final-20261025`。沿用已有数据用包内 **start-existing-data.vbs**，仍指向原 V44 server-data；普通 start-desktop.vbs 为另一数据入口。旧 V50 和首个 V51 候选均保留。

- BUILD：`bld_b2ef163be3dc2c99`；源基线 `4f76811d529994e6075c97f4dba28d5b5ab5e5c0`，dirty=true，如实保留打包时的未提交状态。
- dirtyDiffHash：`29d699a621d957d80f5ceffb05b26452def6dd1d32c92a3b9fb72bee8daef61d`。
- daemon SHA-256：`b98ed4b63c65f16fa2acc863735cee0532f9e53c0c15e055429ea4de4c52aab5`。
- main SHA-256：`0628693d7943c80b9cbe134eaab6340bdb23d556c366bdfc767cefb03919766b`。
- 统筹重新逐项计算 595 个程序文件的大小/hash，缺失/不符为 0；冻结源码/测试 47 文件漂移为 0。

新程序代码与交付源码通过冻结清单关联。此后新增的审查/交付文档不冒充已在此前包内编译；提交与推送由统筹统一完成，分支为 origin/codex/full-implementation。

## 实际验收

| 项目 | 独立核对的结果 | 验证边界 |
| --- | --- | --- |
| F1 执行状态 | 最终候选的房间实机显示受控成员正在查资料；完成后串中名称准确。原真实任务显示完成，performers/waiting 均0；待验收不显示成已经验收 | 在途、等待、失败等更完整状态由正式命令/worker及浏览器回归覆盖；不声称每种状态都在原用户业务上真实重跑 |
| F2 原请求找回 | 真实受控回执丢失后点查询，只读找到原消息/任务；重开保存的引用仍可查。最终界面旧红字消失、原请求单份；后续草稿/新请求错误由实际 Composer 浏览器回归验证保留 | 原生鼠标验证主要在隔离房间；房间/串/DM三类归属与零新增执行由正式命令/浏览器回归覆盖 |
| F3 通知 | 隔离夹具4条通知均有原生 show_requested/shown 回执且 attempts=1；重开前原两条发送次数与shown时间不变；新两条来自明确的新Fake任务，非旧历史补发 | **实际 Windows 通知点击未验收**；clicked_at 均空。只有主进程回调、可信定位、正式命令与组件测试，不能说已实机点击通过 |
| 补交展示 | 用户原 #3 默认显示“原答已补交 · 查看历史原文”，#4 为补交有效版；实际展开 #3 后原文、复制/引用等仍可见 | 原消息/失败/补交关系保留，不做文本相似度删除，不直接改库隐藏旧文 |

统筹实际打开查看截图 01–05、08–15；逐项核对现有15张图的hash均与同名metadata相同。**最终新BUILD证据是08–15**；01–06来自首个候选，包含找回后旧错误残留与通知内部文案的已保留反例，07是升级前V50。14实际拍到完成态，按完成态命名，没有冒充在途截图。

证据根：`dist/review-r108-usability-20261025`。统筹独立票位于 `dist/review-r108-coordinator-20261025`，含最终程序清单、原数据比较、截图hash和只读远端误写核对。

## 原数据保全

原 V50 正常关闭：exitCode=0、daemonStopResult.complete=true、forceKilled=false。统筹独立重算完整冷备 872 文件、255986849 字节，与冻结清单完全相同；不符 0。冷备目录：`dist/review-r108-usability-20261025/original-data-cold-backup-20261025-0149`。

随后只读比较冷备与已升级原库，schema 58→59；以下整表逐行序列化hash一致，包含Codex子任务的原消息：

| 表 | 升级前行数 | 升级后行数 | 内容hash |
| --- | --- | --- | --- |
| messages | 36 | 36 | 相同 |
| tasks | 11 | 11 | 相同 |
| real_calls | 23 | 23 | 相同 |
| format_repair_workitems | 2 | 2 | 相同 |
| task_deliveries | 8 | 8 | 相同 |
| project_members | 8 | 8 | 相同 |
| agent_profiles | 8 | 8 | 相同 |
| runtime_installations | 2 | 2 | 相同 |

原任务仍 DONE / revision6；真实调用仍23，活动执行0、pending outbox0。原库通知数0，未把旧完成记录补发为新通知。导航/阅读水位和新schema本身属于正常打开升级行为，未把整个数据库文件错误声称为字节不变。

## 工程检查与保留失败

- 必要相邻专项：16文件/165项通过；启动延迟→手动打开→首次发送回归：2文件/19项通过。
- 完整回归（显式排除githubSandbox）：246文件中245通过、1失败；2022项通过、1失败。唯一失败是未改动的 codexAdapterReplay 异步RPC日志即时读取断言；该文件单独复核20/20通过。原全量失败票保留，**不宣称全量全绿**。
- 实机发现旧红字残留后的最终窄修：3文件/16项通过，含实际挂载Composer的7个UI检查；两套类型检查通过。该窄修和纯文案修正后未再重复全量。
- scoped lint 38项为既有文件的HEAD同项基线，未宣称全仓lint通过。
- 隔离桌面验收使用受控Fake输出，原业务未重放；产品原库调用数未增加。

## Windows 点击验证限制

统筹读了 [computer-use SKILL.md](/C:/Users/user/.codex/plugins/cache/openai-bundled/computer-use/26.1021.31345/skills/computer-use/SKILL.md) 及其 [guidance.md](/C:/Users/user/.codex/plugins/cache/openai-bundled/computer-use/26.1021.31345/docs/guidance.md)，并独立初始化Sky、只读列出apps/windows。两处工具会话均没有返回系统通知、通知中心或任务栏目标。

该指引要求“Never reconstruct an app or window from guessed fields.”，并禁止使用Windows键快捷键。因此没有伪造窗口、使用系统快捷键或人工emit click来补票。通知原生show回执与未实际点击的事实分开记录；这项实机验证缺口保持明确，没有要求用户重复批准已授权的开发工作。

## 两次误跑沙箱测试的执行偏差

本轮明确排除了真实远端沙箱测试，但两名子代理各执行一次裸 `pnpm test`：00:44:56.811与00:49:06.512，造成实际远端写入。初步TLS失败摘要不足，后已从这两次的原工具回执和GitHub只读结果明确更正；统筹已向用户说明并致歉。不是“仅连接失败”。

涉及仓库：`384615666/zhongshuo-git-e2e-sandbox`。独立核实本轮6条测试提交：main链4c304998→3e878925→52f61d50→832b9a78，以及两个test分支61ab7f28、b5ef7c74。00:49的TLS错误发生在后续第二克隆，正式push与分支push用例已经通过。

| 远端引用 | 已核实的提交 |
| --- | --- |
| main | [832b9a78](https://github.com/384615666/zhongshuo-git-e2e-sandbox/commit/832b9a786105d4d83d097ee4b0a36a90ffdfcd92) |
| test/round12-mvmmrogp | [61ab7f28](https://github.com/384615666/zhongshuo-git-e2e-sandbox/commit/61ab7f28d9ccab06f4701bf154c0f6459c14d869) |
| test/round12-mvmmwgqm | [b5ef7c74](https://github.com/384615666/zhongshuo-git-e2e-sandbox/commit/b5ef7c7429744cb04e3ef37af08476ab88146616) |

原始工具输出、两轮命令和时间/来源hash保留在本地证据根；未将私有会话原文或凭据提交到源码仓库。统筹的后续远端动作只有ls-remote和GitHub GET核对，没有回滚/删除/补救写。

防复发：默认vitest配置排除该文件，保留明确授权才可使用的独立 `vitest.github-sandbox.config.ts`。这不改写已发生的偏差，也不把沙箱旧结果计作本轮合规验收。
