# R77 图片认证配置身份与 Codex 超时收口

基线 `8898b23`，分支 `codex/full-implementation`。本轮新增真实模型调用 **0**。R76 证书未修改，原两次认证结果及独立审查反例保留。

## 缺陷及修复

旧 `claudeImageIdentity` 只看进程 endpoint 或固定用户 settings，遗漏 `CLAUDE_CONFIG_DIR`、正式 session.cwd 和其他来源，可能错误复用认证。独立失败证据：`dist/desktop/review-r76-v15-audit-20261011/config-dir-result.json`。新解析器由能力检查、Claude 正式 adapter 与受管启动入口共用，保留原继承环境和 CLI 自身全部配置来源，不通过忽略设置对齐证书。

常规用户 settings.env 会影响 CLI 环境；自定义配置目录按 session.cwd 解析。项目共享/本地 settings、旧 global env、动态 apiKeyHelper/processWrapper、托管文件/分片/Windows 策略、宿主/provider/代理环境及额外覆盖参数均参与检查。读取失败、非法 endpoint 或不能核实的过滤来源明确 unverified。对项目渠道覆盖，已补两种文件的隔离反例和发布形态探针；因 CLI 项目信任及渠道过滤可能决定最终生效值，这些组合不猜测为已认证，也不宣称做过真实网络覆盖验证。

用户常规已认证 Claude deepseek-flash / plan 继续按原 CLI SHA、endpoint SHA、模型ID、权限、adapter version 匹配真实证据。瞬时身份还包含项目 cwd、配置目录、配置文件内容、相关环境和启动覆盖参数的摘要。worker 在组装及 openSession 返回后比较同一身份；adapter 在图片 spawn 前同步再检查。变化会拒绝当前图片派发，原件和原消息保留。未知结果原信封和幂等合同未改。

Windows 注册表不存在与读取失败分开。测试发现中文 reg.exe 输出为 GBK，UTF-8 误解码会把不存在误判为失败；已读取原字节并按 GB18030 解码，未知/拒绝读取仍不认证。失败回执 `dist/r77-focused-final.json`、`dist/r77-policy-debug.log` 保留；修复后回执另存。

成员页和带图片的输入区显示实际模型ID、渠道（不确定时写明候选来源）、权限、配置状态、适配器图片字节回放和真实识图状态，并显示不匹配原因。输入区按作用域读取并每5秒刷新；发送时仍独立核对。仅记录、移除图片、换成员/成员配置动作保留，图片-only 不能发送空文字。原查看器、附件事实链、草稿和项目打开取消不改。

## Codex 零调用诊断

`scripts/diagnose-r77-codex.cjs` 只执行版本、initialize/initialized、config/read、model/list；不创建 thread，不调用 startTurn，不读取或导出凭据。CLI 0.160.0 的完整模型清单和本机缓存都包含 `gpt-6-luna`。当前 provider `custom`，wire API `responses`，supports_websockets=true，未显式设置 base_url；实际默认地址取决于登录方式，不冒认某个 endpoint。

从原认证自己的 rollout 恢复的 session_meta 确认 provider custom / CLI 0.160.0 / 工程 cwd；turn_context 确认最终模型ID `gpt-6-luna`、never / read-only 和 provider turn ID。旧日志在该 turn 上报告5次 `request timed out`，随后 `falling back to HTTP`，120秒截止仍无识图结果。这证明已越过初始化和 thread/start，并进入上游采样等待；没有名称无效、401/403、图片不支持或协议字段拒绝的证据。具体网络/渠道原因及当前账号模型访问权限尚不能确认，继续 unverified。

