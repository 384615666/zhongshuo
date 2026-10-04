# 原型界面接入正式客户端·施工计划（2026-10-04 立项，第四十六轮起）

依据：用户第四十五轮补充优先级 + `docs/dev-briefs/prototype-to-runtime-handoff-v1.23.md` +
`hifi-prototype/`（已批准视觉/交互，v1.13+各批复核）。**主线提升：不等全部剩余功能或 G5。**

## 0. 原则（不可违背）

1. **复用已批准的组件、布局和交互**——原型 TSX/CSS 原样拷入 `src/ui/hifi/`（原型工程保留为
   参照不改动）；不重新设计界面，不做只读演示。
2. **替换 mock 层**：组件消费的 `data/store.ts`（useStore/草稿/主题等 API）在正式侧重写为
   真实实现——装载走 `window.zs` 正式命令（project.open/room.list/room.pool/conversation.*/
   message.submit…），写操作发真实命令并按响应更新状态；**不保留种子数据、不造 mock 成功**。
3. **尚未接通的能力如实呈现**：未换装页面（线程/预览/设置/看板/Files/Git/搜索…）经侧栏
   「原界面」入口整体接管到现有 renderer（同一页面内 `#legacy-root`），顶部如实标注
   「此区域尚未换装（沿用原界面）」；入口按钮禁用态+说明，不用假数据冒充。
4. 后端合同、用户数据、既有证据、v6（Android 验收用）全部不动；`zs` 桥与命令面不变。
5. 每轮交付：可运行产物 + 页面级验证（真实命令面桩/真 daemon）+ 如实清单（真实/未接/禁用）。

## 1. 接入顺序（包序）

| 包 | 范围 | 预计轮次 |
|---|---|---|
| **H1 首包** | 外壳（侧栏三段式+主区路由）+房间主池（真实根消息/线程摘要+发送+仅记录+mention）+私信（列表/历史/发送/仅记录/新建）+输入区（Composer 真命令）；未换装页经「原界面」接管 | R46 桥+壳+侧栏真实数据；R47 房间/私信消息+输入闭环；R48 去尾+页面级验证器+**首包交付候选**（共 3 轮） |
| H2 | 回复串（线程视图+线程内发送/仅记录）+共享预览（附件芯片→预览面板，复用现有 renderer 预览链）+附件草稿 | 2 轮（R49–R50） |
| H3 | 设置（应用/项目/远程按原型设置导航）+看板/Files/任务页归位；**Git 与诊断信息按原型入口归位（文件与 Git 同页两标签），不再常驻挤占聊天区**；无边框窗口+自绘标题栏（含托盘联动评估） | 2 轮（R51–R52） |
| H4 | 外围收尾（命令面板/启动恢复弹窗/快捷键矩阵）+全量页面级回归+最终候选包（与 Android 回填后的最终候选合流决策） | 1–2 轮 |

首包验收口径（用户）：**在正式应用中看到原型风格的侧栏、房间、私信、消息和输入区，并能完成
实际操作**（打开项目→侧栏见真实房间/私信→房间发消息（派发/仅记录）→私信发消息→历史与
未读真实）；v6 与既有测试不重做。

## 2. 首包技术要点（R46 已定）

- 构建：`scripts/build-ui.mjs` 增量——esbuild（tsx, jsx=automatic）打包 `src/ui/hifi/main.tsx`
  → `dist/ui/renderer/hifi/app.mjs`；原型 `styles/*.css` 拷至 `dist/ui/renderer/hifi/`。
  `react@18.3.1/react-dom@18.3.1` 入根依赖（正式产物依赖，非 devDep）。
- 原样拷贝（零改写的批准资产）：`components/{Icon,ui,NavMarks,MessageView,Composer}.tsx`、
  `data/types.ts`、`data/selectors.ts`（纯函数）、`lib/{format,resource,router,useElementWidth}.ts`、
  `styles/*.css`。改动只发生在：`data/store.ts`（真实重写，同名 API）与我方新增文件
  （bridge/realstore/pages）。
- 真实桥 `hifi/bridge.ts`：包装 `window.zs.command`（类型化）——首包命令面：
  `app.settings.get`、`project.open`、`room.list`、`member.list`、`room.pool`、
  `conversation.list`、`conversation.create`、`conversation.history`、`conversation.markRead`、
  `message.submit`（room_root/dm；intent=record_only；mentions）。
- 共存与接管：`index.html` 增 `#hifi-root`（React 壳，默认）与 `#legacy-root`（现有 vanilla
  app 整体）；legacy boot 由壳守卫——hifi 激活时 legacy 延迟启动，接管入口首次点击才 boot
  （避免双轮询/双装载）；hifi 加载失败自动回退 legacy（安全兜底）。
- 无边框标题栏与托盘属 H3（当前保留系统原生窗框；原型 TitleBar 不在首包）。

## 3. 风险与边界

- 原型组件 API 以 props/store 为界——重写 store 必须保持同名导出（useStore/setState/草稿/
  toast/setTheme/recordLocalOnly…），否则组件漂移即违背「原样复用」。
- 附件/预览在 H1 只做入口与禁用说明（「预览/附件下一包接入」），不用 mock 附件冒充。
- 每轮真实/未接清单写入 `docs/implementation/hifi-integration-*.md` 进度记录。
