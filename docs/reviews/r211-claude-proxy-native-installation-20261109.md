# R211：Claude 代理误报与原生程序缺失识别

## 已确认的两个问题

1. 用户给出的 `ALL_PROXY/HTTPS_PROXY/HTTP_PROXY 改变渠道或宿主执行，尚未核实` 来自众说的配置解析器，并不是 Claude 上游报错。旧规则将网络代理和 provider/host 接管统一判为不确定，导致扫描提示、模型清单及受限执行被误挡。本机只读配置检查复现相同三段理由；这三个变量均为 HTTP 形式的本机代理，未输出代理地址或凭据。
2. 本机默认解析到的 npm `@anthropic-ai/claude-code` 版本为 2.1.318，其 `bin/claude.exe` 只有 500 字节，是写有 `Error: claude native binary not installed.` 的官方占位文本，不是可执行原生程序。该文件的修改时间早于本轮。众说此前只检查文件存在，因而误显示找到 CLI。这只证明当前默认 npm 入口不完整，不推断所有其他显式 Claude 入口都不可用。

## 产品侧修改

- 合法的 `HTTP_PROXY`/`HTTPS_PROXY`（含小写和 Basic authentication）按网络传输配置处理，不再一律解释为 provider/宿主接管。无效地址、非 HTTP(S) 协议及异常 URL 仍给出仅含变量名的诊断，不回显地址或密码。
- `ALL_PROXY` 原样透传并保留既有指纹，不再仅因其存在而判为宿主接管；不宣称 Claude 官方支持或实际采用该变量。provider/host/process wrapper、动态凭据、未核实的项目/托管覆盖及额外启动参数的限制不放宽。
- 只改诊断规则，不改 v3 指纹算法或旧授权快照。原有三项代理仍影响指纹；排队后代理值变化会在 spawn 前拒绝，未刷新旧快照以绕过检查。
- 现有模型元数据 fetch 不等价于 CLI 的代理/信任逻辑。有代理时保留本机已配置模型，提示可手动填写，不携带凭据绕过代理直接请求远端列表。真实模型连接继续由 CLI 自身按原配置处理；本轮未新增代理清单查询实现。
- 默认、显式 exe 和 npm shim 三条路径识别已知的“原生程序未安装”占位文本，返回 `RUNTIME_NOT_FOUND`；成员扫描和程序状态显示安装不完整，不再当作可派工入口。不会下载、安装或修复第三方 CLI。此项不是通用 PE 校验或模型能力认证。
- probe 在注册异步回调之前计算可执行引用，避免占位检测错误在 close 回调中抛出并造成未处理拒绝/探测挂起。实际生产 spawn 仍拒绝缺失程序。
- 旧回放中依赖“开发者本机已装正常 Claude”的用例改为隔离 npm 布局，防止用用户全局安装状态充当测试夹具。

官方依据：[Claude Code Enterprise Network Configuration](https://code.claude.com/docs/en/network-config.md)，本轮在线读取。文档明确列出 HTTP/HTTPS 代理、大小写优先级、Basic authentication，并明确不支持 SOCKS；文档未列出 ALL_PROXY，因此不对其生效作认证。

## 验证

- 新增初始 19 项中的 13 项先复现原问题；补充边界后，本轮共新增 29 项。
- 最终 **18 文件 / 208 项全部通过，未处理异常 0**，包括 Claude 配置/v3 兼容/任务授权/只读和受限执行/默认成员扫描/协议回放，以及此前 R210 的 Harness 安装入口与 Pi 回归。不是全量测试通过声明。
- 实际本地假 CLI 子进程收到原样 HTTP/HTTPS/ALL/NO_PROXY，受限执行链路成功结束；没有网络请求或真实供应商调用。模型清单各代理变量的测试确认 fetch 零调用；代理变更测试确认 spawn 零调用。
- 本机新代码只读检查：配置 `reason=null`，三个代理变量原样保留；默认 CLI 明确报安装不完整，成员程序状态为 missing。证据在 ignored 的 `dist/r211/local-readonly-check.json`；测试 JSON 为 `dist/r211/targeted-tests.json`。
- 本轮程序和测试文件 ESLint、定向 TypeScript、diff whitespace 检查通过。迭代中发现并修复 probe 回调异常；数据库相关回归补齐仓库本地依赖链接后重跑通过。此前 SheetJS CDN 超时限制仍在，未宣称全量依赖恢复、全仓类型检查或全量回归完成。

## 尚未完成

未修复用户真实 Claude CLI 安装，未调用真实模型验证联网、登录、模型路由或代理连通性。仅更新众说不能补齐第三方 CLI 缺失的原生程序；用户需另行明确授权修复或自行按官方方式处理。

与 R210 一样，本轮仍是源码修复，版本保持 1.0.1；未生成或发布新版 Windows 安装包，未提交/推送/Release，未安装/升级/卸载用户程序、改变系统代理或改动用户运行数据。此前 R210 修改原样保留。

后续交付：用户随后授权发版，本修复已随 [R212 / 1.0.2](r212-runtime-fixes-release-1.0.2-20261109.md) 发布；此前“未打包”仅描述本轮源码阶段。用户真实 Claude CLI 的原生程序缺失仍未代为修复，不因众说发布而宣称已恢复可用。
