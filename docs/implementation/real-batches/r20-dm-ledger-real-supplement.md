# r20-dm 真实批次补充证据材料（第二十三轮四）

> 背景：主台账 `r20-dm-ledger-real.json` 的 `actualCalls=null`、成功路径 runRoot 已按
> 「证据先行→成功清理」规则删除，请求/响应模型与用量明细未入账。本材料从**仍可追回的
> 原始记录**生成；不可追回项如实注明——不编造、不覆盖原始台账、不为补文档重跑调用。

## 一、可追回的原始记录

### 1. 批次 journal（独立于 appData：`~/.zhongshuo-real-batches/r20-dm.jsonl`）

```jsonl
{"op":"batch-config","batchId":"r20-dm","cap":8,"runtimeKind":"claude","model":"deepseek-flash","at":1790779850626,"pid":15328}
{"op":"reserve","pid":15328,"at":1790779850628,"turnId":"turn_56dc97f7-ef50-47c8-ae17-578b4bbe513e"}
{"op":"settle","pid":15328,"at":1790779858952,"turnId":"turn_56dc97f7-ef50-47c8-ae17-578b4bbe513e","note":"terminal:succeeded"}
{"op":"reserve","pid":15328,"at":1790779859536,"turnId":"turn_dc56bd99-eed4-40bf-9fce-f53b78fe7162"}
{"op":"settle","pid":15328,"at":1790779866904,"turnId":"turn_dc56bd99-eed4-40bf-9fce-f53b78fe7162","note":"terminal:succeeded"}
{"op":"reserve","pid":15328,"at":1790779868484,"turnId":"turn_51e34144-5931-4d27-91c3-58e0574dc574"}
{"op":"settle","pid":15328,"at":1790779875678,"turnId":"turn_51e34144-5931-4d27-91c3-58e0574dc574","note":"terminal:succeeded"}
{"op":"reserve","pid":64208,"at":1790779876869,"turnId":"turn_dd45f618-ac76-4391-9d65-64c65598b58b"}
{"op":"settle","pid":64208,"at":1790779879875,"turnId":"turn_dd45f618-ac76-4391-9d65-64c65598b58b","note":"terminal:succeeded"}
```

**据此可确认的事实**（每条均来自原始行，非推断补充）：
- 头绑定：cap=8、runtimeKind=claude、model=deepseek-flash（与授权口径一致——请求模型）。
- 恰 4 次 reserve、4 次 settle，全部 `terminal:succeeded`；未触上限（4≤8）。
- **重启共享额度的进程级原始证据**：前 3 次（A1/A2/B1）pid=15328（daemon#1）；
  第 4 次（A3）pid=64208（daemon#2）——daemon#1 exit code=0 于 at=1790779876216
  （主台账 daemonStopFacts[0].exit.at），653ms 后 daemon#2 完成同一批次第 4 次预占。
  即：重启后额度未被重置、沿用同一 journal 计数。
- daemon#2 exit code=0 于 at=1790779881254。

### 2. 主台账（docs/implementation/real-batches/r20-dm-ledger-real.json）

17 项结果全过（A1 首开+暗号回流→A2 原生续接（请求=上报）→B 独立（身份互不相同+
输入水位属 B+回复落 B+不含 A 暗号）→重启 A3 resumed=2；startTurn 恰 4 次 succeeded；
护栏 reserved=4 rejected=0；双 daemon 优雅退出）。产物身份 buildId=bld_3b44ff4aa4551e87。

## 二、不可追回项（如实注明——原始记录已随成功清理删除，不以推测补写）

- `real_calls` 行级明细（usage tokens/成本估算、response_model 响应自报模型、
  run_id 归属列）——存于 runRoot/appData/state.sqlite，已随成功路径清理。
- provider session UUID 原文、消息正文、暗号上下文——同上（主台账断言结果仍在）。
- 逐次 daemon stderr（Claude CLI 渠道握手/会话过程日志）——未落盘（当时脚本不保存）。

**响应自报模型缺失说明**：授权口径要求「请求渠道/模型与响应自报模型分列核对」；本次
批次的台账断言含请求模型（journal 头），响应自报模型明细不可追回——登记为证据缺口，
不默认等于请求模型。

## 三、后续批次规则（已落入脚本，第二十三轮四）

清理现场前保存：real_calls 全行（含 usage/response_model/run 归属）、runtime_sessions
身份（providerSessionId）、dm 续接事件（domain_events）、daemonStopFacts——随主台账
分列落盘（`r20-dm-ledger-{mode}.json` 的 callsDetail/identities 字段）。
