# H1 v2 版本时间线与可选自检说明（第五十一轮 R51，2026-10-04）

> 依据 review-r50 §3：第49轮独立记录 v2=`bld_5f1b092fed6e6240`，现目录为
> `bld_f152ca66662dc4ab` 且与最终 r50 测试副本 591 文件逐字节一致——不能再笼统说
> 「整个 v2 零接触」。本文按事实澄清时间线、明确冻结边界与自检现状，不改写用户包。

## 1. 版本时间线（按可核事实）

| 时点 | 事件 | 事实依据 |
|---|---|---|
| R49（提交 `bbb6a2d`） | 首个可短测 v2 交付 | buildId `bld_5f1b092fed6e6240`（r49 复核记录） |
| R50 打包边界收口 | v2 **原位重建**为 `bld_f152ca66662dc4ab`（pack-desktop 退出码检查/seed 入库/模板 writeIfAbsent/自检脚本随包） | 该时点用户尚未开始体验：RESULTS 只有模板与 seed.json（无用户回填）；server-data 由重建后的启动/种子重建，非工程对用户数据的改写 |
| R50 同日晚（同轮收尾） | 追加写入 `seed/h1-self-check.cjs`（新自检）与 `run-self-check.bat` | 文件 mtime 2026-10-04 21:38/21:41（本地）——**工程失误**：bat 仍引用旧 `seed\self-check.cjs`（远程导出脚本，要求 `--appdata`），新脚本未接线 |
| R50 严格三连 | 独立副本 r50-20261004144010 allPass；副本与 v2 的 591 清单文件逐字节一致（r50 复核独立核实） | 591=应用清单（ZhongshuoDual 内），不含 bat/README/RESULTS 等外围文件——外围差异不影响「同产物三连」声明，但「v2 零接触」只适用于**应用清单范围** |

结论：**「v2 零接触」的准确口径 = 591 清单文件自 R50 重建后未再被工程改动**；外围
说明/脚本在 R50 内有追加写入（其中 bat 是失误）。用户数据（server-data/RESULTS 回填）
没有被工程清除或改写。

## 2. 当前 v2 的已知外围缺口（如实登记，不在原位修）

1. `run-self-check.bat` → 调用旧 `seed\self-check.cjs --pkg` → 实测输出 usage、退出 1
   （r50 复核现场运行证实）。**用户现在不要运行这个可选自检**——启动主链（start-server.bat）
   不依赖它。修复（bat 改指 `seed\h1-self-check.cjs`，已随包）在**下一个必要候选包**统一生效。
2. `RESULTS/SHORT-TEST-template.md` 为 R49 重建时 writeIfAbsent 保留的旧文案（T4 仍写
   「断网」、无 NOT_RUN 选项）。按现行口径：T4 未触发记 NOT_RUN，不要求断互联网；
   T2 明确 @Guide A、T3 新建 +Guide B 空闲会话——以本说明为准，模板不原位覆盖
   （用户可能已回填）。
3. README-H1 的自检段落在下一候选同步；其余内容（启动/五项短测/构建身份）仍然有效。

## 3. 冻结边界（自本文件起生效）

- v2 的应用、server-data、RESULTS **原地稳定保留**；工程验证一律在独立副本。
- 后续打包（H2 候选等）**输出独立目录**：`make-hifi-h1-package.mjs` 已改为显式
  `[outDir]` 参数，且拒绝向含用户回填（RESULTS 内非模板文件）的目录输出；不再固定
  原位覆盖 `hifi-h1-win-v2`。
- 旧危险验证器 `verify-hifi-package.cjs` 已加硬拒绝守卫（默认 exit 2）；严格验收入口
  = `verify-hifi-package-r50.cjs`。

## 4. 用户体验期间的补充口径

用户按 README-H1 五项体验 v2（T1/T2/T3/T5；T4 未触发记 NOT_RUN）。第五十一轮起 H2
源码施工（回复串/附件/深链）不影响 v2 运行；体验反馈集中处理实际失败，不要求重跑
已通过的 Windows 测试。
