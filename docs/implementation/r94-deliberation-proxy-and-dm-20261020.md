# R94：当前测试诊断、互评边界与私信布局补齐

最终便携包：`dist/desktop/desktop-daily-win-v31-r94-20261020`，入口 `start-desktop.vbs` 或 `start-desktop.bat`。

产品提交：互评修复 `03bc5cb40f4846c72a89e23399b136f9a615b989`；私信接线 `e7c60b7a3eb354da8f68bbfe380aa3471e40f72c`。最终 BUILD `bld_593a45639a67e2f5`。595 项清单全部匹配，486 项源文件打包前后保持冻结。构建如实记录 dirty=true，原有删除和未跟踪文件没有混入提交。

## 当前用户测试的真实原因

根聊天只读检查正在使用的 v29 数据根，没有修改、重放或复制业务正文给开发聊天。

- 原 AUTO 的 Claude 步骤在 18:15:50 返回 `PROVIDER_ERROR/ECONNREFUSED`。旧本机端点没有监听；子 run 只使用了 1、2 次，未发生预算耗尽。父 run 缺少 used/inflight 字段，所以界面显示“未提供”，不是用尽。
- 用户切换渠道后，18:32:42 的 Claude 请求已到新网关，错误变为 `503 No available channel for model newapi/deepseek-flash under group default`，证实新渠道配置已经生效。
- 只读模型目录返回 `deepseek-flash`、`glm-5.3-flash`；众说成员仍显式绑定旧名 `newapi/deepseek-flash`。需在“成员管理 → Claude → AI 设置”选择 `deepseek-flash` 并保存。根未代改全局或成员配置，没有用新推理请求声称已经成功。

本轮没有提高 24/14 的预算上限；父 run 的预算统计展示另列待完善项。

## 互评修复

Claude 首稿失败后只剩 Codex 一份有效初稿。旧流程仍派发 CR，排除自己的稿件后待评审集合为空，但 schema 要求至少一条评审，随后模型错误引用了派生 MD 的伪 claim。canonical 初稿没有被 MD 篡改。

- 只有一份有效初稿时跳过空对象互评；主持者可执行时按完整 canonical 初稿整合。
- 主持者失败、缺席或不可用时明确阻塞，保留已有稿件，并通过 `run.stepFailed` 中文消息显示原因；不自动换主持者或重唤失败主持者。
- DELIB 各阶段的通用附件排除自动派生的 `detail:true` MD；用户明确上传的普通文档和图片仍可用。阶段自身完整 canonical 输入不变。
- CR 组装和提交使用同一冻结他人初稿集合；拒绝 self、迟到未冻结稿、错误 revision、MD 伪 claim。原 claim 校验未放宽。
- RAT 不自动重派失败成员；失败席位仍计 missing，不伪造全员同意。

旧任务、失败/UNKNOWN 记录和用户原始数据保持原地，不自动重跑。

## 私信补齐

用户追问后确认：私信原本已共用 MessageView、Composer 和底部附件预览，但漏接 `is-replies` 布局与 `readingAids`，因此新版阅读样式没有完整生效。

仅在 DmPage 接入共享消息布局、msg-item 和 readingAids，移除覆盖共享间距的内联 padding。私信现在同样使用紧凑靠右用户气泡、消息间距、操作栏、长文折叠、大纲和字段表格。底部附件直接打开保留。发送、读取、已读、恢复和后端逻辑未改变。

## 验证

| 检查 | 结果 |
| --- | --- |
| 互评相关回归 | 9 文件，88/88 通过；identity 最后修正后 11/11 |
| 根独立全量 | 193 文件，1427 通过、1 个旧夹具失败；原始结果保留 |
| 唯一失败处理 | r90ThreadDeliberation 固定取第一稿导致自评；只修夹具选取本次 peer，根独立补跑 3/3 通过，未改产品源，未重复全量 |
| TypeScript | 两套检查通过；测试夹具修正后再次主 typecheck 通过；私信接线后 hifi typecheck 通过 |
| lint | 七个互评改动文件通过；DmPage 第173行缺 react-hooks/exhaustive-deps 规则为既有基线，不宣称全库 lint 通过 |
| 私信与阅读回归 | 23 项渲染检查、19 项 dmDirect 集成检查通过 |
| v31 副屏官方 BAT 隔离包 | 76 项通过，含真实私信布局与紧凑气泡检查 |
| v31 协作行为 | 94 项通过；无交接2次、有交接3次合成 turn |
| 附件与输入 | MD/表格/CSV/TXT 点击预览、另存原字节、重开、5秒刷新、IME、光标及线程/私信独立草稿通过 |
| 最终产物 | 595/595 manifest；486 项源冻结前后匹配；无 server-data/数据库/测试数据 |

最终包测试仅使用合成材料和 FakeRuntimeAdapter，`real_calls=0`。窗口位于非主屏；没有使用系统鼠标、键盘或剪贴板。v30 是先前已验收的独立候选并保留，最终交付以补齐私信的 v31 为准。

证据目录：

- `dist/review-r94-current-test-20261020/`：只读诊断、工单、独立审核、原全量日志及补跑。
- `dist/review-r94-worker-20261020/`：实施与私信跟进报告。
- `dist/review-r94-dm-20261020/`：最终源冻结、产物核验与私信副屏检查脚本。
- `dist/review-r94-dm-package-20261020/latest-result.json`：76 项 UI 检查及私信截图。
- `dist/review-r94-dm-r92-20261020/result.json`：94 项协作行为检查。

迁移001–057、全局 Claude/Codex/CCSwitch/网关/凭据、reset credit、执行权限默认值均未修改。原受保护的四个 dbg 删除、未跟踪 .codex 目录、用户设计资产和其他文件保持不动。