完整脱敏记录：[r77-codex-timeout-diagnostic-20261011.json](r77-codex-timeout-diagnostic-20261011.json)。官方说明 model/list 可为缓存目录，不等同账号推理可用：[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)；模型ID见 [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。Claude 配置目录及来源依据 [settings](https://code.claude.com/docs/en/settings)，并核对本机2.1.283原生CLI中的 env注入/过滤逻辑，未运行模型。

本轮交付不依赖追加认证。如以后要完成 Codex 真实识图，最低为用户再次授权 **1 次 gpt-6-luna startTurn**，用同一工程 PNG（360×180，三种形状/颜色及隐藏数字5837），需可达的现有 provider。不得自动重跑，也不发送用户样本。CLI 内部网络重试须单独计入日志。

## 验证与交付

- 永久 `imageConfigurationR77`：配置目录切换/恢复、两种项目覆盖、坏/不可读配置、provider/host/proxy/动态/托管/参数来源、不可变证书正反例、正式adapter spawn前变更拒绝及恢复。
- `imageInputR76` 新增 worker 在 openSession 期间改变配置身份但保持 supported 的反例，必须 startTurn=0、UNKNOWN=0、原件关联保留。
- 相关7文件58项通过；最终本地全量 **935/935** 通过（119文件）。双类型检查通过。新增文件 lint 通过，修改文件与基线比较无新增问题（源文件既有5项、旧启动器探针27项不宣称全仓lint通过）。原环境依赖 Word/GitHub 外部测试沿用R76分列，本轮未重跑；无新增模型调用。
- 最终构建与启动器结果见交付 JSON。R76图片真解码、缩放拖动、保存hash、仅记录/重开、附件跨3个5秒周期、图片-only和项目切换/取消做必要回归；配置状态正反例必须进入总pass。

发布形态追加发现：文件树图片 naturalWidth/Height 已为1043×1439时，一帧绘制尺寸仍为0，随后适应窗口为正。原查看器使用 useEffect / ResizeObserver 首次量测，且解码状态未要求有效区域。改为 useLayoutEffect 首次测量，区域为0时保持解码/布局提示，不显示成功。永久UI验收同时等自然尺寸、非零绘制尺寸、区域交集和decoded状态；没有重新选择或重试图片操作。原失败 `r76-images-1791696018889/result.json` 保留。

另两项工程探针记录分列：`r76-images-1791695883925` 新探针返回私信用了错误路由，配置正反例已通过但整体首次失败，修正为正式 `/dm/:id` 后重跑；`r75-launcher-check-1791695904176` 启动器探针调用漏了 `--src`、读到旧v13，不能计为v16验收，最终以BUILD和指定v16来源一起核验。

旧包、用户数据/凭据/草稿/未知账本未改；迁移001–048冻结，无自动发送、对账、解除保护。Android、安装器、签名和其他延期范围不扩展。未验证的托管/宿主动态来源和真实项目渠道过滤保持明确边界；不更换查看器。


最终 v16 BUILD：`bld_7c03ac9a82f2fd60`，clean，源码 `473c7f96a1397d1f7d00c74ba78361b96775235f`。最终包及两个真实启动器副本均593/593字节大小与SHA256一致；后续交付记录提交只改docs，运行时源码与BUILD不变。

最终集中验收：[r77-v16-delivery-20261011.json](r77-v16-delivery-20261011.json)，requiredChecks全部true。图片证据 `r76-images-1791696357086/result.json`：64次/16256ms采样，16个图片入口与配置阶段全过，real_calls=0，发布协议zsres；已检查最终成员状态、配置失配、拖动缩放和重开画面。项目证据 `r75-launcher-check-1791696332198/result.json`：真实v16启动器A→B→C→重开C、console errors0、real_calls0。两独立数据根pipe GUID不同。取消三相位源形态门 `gate-r75-r75-gate-20261011051914/result.json`通过，real_calls0。最终源码 `dist/r77-source-release.json`为119文件935/935，双类型检查0错，lint无新增。原失败和错误目标探针仍在，未改记成首次成功。

用户无需再手工制造配置变化或重跑历史验收；下一步真实Codex认证须按上述最小调用需求另行授权。
