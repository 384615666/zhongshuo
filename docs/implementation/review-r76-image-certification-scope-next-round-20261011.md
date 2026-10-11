# R76/v15独立复核与R77配置身份收口（2026-10-11）

## 已确认的修复与范围

HEAD `8898b23`；v15 runtime源码BUILD指向`485386c`，clean BUILD `bld_e1445d7659d870b2`，独立清单大小/SHA256 **593/593**一致。

独立复跑6文件 **50/50**（rootAttachmentsR76、imageInputR76、imageAttachments、hifiNavCancelRound74、Claude/Codex协议回放），双typecheck0错。未独立重跑927全量、未追加真实模型调用，也未重跑完整发布启动器。

原附件闪烁UI探针切换到冻结v15，独立隐藏Electron/profile、正式命令与内存库，record_only根消息附件跨三个5秒周期、64次采样稳定1个，PASS，real_calls=0。证据 `dist/desktop/review-r76-v15-audit-20261011/ui-result.json`。原v14反例保留。项目真实样本与用户数据未改写。

报告的最终发布形态`r76-images-1791692055970/result.json`、`r75-launcher-check-1791692055980/result.json`和两次真实认证记录已核读，源码/协议回放/真实模型识图/发布形态应继续分列。Claude深度配置组合的认证有自身证据；Codex120秒无结果仍unverified。

## 已确认的配置身份判定缺口

`src/daemon/imageCapability.ts:claudeImageIdentity`只读取process.env.ANTHROPIC_BASE_URL，若无则固定读`homedir()/.claude/settings.json`。未消费CLAUDE_CONFIG_DIR，也没有项目cwd参数。

本机Claude2.1.283的--help说明可读取user/project/local settings；正式adapter继承process.env并由CLI在session.cwd读取配置，没有固定--setting-sources。

官方设置文档明确：CLAUDE_CONFIG_DIR可以更换用户配置目录；项目本地与共享项目设置可以覆盖用户设置，env块也遵循设置优先级：
https://code.claude.com/docs/en/settings

独立只读身份反例（未启动CLI turn、未联网、未改用户settings）：

1. 子进程内清空显式ANTHROPIC_BASE_URL，原用户配置身份与现有认证endpointHash匹配。
2. 自有目录创建settings.json，env.ANTHROPIC_BASE_URL指向自有无效本地端点；仅对子进程设置CLAUDE_CONFIG_DIR到该目录。
3. 再计算claudeImageIdentity：endpointHash完全不变，仍匹配原证书；executableHash也匹配。

证据 `dist/desktop/review-r76-v15-audit-20261011/config-dir-result.json`，pass=false。这是**配置身份计算忽略新配置目录**的直接证据，不称已向该端点发出模型请求。

成员能力只根据这份身份与模型/权限/adapter判supported，因此认证可能被沿用到CLI实际读取的另一渠道。项目设置覆盖同属源码缺口，但本轮未进行真实网络/启动取证；下一轮应以隔离夹具补验证，不擅自扩称已实测。

## 用户模型名疑问的结论

`gpt-6-luna`是官方模型ID，显示名称GPT-6 Luna；本机`models_cache.json`同时记录slug=`gpt-6-luna`、display_name=`GPT-6-Luna`。不能改成含空格的显示名来试错。

官方模型页已检索并打开：
https://developers.openai.com/api/docs/models/gpt-6-luna

官方图像支持是模型规格，不代表本机当前渠道已实际认证。认证结果仅记录120秒超时，不能归因于名称错误。须查实际CLI模型列表、provider/endpoint与请求失败阶段，证据不足保留unverified。

## R77集中工作建议

1. 认证身份与正式adapter执行配置共源：有效配置目录、cwd相关项目配置、覆盖来源、显式启动参数。保持用户现有渠道，不以强行忽略设置来“对齐证书”。不确定时说明原因并保持unverified，预览/仅记录不受影响。
2. 新身份覆盖或更新CLI/model/权限/config目录/有效endpoint后不能沿用旧认证；发送检查与worker实际启动检查一致。成员UI显示实际模型ID、能力与不匹配原因，避免只有一个笼统unverified。
3. 先零模型调用检查Codex gpt-6-luna模型发现/实际配置/错误日志分层；不盲改成空格名字、不自动重复真实认证。需额外认证时具体询问最少调用数、模型和样本，之前授权上限2已用完。当前工作不依赖新调用。
4. 独立永久测试至少含CLAUDE_CONFIG_DIR、项目覆盖/不支持覆盖、配置变化前后、已确认认证正常正例；不伪改certificate、不关闭服务端守卫。
5. 已认证用户现用组合保持实用性，字节输入、图片-only、仅记录、原信封同号重放、附件稳定、预览状态与正常项目切换只做相关必要回归。
6. 有代码修复后集中交v16，源码与最终启动器身份对应、提交推送。迁移001–048冻结，用户数据/旧包/账本/凭据不动，不自动对账、解除保护或发送。不扩其他延期，不换查看器。

用户只需要v15一次约3分钟图片选择→预览缩放→仅记录→等待15秒附件稳定→关窗重开预览。没有必要重做长清单或手工造配置错配。
