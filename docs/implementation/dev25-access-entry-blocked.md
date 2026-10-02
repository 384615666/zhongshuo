# DEV-25 验收入口受阻记录（第三十六轮，2026-10-02）

> **口径**：本记录登记真实双机验收在入口处的受阻事实与工程侧修复。**D1—D10 尚未执行，不记通过。**
> 用户原始描述（逐字保留）与工程侧取证并列；后续修复与普通浏览器预检结论见文末。

## 用户原始描述（逐字保留）

> 用户不用再切配置证明已知证书错误。当前已取得事实：
> - 服务只监听 127.0.0.1:60350；
> - 服务机 192.168.1.100，客户端 192.168.1.101；
> - 实际服务证书 Subject/Issuer 均为空，SAN 非 critical；
> - 普通 Chrome 无法完成证书信任入口。

## 工程侧取证（开发机复现）

- 旧版证书生成（remoteIdentity.ts，第三十一轮）：Windows PowerShell
  `New-SelfSignedCertificate -Type SSLServerAuthentication -TextExtension @(SAN)` **未传 -Subject**
  ——实际证书 Subject/Issuer 均为空；SAN 非 critical。空 DN+非 critical SAN 不符合 RFC 5280
  （subject 为空时 SAN 必须 critical）——普通 Chrome 的证书查看/信任流程无法走完。
- 「服务只监听 127.0.0.1:60350」：默认仅本机模式的事实呈现；当时未启用 LAN（或启用与否不可
  从旧 UI 事实核实——旧 UI 不回实际监听核对）。客户端 192.168.1.101 → 服务机 192.168.1.100
  的跨机失败**未取得客户端具体错误码**——本轮起按分层排查口径处理，不把网络失败一律定性为
  证书或防火墙。

## 第三十六轮修复

1. **证书重写为本地 CA+服务证书两层（node-forge 纯 JS，跨平台）**：
   - CA（CN=Zhongshuo Remote Access CA，CA:TRUE+keyCertSign critical，10 年）——**用户导入的
     信任根**（remote/ca.cer；Windows「受信任的根」/Android 用户凭据均适配）；
   - 服务证书（CN=zhongshuo-remote）由 CA 签发：Subject/Issuer 明确；**SAN critical** 且覆盖
     127.0.0.1/localhost/[::1]/实际 LAN IP（CN 不代替 IP SAN）；EKU serverAuth+KU；3 年。
     IP 变化只重签服务证书——CA 不变，客户端不必重新导入信任；
   - 复用按**实际 DER/PEM 核验**（不信 identity.json）：空 DN/过期/名称不覆盖/非本 CA 签发
     （CA 公钥验签）/私钥不配→按明确规则重签重生成；旧证书与旧文件移入
     remote/old-cert-diagnostics/<ts>/ 留诊断证据——**业务数据与 RESULTS 不动**；
   - 设置面呈现两枚指纹（服务证书+CA）与 Subject/Issuer；证书更换明确提示重新信任；
     私钥/PFX/CA 私钥只留服务机；**程序不自动安装信任根**。
2. **监听/网络/TLS 分层核验**：仅本机模式明确提示「其它设备无法连接」；LAN 模式启用后回
   **实际监听地址+两枚指纹+lanSelfCheck**（服务机本机经实际 LAN IP 的 HTTPS 探测，区分本机
   绑定/TLS 层与跨机防火墙层）；README 排查段按客户端错误码分层定位，防火墙步骤给准确
   程序/端口与专用网络范围（不关整个防火墙）。
3. **普通浏览器预检（工程侧，无任何证书绕过开关）**：`scripts/dev25-browser-precheck.mjs`
   ——普通系统 Edge：未授信→拦截页 net::ERR_CERT_AUTHORITY_INVALID（与结构无效区分——
   openssl 验链通过+Subject/SAN 核验）；工程侧临时安装 CA 到 CurrentUser Root（thumbprint
   留痕，测完卸载并复核拦截态回归）→ HTTPS 页面加载→配对→WSS 事件流；全部 8 项 PASS
   （证据 dist/desktop/dev25-browser-precheck/<ts>/evidence.json）。
   旧坏证书（空 DN、SAN 已覆盖当前需求）复用反例与干净数据根首次生成由
   tests/integration/remoteIdentity.test.ts 5/5 覆盖。

## 保留与更正

- 原自动化回归成果（remoteAccess 31/31、REMOTE 24/24、冻结 142/142×3=bld_12d1f5aeeff6a37e）
  **保留为既有回归**；其证书信任覆盖范围（Node 显式 CA/SPKI 钉选壳）**不代表普通浏览器入口
  已通过**——普通浏览器入口以本轮预检为准（8/8）。
- 本包为 **dev25-dual-win-v2**（独立版本目录，不覆盖旧包）；D1—D10 待用户执行回填。
