# DEV-25 第四十四轮材料口径补充（2026-10-04）

依据 review-r43-next-round-20261004.md §6。**v6 包及其 README/模板/RESULTS 原件不动**（用户
正在验收）；本说明为独立补充，源码模板已同步修复、随**下一候选包**生效。

## 1. 本轮只测四项——v6 包内 README 尾部「七项」表述以本说明为准

- v6 包内 `README-双机验收.md` 尾部仍写「七项回归」、`RESULTS/SHORT-REGRESSION-template.md`
  仍列 R1—R5 空行——**以 docs/implementation/dev25-short-regression-guide.md（已四项化）与本
  说明为准**：本轮只测 **R6/R7/V1（相邻视图切换）/V2（监听显示）**；R1—R5 已按 v5 范围收案
  （正式记录=v5 包 `RESULTS/SHORT-REGRESSION.md`），不重复、不重测；D1—D10 按 v2 收案。
- 源码已修复（`scripts/make-dev25-dual-package.mjs`）：SHORT_REGRESSION_TEMPLATE 改四项表
  +「本轮只填四项」声明；README「短回归与结果」节改四项并注明 R1—R5 沿用 v5。
- 已有回填不覆盖；不因材料修订要求重新导 CA 或重跑七项。

## 2. 操作提示更正

- **预览面板高度调节**：点「⤢ 展开预览」放大；手动拖拽=面板**右下角**的原生 resize 手柄
  （**只有右下角可拖**，不是任意下缘都可拖）。
- **V2 收尾（必做）**：若测试中把监听应用为「仅本机（127.0.0.1）」，结束后在面板改回
  **局域网（0.0.0.0）**并确认 LAN 地址恢复可达——避免 Android/远程测试因遗留回环监听受阻。

## 3. 尺寸记录口径（工程报告自此统一）

- 尺寸一律 **宽×高**（例：宽屏 DM 消息区=1680×949；此前「949×1680」为顺序误记）。
- **最大高度（max-height）与实际高度（getBoundingClientRect().height）分别记录**，不混称、
  不以 CSS 上限冒充实测（例：预览面板展开 maxHeight≈658px、实际 h≈595px；Word 视觉盒实际
  353→448px）。常规窗口（1280×800）与宽屏（1920×1080）分档注明，不混称同一次采样。

## 4. v6 构建 dirty 快照与最终提交的对应

- 真实元数据（`v6/ZhongshuoDual/BUILD.json` 原值保留，不改写为伪 clean）：
  commit=`8f49f5c5…`、**dirty=true**、dirtyDiffHash=`4fa3b1b0363c88c491b3fa6f44648e876dc
  ae899c141ae033c9e825c0bbdcbd0`、builtAt=2026-10-04T04:34:34Z。
- 对应结论（证据 `dist/desktop/review-r44/build-dirty-correspondence.json`，第四十五轮按
  review-r44 §4 修订计数与措辞）：v6 构建时工作区 = `8f49f5c` + **ab89219 的全部变更内容
  （25 文件=21 修改+4 新增；其中二进制 docx/pdf 8 件全部为修改，文本 17 件=13 修改+4 新增）**
  ——只读重建核对：脏路径集 25=25（21 ' M' + 4 '??'，与 ab89219 变更集完全一致，无杂散脏
  文件）；**13 个修改文本文件**的差异内容与 `git diff 8f49f5c ab89219` 同文件集**逐字节一致**
  （cmp 首差异恰在二进制 fixture 段起点）；4 个新增文本文件构建时未跟踪（不在 diff HEAD，
  仅 porcelain ?? 行）。
- dirtyDiffHash 的完整成分**不能完全重建**：构建时的 diff/status 字节未单独留存，8 件二进制
  fixture 的检出转换（git 按文本处理+autocrlf）不可逆推构建时字节——BUILD.json 留档值为唯一
  真源；同源性另有 renderer 三源逐字节一致、冻结清单 588/588、冻结三连同 buildId 独立佐证。
- 不为更换标签要求用户重复手测；v6 手测结果按其构建/设备范围保留。

## 5. 同轮工程收口（详见 continuation.md 第四十四轮快照）

迁移 044（完整释放证据校验+probe/reason 不互相覆盖，已应用 043 的库兼容修复）；DM 返工
manifestHash+用户所见快照绑定（dmReviewContract 真实 fake 链测试）；DM 下显式工具入口统一
视图状态（verify-ui-hidden-layout U6）。零新增真实模型调用；v5/v6 包与既有证据原地保留。
