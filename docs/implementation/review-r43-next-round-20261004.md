# 第四十三轮复核与第四十四轮建议（2026-10-04）

基线 `ab89219`。本次只读核对代码、包、原始报告及专项证据，运行相关测试和独立反例；没有修改产品代码、v5/v6包、演练数据库、用户回填或截图。新增复现文件位于 `dist/desktop/review-r43/`，窗口探针为独立隐藏窗口，无产品桥。

## 1. 手测可以推进：v6只补R6/R7/V1/V2

用户可先用v6的新演练数据做四项布局/预览/监听补测；以下旧证据与桌面操作边界由GLM在独立环境继续修，不要求用户反复做R1–R5或D1–D10。当前不需要重选组件或准备新资源。

实际启动提示：先正常关闭v5窗口，再双击 `D:\zhongshuo\dist\desktop\dev25-dual-win-v6\start-server.bat`，避免两个同名窗口混淆。四项主要在服务机桌面完成，**无需为这四项立刻重新做另一台Windows的CA导入与配对**；远程设备访问v6时才按新CA核对和授信。

R6样本按v6指南进入默认房间→样本消息回复串→根附件芯片；R7使用包内samples。拖拽原生resize手柄位于面板**右下角**，不是任意下缘都可拖。V2若应用了仅本机模式，结束后恢复LAN并确认实际可达地址，再进行Android，以免下一步因测试遗留的回环监听无法访问。

## 2. 已核实的改善与交付事实

- 全局hidden规则已加入，预览/主池/输入区可真正收起；DM与预览打开时工具区让位。现有度量报告支持修复方向，不代用户宣布阅读体验已通过。
- 588/588文件从**冻结清单**独立核对实际v6字节/长度，无缺失或不符；buildId=`bld_881e3b4256a10e93`。
- 当前已提交源码的 app.js/index.html/style.css 与v6实际三个文件逐字节一致。
- 三个原始完整报告同build，161项且0 fail：`v20261004043435-wlcn8t` created、`v20261004044330-2sigks` reused、`v20261004045214-m4f4vk` reused。
- 本次独立跑 `legacyProtectionUpgrade.test.ts` **4/4通过**；没有重跑全部847项。
- 原始布局metrics中宽屏消息区为 **w=1680、h=949**；普通1280×800窗口的Word视觉盒h=353→448，面板展开maxHeight约658，**实际h=595**。报告中“949×1680”顺序和最大/实际高度口径须纠正，不能混称全部为宽屏同一次采样。
- 布局支架加载实际renderer资源，但preload命令为模拟数据；适合证明布局/可见性，不能替代真实daemon的命令合同闭环。冻结链和启动器自测另列。
- 最终自测归档 `dev25-dual-evidence/2026-10-040514-qvmyfu/summary.txt` 记首启/二启/优雅停机/real_calls=0和结果保护通过。源码已去掉首启reload。

## 3. [P1] 043仍把空或否定的Job证据当完整释放

位置：`src/persistence/migrations/043-turn-protection-release-evidence.ts` 的managedEvidence分支。

当前只检查非null且typeof为object就返回released；没有排除数组，没有检查真实ReleaseEvidence字段。以下纯函数输入都被判released：

```json
{"released":true,"managedEvidence":{}}
{"released":true,"managedEvidence":[]}
{"released":true,"managedEvidence":{"releasable":false,"rootExited":false,"handlesReleased":false,"activeCount":2}}
```

另有：

```json
{"released":true,"reason":"protection-released-no-os-process","probe":{"result":"alive"}}
```

也判released。reason兜底本意是旧事件**缺probe**，但当前代码在已有相反probe时也覆盖它。

脚本/结果：`dist/desktop/review-r43/protection-evidence-probe.mjs`、`protection-evidence-result.json`；纯函数，没有DB/worker/模型，不宣称真实历史库已经发生此损坏或重复调用。

修复按实际 `managed/jobManager.ts ReleaseEvidence`：可信Job事实需对象结构和完整字段成立（releasable/rootExited/handlesReleased为true、activeCount为数值0及对应稳定身份/来源）；空、数组、明确false和矛盾不能放行。可信完整Job可以优先于落后的普通进程观察，不能把所有alive观察一律误否决。

