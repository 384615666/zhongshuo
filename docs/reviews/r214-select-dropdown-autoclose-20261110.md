# R214：AI 设置下拉选中后不自动关闭（1.0.3）

用户 2026-11-10 带截图反馈：在「AI 设置」里选择渠道后，对应的下拉选项不会自动关闭（截图里 Codex 已打勾、列表仍展开）。要求修复后打包发版。

## 根因

设置行写成 `<label className="field"><span class="field-label">渠道</span><Select/></label>`。`Select` 是自绘 listbox：一个 `role="combobox"` 按钮 + 展开时渲染在同一个容器里的 `.select-pop` 选项列表。选项是普通 `div`（非 HTML 的交互内容）。

点击选项时浏览器的事件顺序是：

1. 选项上的 click 冒泡到 `<label>`；因为选项不是交互内容，label 的激活行为向标签内的 labelable 控件（这里的 combobox 按钮）**补发一次 click**；
2. React 的 `onClick` 在根容器（label 之上）的冒泡监听里执行 `pick()`：先 `setOpen(false)`，再 `onChange`；
3. 但第 1 步补发的按钮 click 已经（或随后在同一个任务里）把 `open` 切换回 `true`，列表重新展开，按钮的 `aria-expanded` 仍是 `true`。

用最小 Electron 页面复现并留证：`<label><div id="opt">…</div><button id="btn">` 中 `opt.click()` 的事件序列为 `option-click → button-click`（后者的 `isTrusted=false`、`detail=0`）；该行为对真实鼠标点击同样成立，属 HTML label 规范行为，不是 React 状态问题。用户看到的结果与截图完全一致：值已经变了，列表还在。

项目内所有 `Select` 都套在 `<label>` 里（AI 设置渠道/权限、思考等级、添加 AI、模板编辑、成员状态筛选等），所以问题不止渠道一处。

## 修复

`src/ui/hifi/components/ui.tsx` 的 `Select` 根容器增加捕获阶段的 `onClickCapture={(e) => e.preventDefault()}`：

- React 18 的合成事件捕获监听挂在根容器，**先于**原生事件到达 `<label>`；此时 `preventDefault()` 设置 canceled 标志，label 的激活行为被跳过，不会再补发点击；
- 放在冒泡阶段的 `onClick` 无效——那时 label 已经补发过点击；
- combobox 按钮自身的 `onClick`、选项的 `onClick`、键盘 ↑↓/Enter/Esc、外部点击关闭都不变；`preventDefault` 只跳过 label 转发这一次默认动作。

没有改 HTML 结构、数据、命令、权限、命令面板或 schema。

## 验证

- 新增 `tests/browser/selectAutoCloseR214.test.ts`：真实 Electron 渲染 `Select`，覆盖 label 内/独立下拉、鼠标点击、键盘 ↓+Enter、选中当前值、关闭后再次打开；1 个用例 9 项断言。**同一用例在未修复的 `dist/r212-source`（1.0.2，`ceccd48`）上失败，修复后通过**，证明回归用例能抓住该缺陷。
- 新增 `scripts/capture-r214-ui.cjs`：隔离数据 + 假运行时 + 真实 daemon 渲染完整界面。修复前（`dist/r214-ui/r214-before4/`）渠道、权限模式、成员状态筛选、截图场景 4 项“选择后自动关闭”失败；修复后（`dist/r214-ui/r214-after/`）8 项检查全部通过（思考等级在夹具里没有可选项，记为跳过）。前后截图为 `02-after-picking-channel.png`：修复前 Codex 已选中且列表展开，修复后列表收起。
- 相关定向测试 7 文件 / 55 项通过：`selectAutoCloseR214`、`memberChannelsR136`、`threadReadingAids`、`messageQuoteReadR127`、`settingsSinglePageR157`、`callBudgetSettingsR98`、`executionConcurrencyR153`（`--maxWorkers=4`）。
- 完整默认套件（`--maxWorkers=4`）389 文件 / 3489 项：386 文件通过、2 跳过；3470 项通过、3 预期失败、15 跳过。唯一失败 `ledgerLifecycle` 的 daemon 停止时序断言在单文件复跑 6/6 通过（另一次全量运行该文件也通过），属并发负载下的既有 flake，与本轮 `Select` 改动无关；不冒称单次全量全绿。原始日志 `dist/r214/full-tests.log`、补跑 `dist/r214/ledger-recheck.log`、定向 `dist/r214/focused-tests.log`。
- 根工程与 hifi `tsc --noEmit` 0 错；本轮改动文件 ESLint 0 新增、`git diff --check` 通过。
- 未调用真实模型；未安装、升级或卸载用户程序；未操作用户运行数据。

## 交付

版本升 `1.0.3`（`1.0.3.65535`），操作手册版本行同步，首页与 README 按既有约定不在本轮改动范围（另一轮 R213 已让主页自动指向最新 Release）。源码提交 `1507b417fb9b18d79633b897a0390290a8cba8e0`（基于主页 R213 的 `ed01a6e`）。

构建使用仓库内 ignored 开发工具目录的 Node.js `24.22.1`（`dist/r212/tools/node2422`）与 Inno Setup 6（`dist/r212/tools/inno`）。内部便携装配 BUILD `bld_98fc90aad82d8fef`（clean）；安装器 BUILD `bld_d882507eae9bbd8f`（clean、670 文件、`runAsNode=false`、`privacyScanPassed=true`、`dataFilesIncluded=false`）。安装包 `dist/installers/Zhongshuo-Setup-1.0.3-x64.exe` **160,960,921 字节**，SHA256 `e0039942b2236bd3494d87508c13664f6c2a3f63c5cbfadef11354a33905ffe4`，未签名，附 `.sha256`/`.release.json`；文件资源版本 1.0.3。

安装镜像隔离检查 **21/21** 通过：干净源码构建、670 文件逐项 SHA256、禁用 Node fuse、随包 setup 只读计划、daemon 正常退出、零真实模型调用；未运行安装器、未安装/升级/卸载用户程序、未操作用户数据。

发布：tag `v1.0.3` 指向 `1507b41`（已推送 main 与 tag）；GitHub Release「众说 1.0.3」draft=false、prerelease=false、Latest=true：https://github.com/384615666/zhongshuo/releases/tag/v1.0.3 。exe、`.exe.sha256`、`.release.json` 三项上传后服务端 digest/size 与本机一致，公开下载 302→200、Content-Length=160960921。发布证据为 ignored 的 `dist/r214/published-release.json`、`uploaded-assets.json`、`public-download-headers.txt`。未运行安装器、未安装/升级/卸载用户程序、未操作用户数据。
