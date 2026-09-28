{
  "note": "真实研讨运行（task_1527be0a/run_447e0df9）派生证据记录",
  "original_files": {
    "state.sqlite": "97e8d54f8a7255106f66cf1b213c4a4d7b558d21310b1c2bfedc3d0d526dddda",
    "state.sqlite-wal": "f2eda30ee3f20fed367af7f0c9ea90a5fd76a35eaae1364f736ef9c00573ad32",
    "state.sqlite-shm": "b3a2c4b2aea37468c6e27892bef6ab17b313c56df4706a86147f19bacb981cb5"
  },
  "rebuild": {
    "tool": "手工 WAL 帧重放（python struct 解析 492 提交帧，按 pgno 最新覆盖写入 147 页；journal-mode 字节改 rollback）",
    "output": "rebuilt3.sqlite",
    "output_sha256": "8c8b9dda216b44ffa845bf1b37275f780fc2fe7fc117b78f8512cd5bc5dc3034",
    "procedure": "复制原三件 → 逐帧解析 WAL → 重建独立 DB → better-sqlite3 打开验证 50 表"
  },
  "conclusion_sources": {
    "来自原始记录": "v1 审计 29/29（运行后立即在原库执行）、run.progress/report.get 观察快照、usage 7 turn",
    "来自重建结果": "v2/v3 审计（56 PASS + 2 NOT_APPLICABLE）、报告/矩阵/预算明细",
    "不可据此推断": "渠道侧精确计费、未被提取的完整事件时间线"
  },
  "run_identity": {
    "taskId": "task_1527be0a-b4d5-494c-8e64-5fc8aa91c28d",
    "runId": "run_447e0df9-7e0a-45e4-96cb-a22df75dd719",
    "codeRev": "36c19de"
  }
}