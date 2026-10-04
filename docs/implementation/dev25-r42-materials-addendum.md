# DEV-25 v5 操作材料补充说明（第四十二轮·2026-10-04）

> 背景：复核 `review-r41-next-round-20261004.md` §5 指出操作材料与真实入口/版本的差异。
> **v5 包、其 server-data、RESULTS 与截图全部原样冻结**——本说明只更正文字与入口；
> 你已完成的回填**不被作废**，**无需重新导入 CA、无需重复 D1—D10、无需重测已完成项**。
> 文字更正不影响产品行为；工程修复（旧库升级迁移、Word 验证支架）在源码完成，随下一候选包交付。

## 1. 更正清单（以本说明为准）

| # | 原文（v5 内材料） | 更正后 |
|---|---|---|
| 1 | 标题/适用目录写 v4、六项 | 本包为 **v5**（`dist/desktop/dev25-dual-win-v5`），受影响项短回归共**七项 R1—R7** |
| 2 | R7「拖入任一 .docx」 | 产品**没有拖放上传入口**（上传只接「📎附件→选择文件」）。R7 正确步骤：打开任一会话 → 点发送框「**📎附件**」→ 选样本文件 → 发送框芯片区出现「📎 …」芯片 → **点击芯片**预览。只预览即可，不要求发送消息或发起任务 |
| 3 | （v5 未随包 Word 样本） | R7 样本：`D:\zhongshuo\scripts\dev25-dual\samples\word-r7-sample.docx`（sha256 `d66f6248f6f47893ee2f9cbdcf4577838647e474cb48e91858e8ec4a38a8d809`）。已验证无隐私：3 节分页/表格/图片/页眉「众说预览选型核对——Word 富样本（三页）」；下一候选包起随包于包内 `samples/` |
| 4 | 项目名「DEV25 短回归」 | 真实种子项目名：**「DEV25 双机验收」** |
| 5 | PPT 位于「发送框芯片区」 | 回归幻灯.pptx 是**默认房间一条已发「仅记录」消息的附件**（消息正文「R40 短回归·PPT 预览样本（点击附件芯片预览）」）——R6 点该消息行内的「📎 回归幻灯.pptx」芯片。发送框芯片区只放你自己正要发送的草稿附件 |
| 6 | README 防火墙程序路径断行损坏 | 正确完整路径（单行）：`包目录\ZhongshuoDual\resources\app\daemon\node\node.exe`（daemon 的 node，**不是 electron.exe**）。成因=README 模板字面量反斜杠转义（`\r`/`\n` 成了回车换行）——模板已修复并新增**生成后字节断言**（坏路径直接构建失败），随下一候选包更正 |

## 2. 许可/NOTICE 材料补全（不改变运行时）

`licenses-preview-vendor/` 九件之外，`pptx-renderer.THIRD_PARTY_NOTICES.md` 相对引用的三份源材料
（`licenses/mtx-decompressor-MPL-2.0.txt`、`licenses/ECMA-text-copyright-notice.txt`、
`scripts/ooxml-geometry/source-manifest.json`）已从**同一钉版 tarball**（`@aiden0z/pptx-renderer@1.3.0`，
tarball 内入口 sha256 与 PROVENANCE 一致后逐文件原样拷贝）vendor 入库
（`src/ui/vendor/pptx-renderer/`，逐文件 sha256 记录于 `PROVENANCE.json` 的 `noticesMaterial`），
下一候选包起随包于 `licenses-preview-vendor/pptx-renderer-notices/`。v5 内该三件缺失=如实缺口，
不影响运行时（运行时只用渲染器入口单文件）。

## 3. 本轮工程修复一览（随下一候选包，不动 v5）

- **旧库升级 P1（review §3）**：新增迁移 042——按 `recovery.reconciled`/`recovery.protectionReleased`
  事件顺序回填历史 turn 的 `protection_state`（40→最新、41→最新均覆盖；证据损坏不默认安全；
  不清预算、不删数据；`tests/integration/legacyProtectionUpgrade.test.ts` 3 用例+既有 9 用例全过）。
- **Word 验证支架（review §4）**：`scripts/verify-word-isolation.cjs` 重写——W1 哨兵改为实际泄漏目标
  `#host-sentinel>span` 且加入「旧非隔离实现必须变红」负对照+合法样式 shadow 内 getComputedStyle
  实测；W2 真实 altChunk（aFChunk 关系+包内 HTML 部件——开启对照产生 iframe 证消费、产品关闭零
  iframe+UI 如实标注「嵌入 HTML（altChunks）首版不支持」）；W3 完整 wp:inline/pic:pic 结构+内嵌
  正对照（naturalWidth 320 实测）+外链**无拦截对照**实测（组件把关系目标按包内路径解析→不形成
  网络 URL，可达计数器零命中——src="null" 同源伪影如实记录）；W4 页眉文本/图片 naturalWidth 实测
  断言。连续两次 allPass=true（`dist/desktop/word-isolation/metrics.json`）。

## 4. 维持不变

PPT A+Word 选择、B（LibreOffice 精简内核）首版不集成不随包不自动下载；零新增真实模型调用；
v2/v3/v4 包与证据原地保留；Android 在短回归通过后按指南执行；价值评价、DEV-11、并行写入与 G5
状态维持原约定。