no-os-process也区分“旧事件真正缺probe的受控兼容”与“已有probe但损坏/矛盾”，不能字符串覆盖已知相反事实。更新真实正例fixture，不用仅 `{releasable:true}` 充当完整证据。

043已冻结，下一版对**已应用043**的库也有版本化兼容收口；不静默改历史审计/预算，不只修纯函数而留下错误回填行。覆盖40/41/42/43→最新、降级阻断、可信正例不误拦、文件库重开同判。

## 4. [P2] 桌面DM返工确认漏传manifestHash

位置：`src/ui/renderer/app.js:3845`。接受分支传manifestHash，要求修改的确认分支不传；后端 `task.review` 强制该字段（`commands.ts:3351`）。

独立反例原样抽取当前产品reject handler，在内存库正式创建可访问DM/task，只桩DOM与刷新，**发送交给真实dispatchDaemonCommand**：

- 展示快照具有64位manifestHash；
- handler实际发送只有taskId、deliveryId、deliveryRevision、decision、note，没有manifestHash；
- 正式接口返回 `VALIDATION_INVALID: Invalid input: expected string, received undefined`；
- UI行内收到“提交返工意见失败”。

脚本/结果：`dist/desktop/review-r43/dm-review-contract-probe.mjs`、`dm-review-contract-result.json`。这是schema契约反例，不是完整待验收fixture的正向返工闭环；全程内存库，无worker/模型。

工程修复：三重交付绑定加task身份沿**用户所见快照**固定，不在输入意见后改用另一个最新会话/稿件；加入真实fake正式链的桌面接受/返工按钮测试、跨会话/更新版本不误审。顺带盘点房间/线程/DM/待办/看板/远程共用review调用方，避免再次只修一条入口。共享参数builder/契约校验可渐进采用，不要求重写整个前端。

## 5. [P2] 新DM收起策略把显式工具入口架空

v6 CSS强制 `.main[data-view="dm"] > #board/#files/#activity {display:none!important}`。

三个toggle handler只改变hidden/布尔值与标题，没有切换data-view；实际render函数也没有把视图切出dm。独立隐藏窗口读取v6**原始CSS和原始toggle handlers**，仅桩数据渲染：

```text
点击看板/Files/动态后：requestedOpen=true，dataView=dm，computed display=none（三项均如此）
```

结果：`dist/desktop/review-r43/dm-tools-visibility-result.json`；脚本 `dm-tools-visibility-probe.cjs`。此反例验证控制流与CSS组合，未操作用户窗口、无后台请求。

自动收起无关区域可以保留，但用户显式点入口应产生正确可见的面板/视图转换或清楚反馈。统一视图/面板状态，不要让布尔值、hidden类、data-view互相矛盾；保留草稿、导航代次和当前授权上下文。由工程补邻接按钮自动化，不额外要求用户拍图。

## 6. 材料与来源说明的收尾

- docs指南是四项补测；v6 README尾部仍列“七项”，结果模板R1–R5仍为空行。补独立四项说明或标明R1–R5沿用v5、不测，避免用户被材料要求重复。已有回填不覆盖。
- 明确右下角resize手柄，以及V2测试应用回环后恢复LAN的收尾步骤；Android指南使用v6实际地址和CA，范围独立。
- v6 BUILD真实记录 base commit=`8f49f5c...`、dirty=true、dirtyDiffHash=`4fa3b1b0363c88c491b3fa6f44648e876dcae899c141ae033c9e825c0bbdcbd0`，不是干净ab89219构建。这**不自动说明不同源**：本次已核对588文件及三个产品renderer源码一致。工程补构建差异快照与最终commit的对应，保留真实元数据，不改写成伪clean、不为了更换标签让用户重复手测。

## 7. 下一轮与用户操作

可以让用户现在正常关v5、启动v6，完成R6/R7/V1/V2；四项通过后按既有指南做Android。其间GLM在独立环境收以上三条确定性工程边界、共用review合同和材料，不动用户运行的v6与结果。

用户回填后只读核对、集中处理实际失败再出必要的最终候选；不因每个测试或文案修订重新发包/导CA/跑七项。旧库兼容和正常操作合同修完之前不宣G5，v6手测结果仍按其构建/设备范围保留。

继续PPT A+Word，B不集成/不下载；零新增真实模型调用，旧r20/r25、通知及D1–D10证据保留，价值评价/DEV-11/并行写入维持原约定。
