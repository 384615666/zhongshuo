# R76 附件显示与图片链修复（2026-10-11）

R76 负责实现、正式适配器输入验证、真实图片认证、便携包复证与源码提交。起点 `8d46d1d`，工作区 `D:\zhongshuo`，分支 `codex/full-implementation`。开始时仅独立复现文档未跟踪；未读写用户旧数据库、旧包或凭据，迁移 001–048 冻结。

## 实际根因与修复

1. **附件闪烁**：room.pool 没有根附件摘要；房间水合重建根消息会删除 thread.history 刚补上的 formalAttachments。数据库关联始终存在。已让 room.pool/thread.get 从 message_attachments 同一摘要函数返回完整根事实：正文、真实作者、附件。正文链未发现独立丢失反例；作者原先固定为 you，而 thread.get 返回真实 author_id，也会交替变化，现已统一。
2. **刷新事实与回执顺序**：undefined 表示未读取，readErrors 表示读取失败，[] 是权威空列表。根事实按请求顺序收敛，主池与缓存线程锚同步；旧 thread.get、旧 room.pool、补读历史不能复活已清除的附件。历史失败保留已确认根事实并显示读错，切项目丢弃迟到成功与失败，房间投影只更新自身。补充反例：旧房间组件尚在时以新 activeProjectId 发起旧房间轮询，会把根消息错误标成新项目；永久测试先失败（foreignReads=1），再补发起前房间归属门。
3. **上传/预览/发送不可混称失败**：v14 真启动器中，文档测试 PNG 实际上传成功、自然解码 1043×1439；仅记录也真实落库，但冷主池附件为 0，展开后每 5 秒再次消失。记录见 r76-v14-image-baseline-20261011.json；原独立 ui-result.json 原地保留。
4. **图片阅读不足**：旧 img 没有 decode error 路径，缩放使用未知尺寸 800px 占位，不保留独立阅读状态，也无拖动。已在原右侧区域增加 ImageView，采用浏览器原生解码，尺寸来自 naturalWidth/naturalHeight，提供适应、原尺寸、连续缩放、拖动、复位、放大/Esc、原件另存。状态按资源 ID+版本保存，重启回到适应；失败就地显示原因与重试，保存失败也就地显示，草稿和原件保留。
5. **真实格式反例**：截断 VP8L WebP 只有 21 字节却执行 4 字节读取，已按 25 字节限界拒绝。前端早已声明工作区 SVG 图片，但服务端读取白名单漏了 SVG；已补本地只读 8MB SVG，保持 img 图像上下文，不作为 SVG 文档执行，也不扩展 SVG 上传或模型输入。
6. **模型链原先只有文字**：claude stdin 和 codex turn/start 都只传 text；Composer、页面 onSend 与服务端又分别无条件阻挡图片。已加入经 MIME/字节/hash 校验的图片块，Claude 使用 stream-json/base64 image，Codex 使用 inline data image；移除重复页面硬拦截，发送前读取实际目标能力，服务端重新判断。正式 worker 从原件核验生成图片字节，不把路径/文件名当图像；派发前配置/认证变化则正常关闭已开会话，不伪记 UNKNOWN。

7. **最终副本并发启动反例**：两个独立副本在同一时刻首次启动，cmd 的三段 RANDOM 产生相同 pipe-name，第二个副本启动/CDP 超时；两个 marker 均为 zs-daily-17175963315590（r76-images-1791690531765 与 r75-launcher-check-1791690531767）。已把新数据根命名改为 GUID；已有 marker、旧根和凭据不改写。失败日志 r76-final-launcher.log 原先内容另留在交付记录目录，不以重跑覆盖首次失败。

## 图片发送合同

- 附件-only 合法，真正空内容拒绝；仅记录不派发，本地保存/预览不依赖模型认证。
- `body_json.imageInput` 保存 include、omit、local-only；旧记录没有图片授权时保持省略，不因为后来的认证而补发历史图片。
- omit 图片但没有文字的输入被服务和 UI 拒绝；未认证组合提供仅记录、移除图片、重选成员/成员配置。
- 发送信封仍由原 builder 构造、stageOutbound 耐久保存；未知结果只能人工同号同参重放，既有账本、草稿结算和幂等合同未变。
- 当前正式图片派发适用于已认证组合的 DIRECT 房间任务与 DM。既有 AUTO/DELIBERATE 延期与线程跟进合同没有扩大。

## 认证证据与依赖

先完成正式 Claude/Codex 适配器零调用协议回放，再经用户明确授权分别做一个 startTurn，共 2 个。只发工程生成的 360×180 PNG，提示里没有图中数字；未发送用户样本。详见 r76-image-certification-20261011.json。

