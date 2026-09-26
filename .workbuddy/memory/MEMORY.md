# 众说原型项目 · 长期约定

## hifi-prototype 改造与验证工作流（改 UI 都走这套）

1. 改 `hifi-prototype/src/**`（页面在 `src/pages/`，样式在 `src/styles/`）。
2. `cd hifi-prototype && npm run build` —— tsconfig 开了 `noUnusedLocals`，未使用的导入会直接构建失败。
3. 起桌面端（GUI，后台跑）：`npx electron . --remote-debugging-port=9333`。
4. 跑验证：`node scripts/verify-*.mjs` —— 都走 CDP 9333；脚本开头会 `Page.reload` 并清 `zhongshuo.nav.prefs.v1` 重置种子状态。
5. 截图：`node scripts/shot-files-git.mjs`（或其他 `shot-*.mjs`）→ 落在 `screenshots-desktop/`。
6. **验证脚本按"文案 + 结构选择器"断言**，所以改结构必须同步改脚本，而不只是"对一下选择器"：选择器变更（如 `.thread-tab` → `.seg button`）、默认态变更（如 diff 默认收起要改成"点开后再断言"）、以及"先选中再断言"的顺序。

## 该原型的视觉与行为硬约束（改布局前必读）

- `docs/zhongshuo-frontend-visual-implementation-v1.md`：§4「应用导航之外最多并排两个内容区域」（所以页面内不做三栏）；§5.5 内容页签 / 分段控件规格；§5.8 主按钮规格。
- `docs/zhongshuo-development-design-v1.md`：§17.7「文件与 Git 两标签合页」与页内项目选择器必须保留；§14.2 用户已有改动不顺手提交、冲突不给一键覆盖；§10.5 验收只在任务交付、Git 页不做 commit 级审批。
- 状态只在一条状态条里说一遍；只有调试性标注可以收进 tooltip，保护性说明（§14.2）与关键入口（§10.5 的查看交付详情）必须常驻。
- **「文件与 Git」页的滚动口径（2026-09-26 第二轮反转，别再按旧口径做）**：
  - **不要以"全页只有一条滚动条"为目标**。此页要的是"左边选对象、右边看详情"互不干扰 —— 左右两栏**各一条**纵向滚动条，滚一侧不动另一侧，滚到底也不拖动外层页面。
  - 高度契约：`.page.fg-page`（flex 列、自身不滚动）→ `.fg-body`（flex:1; min-height:0; grid 300px 1fr）→ 左右 `.fg-pane` → `.fg-pane-head`（flex:none）+ `.fg-pane-scroll`（flex:1; min-height:0; overflow-y:auto）。**不写 62vh 之类固定高度**。
  - 吸顶遮挡的正确修法是**让页面本身不滚动**（吸顶失去意义），不是提 z-index、也不是给多个元素同一个 `top` 值。
  - 右栏**只有一个**主滚动容器：共享预览的 `.preview-body` 直接当宿主，外面不再套一层。
  - 窄窗口（<1100px）走"列表 → 详情 → 返回列表"，不要把长列表堆在详情上方。
- **验证脚本迁移原则**：改的是**取数方式**（选择器 / 视图切换 / tooltip 属性），**绝不删保护性断言**（§14.2 / §14.5 / §10.5 / §17.7）来把测试跑绿。