- Claude 2.1.283 / deepseek-flash / plan 正确识别左至右红色正方形、蓝色圆形、绿色三角形和 5837；渠道报告模型名 deepseek-flash。认证绑定 CLI 原件 hash、适配器版本、渠道 endpoint hash 与模型/权限组合；不由模型名或配置成功推断支持。
- Codex / gpt-6-luna 同一图片输入请求经历上游超时（CLI 内部采样重试后转 HTTP），120 秒停止，未得到识图证据；未另起 startTurn 重试，仍为 unverified。以后要开放该组合还需网络/渠道可用时的新授权认证。
- 实测真实格式是 PNG；JPEG/GIF/WebP 的本地解码与字节传递已验证，未逐格式新增真实调用。没有 OCR 认证或新增 OCR 实现。

协议依据：[Claude CLI](https://code.claude.com/docs/en/headless)、[Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision)、[Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)，并对照仓库固定协议类型 UserInput.ts。SVG 使用图像上下文的限制见 [MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)。现有浏览器能正确解码，问题在事实链/接线/状态/布局，因此未增加第三方查看器依赖；没有外部图片服务或离线资源下载。

## 检查与证据

- 源码本地 Vitest：118 个文件、927/927，通过；core/hifi 两个 typecheck 通过。永久 R76 测试覆盖冷池、多附件身份、两方向反序、权威空、读失败、跨房间/项目、历史补读不复活、原信封重放、实际 worker 图片字节、配置变化前停止、WebP 边界及工作区 SVG。协议回放使用正式适配器但本地模拟进程，不算真实能力认证。
- 新增文件 ESLint 通过；修改的既有文件与 8d46d1d 对比：旧错误 48、本轮无新增。全仓 lint 原有大量脚本/历史测试错误，本轮未清理，不能声称整个 pnpm check 通过。
- 完整首次 Vitest 935 项有 6 失败：两项本轮旧断言（预览不再全局 unverified、明确省略文本）已修正并单独复证；另四项为 Word 被 WPS 接管/控制字符 Word 读回、GitHub schannel TLS 握手失败。首次日志 dist/r76-tests-all.log 保留；最终本地集明确排除这两个外部环境测试文件，没有用重试成功冒充首次成功。
- 项目取消 G2 三阶段/回滚/启动记忆与重启恢复，真实 Electron、正式命令、独立根，零真实调用，结果在 gate-r75-r75-gate-20261011031047/result.json；最终包还需真启动器普通打开 B→C/重启落位复证。
- 候选 v15 已以真启动器/发布形态独立副本通过：冷根芯片、展开后 16.5 秒（64 次采样，跨 3 个 5 秒周期）身份和数量稳定；PNG/JPEG/GIF/WebP 真实 natural 尺寸与画面；BMP/SVG 工作区；草稿、主池已发、线程回复、多附件、附件列表、私信、交付文档文件入口；缩放拖动、切标签、放大/Esc、损坏/超容量就地原因、8MB 接受、原件另存 hash、关窗重开预览。此阶段数据根 real_calls=0。
- 交付文件入口使用正式 FakeRuntimeAdapter/worker 产生、明确标注工程夹具的 TaskComplete，再由真启动器打开；不把该夹具当真实 AI 交付或真实看图证据。它只在独立复证根里，日常包不带演示数据。
- 一次并发全量本地集遇到原 PID 被系统复用，监督器仍返回 unknown 并拒绝解除保护；测试只接受「未观察到后代」过窄，已保留「unknown + 解除拒绝」严格判据并允许合法的 PID 复用说明，生产监督器和保护规则未改。此首次失败日志 r76-tests-final-ownership.log/json 保留。
- v14 失败和各候选探针失败目录均保留；早期扩展探针误点容器、未等线程输入框导致的失败单列为探针错误，修正为实际按钮/输入框后重新验证；SVG 白名单失败是产品反例并实际修复。最终 clean BUILD 和启动器回执将另存交付记录。

## 范围与未覆盖边界

没有修改用户旧包、旧数据、原样本、凭据、草稿或未知账本；没有自动发送、未知同号重试、对账、解除保护。Android/安装器/签名/既有延期未扩展。SVG/BMP 仅本地工作区阅读，图片附件上传/模型输入仍为 PNG/JPEG/GIF/WebP；动画 GIF 逐帧、其他 CLI/渠道/权限组合、长时间内存压力与 8MB 以上未承诺。Office/PDF 阅读器未重做，外部 Word/GitHub 环境失败仍单列。

只给用户一次约 3 分钟增量确认：选择一张图片 → 预览并缩放 → 仅记录发送 → 等待刷新后图片仍在 → 关窗重开后再预览。
