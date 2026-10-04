'use strict';
/**
 * DEV-25 双机验收包构建（第三十二轮六建；第三十三轮一按缺口重写）。
 * **源=最终冻结产物**（dist/desktop/vdr-frozen——冻结三连逐文件 SHA256 复用的同一目录）：
 * - 拷贝后**逐文件重算 SHA256 对冻结 MANIFEST-SHA256.json 核对**（含 daemon.cjs——第三十二轮
 *   交付包是陈旧构建 bld_aeba86865045ebbf，daemon.cjs 与冻结基线 bld_d96713369ac153d0 不同而
 *   报告宣称同源——本轮起以逐文件核对为准，不再只改 buildId 文本）；
 * - **RESULTS 永不重建删除**（build 只重建应用与脚本目录；用户回填/截图/历史日志保留；
 *   RESULT-template.md 仍只在不存在时写入）——自测含「已有回填文件保护」反例；
 * - start-server.bat：管道名按独立数据根生成（server-data/pipe-name.txt 首启随机持久——两份
 *   包互不撞名）；内置 ZS_REMOTE_SELFCHECK=1（隔离验收模式——UI 自检按钮只在此模式开放，
 *   正式产品代码不带）；自测钩子 ZS_DEV25_DEBUG_PORT/ZS_DEV25_DRILL 仅自测注入。
 * 自测（--self-test）：**实际运行交付 .bat**（非自拼环境）：
 * - 清空开发终端全部 ZS_* 覆盖变量（继承常规系统环境）+中文与空格路径；
 * - 断言窗口打开（CDP）、合成项目实际可见、模拟模式明确（runtime.status=fake）、种子成功、
 *   停止演练可操作（--drill 真发任务→task.stop→收口）；
 * - 优雅停机走正式关窗链（Browser.close）：退出 0+requestDelivered+complete+非 forced+
 *   无残留进程（taskkill 仅失败兜底并如实记失败）；
 * - real_calls 核对子进程成功+结果结构（空 stdout 不当 0）；
 * - 同一包第二次启动：种子幂等（不重造房间/DM/消息——reused 标记+房间/私信计数不变）。
 */
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import * as craft from './lib/craftDocuments.mjs';

const randomIdSuffix = () => Math.random().toString(36).slice(2, 8);
const launcherLogs = []; // 自测启动原始输出快照（证据归档用——runLauncher 写入/selfTest 归档）
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const frozenDefault = join(repo, 'dist', 'desktop', 'vdr-frozen');
// 独立版本目录（第三十六轮四：不覆盖正在运行的旧包——ZS_DEV25_OUT/--out= 覆盖默认名）。
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outRoot = outArg != null ? resolve(repo, outArg.slice('--out='.length)) : join(repo, 'dist', 'desktop', process.env.ZS_DEV25_OUT ?? 'dev25-dual-win');

const BAT_LAUNCHER = [
  '@echo off',
  'rem DEV-25 dual-machine acceptance server launcher (ASCII only - codepage safe)',
  'setlocal EnableDelayedExpansion',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  'set DEMO_DIR=%PKG%demo-project',
  'if not exist "%APP_DIR%" mkdir "%APP_DIR%"',
  'rem Pipe name is generated once per data root (two package copies never collide).',
  'if not exist "%APP_DIR%\\pipe-name.txt" (',
  '  set PIPE_TAG=%RANDOM%%RANDOM%%RANDOM%',
  '  >"%APP_DIR%\\pipe-name.txt" echo zs-dev25-!PIPE_TAG!',
  ')',
  'set /p PIPE_SHORT=<"%APP_DIR%\\pipe-name.txt"',
  'set PIPE_NAME=\\\\.\\pipe\\!PIPE_SHORT!',
  'set ZS_APP_DATA=%APP_DIR%',
  'set ZS_RUNTIME=fake',
  'set ZS_ALLOW_FAKE=1',
  'set ZS_REAL_DISPATCH_GUARD=1',
  'set ZS_PIPE_NAME=!PIPE_NAME!',
  'set ZS_BOOTSTRAP_AGENTS=Guide A,Guide B',
  'set ZS_FAKE_STALL_MS=60000',
  'set ZS_REMOTE_SELFCHECK=1',
  'set SEED_FLAGS=--regression',
  'if "%ZS_DEV25_DRILL%"=="1" set SEED_FLAGS=--regression --drill',
  'echo Starting Zhongshuo desktop (fake runtime + real-dispatch guard, zero real model calls)...',
  'if not "%ZS_DEV25_DEBUG_PORT%"=="" (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe" --remote-debugging-port=%ZS_DEV25_DEBUG_PORT%',
  ') else (',
  '  start "ZhongshuoDual" "%PKG%ZhongshuoDual\\electron.exe"',
  ')',
  'echo Seeding demo project via formal commands (retries until daemon ready; idempotent)...',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%seed\\seed-client.cjs" --appdata "%APP_DIR%" --pipe "!PIPE_NAME!" --demo "%DEMO_DIR%" %SEED_FLAGS%',
  'if errorlevel 1 (echo SEED FAILED - see messages above. Close the app window and retry.) else (echo Seeded. RESULTS\\seed.json written.)',
  'echo.',
  'echo NEXT: in the app sidebar open the REMOTE ACCESS panel, choose LAN (0.0.0.0), click ENABLE,',
  'echo then click the pairing button and copy ADDRESS + FULL SHA-256 fingerprint for the client machine.',
  'echo Mechanical negatives: click the SELF-CHECK button in the panel (runs in-process), then run run-self-check.bat.',
  'echo Keep this console open during acceptance. Closing the app window exits the server.',
  'pause',
  'endlocal',
  '',
].join('\r\n');

const BAT_SELFCHECK = [
  '@echo off',
  'rem DEV-25 self-check results export (server machine, after clicking the SELF-CHECK button in UI)',
  'setlocal',
  'set PKG=%~dp0',
  'set APP_DIR=%PKG%server-data',
  '"%PKG%ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe" "%PKG%selfcheck\\self-check.cjs" --appdata "%APP_DIR%"',
  'pause',
  'endlocal',
  '',
].join('\r\n');

const SHORT_REGRESSION_TEMPLATE = `# DEV-25 v5 受影响项短回归结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 服务机（系统）/客户端（浏览器与版本）：
- buildId（RESULTS/buildId.txt）：
- 新信任根指纹（本包面板，64 位）：____（与 certutil 核对一致：是/否）

| # | 项 | 结论（PASS/FAIL/BLOCKED） | 说明 | 截图文件名 |
|---|---|---|---|---|
| R1 | 恢复演练·恢复执行 | | | |
| R2 | 队列演练·继续队列（桌面+远程） | | | |
| R3 | 重启后侧栏/项目自动恢复 | | | |
| R4 | 防护拒绑 claude（正式错误）/fake 可绑 | | | |
| R5 | 设备列表可滚动可达+LAN 虚拟网卡标注 | | | |
| R6 | PPT 视觉预览（默认房间已发消息附件芯片：图表/表格实际渲染·翻页/缩放生效；**正常预置样本视觉不可用≠通过**——降级呈现另记 FAIL 并截图原因） | | | |
| R7 | Word 视觉预览（📎附件→选择包内 samples/word-r7-sample.docx→点击芯片：表格/图片/分页呈现+**聊天界面按钮颜色不变**[样式隔离]） | | | |

异常与备注：
`;

const README = `# DEV-25 v5 修复候选包·受影响项短回归（Windows 服务机 + 同局域网客户端浏览器）

本包为**修复候选包**：D1—D10 全套已按 v2 包收案（docs/implementation/dev25-dual-acceptance-record-20261003.md），
本轮只做**受影响项短回归**（七项，见 \`SHORT-REGRESSION 指南\`——应用侧栏帮助或 docs 指南同文）。
不需要 SQL、Node、开发者工具；全部操作=双击启动器+浏览器+截图。

**产物来源**：\`ZhongshuoDual/\` 由最终冻结产物逐文件 SHA256 核对后拷贝（buildId 见
\`RESULTS/buildId.txt\`；核对事实 \`RESULTS/frozen-manifest-check.json\`）。fake runtime + 真实派发
硬防护——零真实模型调用（RESULTS 留 real_calls=0 证据）。

**证书体系与⚠️新数据根声明（v5）**：本地 CA（信任根，\`server-data/remote/ca.cer\`）+ CA 签发的
服务证书（SAN 覆盖 127.0.0.1/localhost/实际 LAN IP）。**v5 使用全新数据根——首次启动生成新 CA
与新服务证书，两枚指纹与 v2/v3/v4 均不同**：客户端必须重新导入**本包**的 \`ca.cer\` 并按下方步骤核对
**本包面板**显示的新「信任根指纹」。「IP 变化只重签服务证书、CA 不变」仅适用于**同一数据根**，
**不跨包/不跨数据根继承信任**——不要复用 v2/v3/v4 时期导入的旧 CA。

## 服务机步骤

1. 双击 \`start-server.bat\`（等 "Seeded." 与应用窗口；重复启动幂等）。启动器自动准备**短回归
   前置状态**（种子写入 RESULTS/seed.json 的 regression 段）：
   - 会话「恢复演练」：含 1 个**中断待恢复**任务（合成停机中断形态——种子构造，非真实执行）；
   - 会话「队列演练」：队列处于**暂停**态（正式停止合同产物）；
   - 默认房间：一条带 \`回归幻灯.pptx\` 附件的仅记录消息（点击附件芯片即可预览）。
   若窗口未自动进入「DEV25 双机验收」项目：侧栏「打开本地文件夹…」选包内 \`demo-project\` 或重启。
2. 应用侧栏 →「远程访问（DEV-25）」面板：
   - 监听地址选 **局域网（0.0.0.0）** → 点「启用」→ 面板核对**运行中地址+两枚指纹**（服务证书/
     信任根——都可点击复制）与 **LAN 自检**；
   - **监听只有「仅本机」与「局域网 0.0.0.0」两种**（无「监听具体 IP」入口）——客户端访问哪个
     地址从 **LAN 地址列表**选：每行可点击复制；多网卡机器会标注虚拟网卡段
     （198.18.x.x/169.254.x.x 等——「不是其它设备可达的地址」，别用）；
   - **配对码时机**：客户端完成证书信任（下节）**后**再点「生成配对码」（5 分钟一次有效）。
3. 防火墙（仅当客户端报超时）：Windows 防火墙 → 高级设置 → 入站规则 → 新建：
   - 程序方式：\`ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe\`（daemon 的 node，
     **不是 electron.exe**——完整路径为「本包目录\\ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe」）；或端口方式：面板显示的 TCP 端口；作用域=专用网络；
     **不需要关闭整个防火墙**。

## 客户端步骤（普通 Edge/Chrome——不使用任何证书错误绕过开关）

1. 浏览器打开服务机地址（从面板 LAN 地址列表选未标注警告的那行+端口）。
2. 首次出现证书提示（预期——新 CA 尚未授信）：
   ① 复制服务机 \`server-data/remote/ca.cer\` 到客户端机双击 → 安装证书 → 当前用户 →
   「受信任的根证书颁发机构」→ 完成；
   ② **指纹核对**：服务机上 \`certutil -hashfile server-data\\remote\\ca.cer SHA256\`
   （在包目录右键「在终端中打开」后执行；或 PowerShell：
   \`Get-FileHash server-data\\remote\\ca.cer -Algorithm SHA256\`）——输出须与面板
   「**信任根指纹**」**逐位一致**；安装时展开证书详情再核一次同值。**服务证书指纹单独记录**
   （两枚不要混用）；
   ③ 重开页面。**信任失败即停**——不点「高级→继续前往」。
   - Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书（先核对指纹）。
3. **此时**回服务机生成配对码 → 客户端配对页输入 pairingId+码+设备名 → 主界面。

## 连接问题分层排查（先取客户端具体错误，再定位层）

| 客户端现象 | 层 | 下一步 |
|---|---|---|
| ERR_CERT_AUTHORITY_INVALID / 证书提示 | 信任层 | 导入**本包** ca.cer（按上法核对指纹——旧包 CA 不通用） |
| ERR_CONNECTION_REFUSED / 超时 | 网络层 | 面板 LAN 自检通过→防火墙规则（上）；客户端 ping 服务机 IP |
| ERR_SSL_PROTOCOL_ERROR | 端口/协议 | 核对地址端口与面板一致（https:// 前缀） |

## 短回归与结果

- 七项回归（R1 恢复执行/R2 继续队列/R3 侧栏恢复/R4 防护拒绑/R5 设备列表可达/R6 PPT 视觉预览[正常样本必须实际渲染]/R7 Word 预览+样式隔离）：
  按 \`RESULTS/SHORT-REGRESSION-template.md\` 执行并回填（每项 PASS/FAIL/BLOCKED+一句话+截图名）。
- R7 用包内样本 \`samples/word-r7-sample.docx\`（已验证的无隐私 Word 样本：3 页/表格/图片/页眉）：
  打开任一会话 → 点发送框「📎附件」→ 选择该文件 → 点击出现的芯片预览——**产品无拖放上传入口**，
  不用拖入；只预览即可，不要求发送或发起任务。
- 机械负例自检保留（可选）：面板「自检（机械负例）」→ 双击 \`run-self-check.bat\` 导出
  （输出在本包 \`RESULTS/self-check-*.json\`）。
- **短回归通过 ≠ D 系全项重测**；Android 实测另按指南（适配≠实测）。
- 工程侧只读核对截图/RESULTS/服务侧事实；未执行/失败/未确认分列，不代宣称通过。

## 边界

- 本包模拟运行（fake+真实派发硬防护）；私钥只留服务机；不降级 HTTP；凭据不落明文日志。
- v2/v3/v4 包与其数据/结果原地保留——本包独立目录、独立数据根，互不影响。`;

const RESULT_TEMPLATE = `# DEV-25 双机验收结果（用户回填——本文件不会被程序覆盖）

- 日期/参与人：
- 服务机（包路径/系统）：
- 客户端机（浏览器与版本）：
- 服务地址：
- 证书 SHA-256 指纹（完整 64 位，两端核对一致）：____
- buildId（RESULTS/buildId.txt）：

| # | 项 | 操作摘要 | 结论 | 证据（截图文件名/说明） |
|---|---|---|---|---|
| D1 | 同一数据可见 | 打开页面后会话/任务/事件与服务机一致 | | |
| D2 | 仅记录消息+事件流 | 发「仅记录」→双端出现+事件流 message.submitted | | |
| D3 | 附件上传并发送 | 上传小文本→发送→双端 📎 呈现 | | |
| D4 | 停止演练 | DM A 发任务（首任务有 60s 停滞窗）→客户端「停止」→状态停 | | |
| D5 | 验收演练 | DM B 发任务→完成待验收→客户端「验收通过」→DONE | | |
| D6 | 重试恰一次 | 断网/刷新后页面「结果未知的操作」重试→消息恰一条 | | |
| D7 | 关闭客户端任务继续 | 发任务→关浏览器→重开→结果消息可见 | | |
| D8 | 吊销终态 | 服务机吊销→客户端立即断流+明确终态横幅 | | |
| D9 | 伪造 Host/Origin 等（自动化） | UI 自检按钮结论+run-self-check.bat 导出 | | self-check-*.json |
| D10 | 错码（自动化） | UI 自检按钮结论+run-self-check.bat 导出 | | self-check-*.json |

异常与备注：
`;

function sha256File(p) {
  return new Promise((resolveP, rejectP) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolveP(h.digest('hex'))).on('error', rejectP);
  });
}

/** 构建：源=冻结产物；逐文件 SHA256 核对；RESULTS 永不删除。 */
async function build(frozenDir = frozenDefault) {
  if (!existsSync(frozenDir)) throw new Error('frozen artifact not found: ' + frozenDir + '——先完成冻结序列（freeze 三连）');
  const buildMeta = JSON.parse(readFileSync(join(frozenDir, 'BUILD.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(frozenDir, 'MANIFEST-SHA256.json'), 'utf8'));
  const buildId = buildMeta.buildId;
  // 只重建应用与脚本目录——RESULTS（用户回填/截图/历史日志）保留。
  rmSync(join(outRoot, 'ZhongshuoDual'), { recursive: true, force: true });
  rmSync(join(outRoot, 'seed'), { recursive: true, force: true });
  rmSync(join(outRoot, 'selfcheck'), { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  cpSync(frozenDir, join(outRoot, 'ZhongshuoDual'), { recursive: true, dereference: true });
  mkdirSync(join(outRoot, 'seed'), { recursive: true });
  mkdirSync(join(outRoot, 'selfcheck'), { recursive: true });
  mkdirSync(join(outRoot, 'RESULTS'), { recursive: true });
  mkdirSync(join(outRoot, 'RESULTS', 'shots'), { recursive: true });
  cpSync(join(repo, 'scripts', 'dev25-dual', 'seed-client.cjs'), join(outRoot, 'seed', 'seed-client.cjs'));
  cpSync(join(repo, 'scripts', 'dev25-dual', 'self-check.cjs'), join(outRoot, 'selfcheck', 'self-check.cjs'));
  // 第四十一轮 §5：预览 vendor 许可/来源材料随包（实际分发依赖逐项核对路径存在）。
  const licDir = join(outRoot, 'licenses-preview-vendor');
  mkdirSync(licDir, { recursive: true });
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'PROVENANCE.json'), join(licDir, 'pptx-renderer.PROVENANCE.json'));
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'LICENSE'), join(licDir, 'pptx-renderer.LICENSE'));
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'THIRD_PARTY_NOTICES.md'), join(licDir, 'pptx-renderer.THIRD_PARTY_NOTICES.md'));
  cpSync(join(repo, 'node_modules', 'docx-preview', 'LICENSE'), join(licDir, 'docx-preview.LICENSE'));
  cpSync(join(repo, 'node_modules', 'jszip', 'LICENSE.markdown'), join(licDir, 'jszip.LICENSE.markdown'));
  cpSync(join(repo, 'node_modules', 'dompurify', 'LICENSE'), join(licDir, 'dompurify.LICENSE'));
  cpSync(join(repo, 'node_modules', 'dompurify', 'LICENSE-MPL'), join(licDir, 'dompurify.LICENSE-MPL'));
  cpSync(join(repo, 'node_modules', 'markdown-it', 'LICENSE'), join(licDir, 'markdown-it.LICENSE'));
  // 第四十二轮 §5：NOTICE 相对引用的源材料随包（同一钉版 tarball 逐文件原样拷贝——
  // PROVENANCE.noticesMaterial 记录各文件 sha256；引用路径真实可达，不以「九件存在」当闭环）。
  const noticeDir = join(licDir, 'pptx-renderer-notices');
  mkdirSync(noticeDir, { recursive: true });
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'licenses', 'mtx-decompressor-MPL-2.0.txt'), join(noticeDir, 'mtx-decompressor-MPL-2.0.txt'));
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'licenses', 'ECMA-text-copyright-notice.txt'), join(noticeDir, 'ECMA-text-copyright-notice.txt'));
  cpSync(join(repo, 'src', 'ui', 'vendor', 'pptx-renderer', 'scripts', 'ooxml-geometry', 'source-manifest.json'), join(noticeDir, 'ooxml-geometry-source-manifest.json'));
  writeFileSync(join(licDir, 'README.md'), [
    '# 预览引擎随包材料（第四十一轮建；第四十二轮补 NOTICE 引用源材料）',
    '',
    'pptx-renderer 1.3.0=受管 vendored 产物（PROVENANCE 钉版本+sha256；内捆 JSZip+ECharts——ECharts 为 Apache-2.0，其 notice 见 pptx-renderer.THIRD_PARTY_NOTICES.md）。',
    'docx-preview 0.4.1（MIT）/JSZip 3.10.2（MIT）/DOMPurify（Apache-2.0 或 MPL-2.0 双许可）/markdown-it（MIT）从固定版本 node_modules 拷贝。',
    'pptx-renderer.THIRD_PARTY_NOTICES.md 相对引用的源材料在 pptx-renderer-notices/（同 tarball 原样拷贝，逐文件 sha256 见 pptx-renderer.PROVENANCE.json 的 noticesMaterial）。',
    '全部本地随包，无 CDN。嵌入 HTML（altChunks）首版不支持（renderAltChunks:false）。',
    '',
  ].join('\n'));
  writeFileSync(join(outRoot, 'start-server.bat'), BAT_LAUNCHER, 'ascii');
  writeFileSync(join(outRoot, 'run-self-check.bat'), BAT_SELFCHECK, 'ascii');
  writeFileSync(join(outRoot, 'README-双机验收.md'), README, 'utf8');
  // 第四十二轮 §5（review-r41）：README 字节核验——模板字面量反斜杠转义曾把防火墙程序路径
  // 打成含 CR/LF 的多行坏路径（v5 实测 \`ZhongshuoDual<CR>esourcesapp…\`）。生成后断言完整
  // 单行路径存在且路径段内无 CR/LF，坏路径不再流向用户。
  {
    const readmeOut = readFileSync(join(outRoot, 'README-双机验收.md'), 'utf8');
    const wantPath = 'ZhongshuoDual\\resources\\app\\daemon\\node\\node.exe';
    if (!readmeOut.includes(wantPath)) throw new Error(`README 防火墙路径核验失败：未找到完整单行路径 ${wantPath}`);
    const seg = readmeOut.slice(readmeOut.indexOf(wantPath) - 1, readmeOut.indexOf(wantPath) + wantPath.length + 1);
    if (/[\r\n]/.test(seg)) throw new Error('README 防火墙路径核验失败：路径段内含 CR/LF');
  }
  // R7 Word 回归样本随包（已验证无隐私：3 页/表格/图片/页眉——verify-word-isolation W4）。
  mkdirSync(join(outRoot, 'samples'), { recursive: true });
  cpSync(join(repo, 'scripts', 'dev25-dual', 'samples', 'word-r7-sample.docx'), join(outRoot, 'samples', 'word-r7-sample.docx'));
  // 第三十九轮 §5：短回归前置材料——回归幻灯.pptx（规范 OOXML 样本：中文/图片/图表/表格/组合/
  // 实体字符/跳号页序）随包，seed --regression 上传为房间仅记录消息附件。
  writeFileSync(join(outRoot, 'seed', '回归幻灯.pptx'), craft.makePptxPagesSample({
    slides: [
      { no: 1, shapes: [{ x: 60 * 9525, y: 40 * 9525, cx: 520 * 9525, cy: 90 * 9525, texts: ['回归幻灯：短回归 R6 预览样本'], sz: 2000 }, { x: 60 * 9525, y: 150 * 9525, cx: 520 * 9525, cy: 40 * 9525, texts: ['第 1 页——翻页/缩放/缓存核对'] }], notes: '首页备注词' },
      { no: 2, shapes: [{ x: 60 * 9525, y: 60 * 9525, cx: 480 * 9525, cy: 60 * 9525, texts: ['第 2 页：内容确实变化（实体字符 A & B 与 <标签>）'], rawText: false }] },
      { no: 3, shapes: [{ x: 60 * 9525, y: 60 * 9525, cx: 480 * 9525, cy: 60 * 9525, texts: ['第 3 页：图表降级页'] }, { x: 60 * 9525, y: 130 * 9525, cx: 480 * 9525, cy: 280 * 9525, kind: 'chart' }] },
    ],
  }));
  // 短回归模板与指南（不覆盖用户回填；指南同 docs/implementation/dev25-short-regression-guide.md）。
  const shortTplPath = join(outRoot, 'RESULTS', 'SHORT-REGRESSION-template.md');
  if (!existsSync(shortTplPath)) writeFileSync(shortTplPath, SHORT_REGRESSION_TEMPLATE, 'utf8');
  const tplPath = join(outRoot, 'RESULTS', 'RESULT-template.md');
  if (!existsSync(tplPath)) writeFileSync(tplPath, RESULT_TEMPLATE, 'utf8'); // 不覆盖用户回填
  writeFileSync(join(outRoot, 'RESULTS', 'buildId.txt'), String(buildId) + '\n', 'ascii');
  // **逐文件核对（第三十三轮一）**：包内每个清单文件重算 SHA256 对冻结清单——含 daemon.cjs。
  const appDir = join(outRoot, 'ZhongshuoDual');
  let verified = 0;
  const mismatches = [];
  const listed = new Set();
  for (const entry of manifest.files ?? []) {
    listed.add(entry.path);
    const target = join(appDir, entry.path);
    if (!existsSync(target)) { mismatches.push(`缺失 ${entry.path}`); continue; }
    const actual = await sha256File(target);
    if (actual !== entry.sha256) mismatches.push(`SHA256 不符 ${entry.path}（清单 ${entry.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`);
    else verified += 1;
  }
  const extras = [];
  const walkExtras = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel.length === 0 ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walkExtras(join(d, e.name), r);
      else if (!listed.has(r) && r !== 'BUILD.json' && r !== 'MANIFEST-SHA256.json') extras.push(r);
    }
  };
  walkExtras(appDir, '');
  const checkReport = { at: new Date().toISOString(), source: frozenDir, buildId, filesInManifest: (manifest.files ?? []).length, verified, mismatches, extras, result: mismatches.length === 0 && extras.length === 0 ? 'pass' : 'fail' };
  writeFileSync(join(outRoot, 'RESULTS', 'frozen-manifest-check.json'), JSON.stringify(checkReport, null, 2), 'utf8');
  if (checkReport.result !== 'pass') {
    throw new Error(`冻结产物逐文件核对失败（${mismatches.length} 不符 / ${extras.length} 多余）：${[...mismatches, ...extras].slice(0, 5).join('；')}`);
  }
  console.log(`[dev25-dual] package ready: ${outRoot} buildId=${buildId}（逐文件核对 ${verified}/${manifest.files?.length ?? 0} 通过）`);
  return { buildId, verified };
}

// ---------- 自测 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpCall(port, method, params = {}) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cdp timeout: ' + method)), 20_000);
    ws.once('message', (d) => { clearTimeout(t); try { res(JSON.parse(String(d))); } catch (e) { rej(e); } });
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return out;
}

async function cdpEvalPage(port, expr) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (page == null) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const out = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('cdp eval timeout')), 20_000);
    ws.once('message', (d) => {
      clearTimeout(t);
      try {
        const m = JSON.parse(String(d));
        if (m.result?.exceptionDetails) rej(new Error(String(m.result.exceptionDetails.text)));
        else res(m.result?.result?.value);
      } catch (e) { rej(e); }
    });
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return out;
}

/** 等桌面页面就绪：窗口打开→种子完成（seed.json）→reload 走自动打开链→项目可见+模拟模式明确。 */
async function assertAppFacts(port, appData) {
  const t0 = Date.now();
  let pageOk = false;
  while (Date.now() - t0 < 60_000) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (pages.some((p) => p.type === 'page')) { pageOk = true; break; }
    } catch (e) { /* 未就绪 */ }
    await sleep(1000);
  }
  if (!pageOk) throw new Error('窗口未打开（60s 无 page target）');
  // 种子完成（seed.json 落盘=UI 自动打开记忆已写）。
  const seedPath = join(appData, '..', 'RESULTS', 'seed.json');
  while (Date.now() - t0 < 150_000) {
    if (existsSync(seedPath)) break;
    await sleep(3000);
  }
  if (!existsSync(seedPath)) throw new Error('种子未完成（150s 无 seed.json）');
  // reload 走「服务端记忆回退」同链路（ui.autoOpenProjectPath）——合成项目实际可见。
  await cdpEvalPage(port, 'location.reload()').catch(() => { /* 已导航 */ });
  let projectName = '';
  while (Date.now() - t0 < 210_000) {
    try {
      projectName = await cdpEvalPage(port, `(document.getElementById('project-name')?.textContent ?? '')`);
      if (String(projectName).includes('DEV25 双机验收')) break;
    } catch (e) { /* 页面切换中 */ }
    await sleep(2000);
  }
  if (!String(projectName).includes('DEV25 双机验收')) throw new Error('合成项目不可见：project-name=' + String(projectName).slice(0, 80));
  // 模拟模式明确：runtime.status 成员绑定无任何真实渠道（claude/codex），未绑定成员显示
  // 「(默认 runtime)」=走 daemon 默认（启动器内置 ZS_RUNTIME=fake）；真实渠道绑定出现即失败。
  const runtimeRaw = await cdpEvalPage(port, `window.zs && window.zs.command ? window.zs.command({ protocolVersion: 1, commandId: 'selftest-runtime-status-' + Math.floor(Math.random() * 1e6), method: 'runtime.status', params: {} }).then((r) => JSON.stringify((r.data && r.data.memberBindings) || [])) : 'no-bridge'`);
  if (String(runtimeRaw) === 'no-bridge') throw new Error('桌面页面无命令桥（未就绪）');
  const bindings = JSON.parse(String(runtimeRaw));
  const fakeBinding = bindings.length > 0 && bindings.every((b) => String(b.kind ?? '') === 'fake' || String(b.kind ?? '') === '(默认 runtime)');
  if (!fakeBinding) throw new Error('模拟模式不明确（出现真实渠道绑定或无绑定）：' + String(runtimeRaw).slice(0, 200));
  return { projectName: String(projectName).slice(0, 40), fakeBinding };
}

/** 本包 electron 进程清单（按包路径过滤——不影响开发机其他实例）。 */
function listElectronPids(pkg) {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '${pkg.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', timeout: 30_000 });
  return String(ps.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 优雅停机：页面 window.close()（等价用户关窗——window-all-closed→daemon.shutdown 正式链；
 * CDP Browser.close 会直杀浏览器进程绕过停机链——不用于成功路径）。 */
async function gracefulStop(port, pkg) {
  await cdpEvalPage(port, 'window.close()').catch(() => { /* 页面随关窗销毁——以停机事实为准 */ });
  const t0 = Date.now();
  let facts = null;
  let residual = ['(unchecked)'];
  while (Date.now() - t0 < 45_000) {
    facts = readShutdownFacts(join(pkg, 'server-data'));
    residual = listElectronPids(pkg);
    if (facts != null && residual.length === 0) break;
    await sleep(1000);
  }
  const ok = facts != null && residual.length === 0
    && facts.requestDelivered === true && facts.exitCode === 0
    && facts.forceKilled !== true && facts.timedOut !== true
    && facts.daemonStopResult?.complete === true && facts.daemonStopResult?.forced !== true;
  return { ok, facts, residual, detail: `del=${facts?.requestDelivered} exit=${facts?.exitCode} forced=${facts?.forceKilled} timedOut=${facts?.timedOut} stop=${facts?.daemonStopResult?.complete}/${facts?.daemonStopResult?.forced} 残留=${residual.length}` };
}

function readShutdownFacts(appData) {
  const p = join(appData, 'desktop-shutdown.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function realCallsCheck(pkg, appData) {
  const node = join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe');
  const rc = spawnSync(node, ['-e', 'const D=require(' + JSON.stringify(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node_modules', 'better-sqlite3')) + ');const db=new D(' + JSON.stringify(join(appData, 'state.sqlite')) + ',{readonly:true});const c=db.prepare("SELECT count(*) c FROM real_calls").get().c;console.log(c);db.close();'],
    { encoding: 'utf8', timeout: 30_000 });
  // 结构核验（第三十三轮一）：子进程成功+stdout 是整数——空/坏输出不当 0。
  if (rc.status !== 0 || rc.error != null) return { ok: false, detail: `rc.status=${String(rc.status)} err=${String(rc.stderr).slice(0, 120)}` };
  const n = Number(String(rc.stdout).trim());
  if (!Number.isInteger(n)) return { ok: false, detail: `stdout 非整数：${String(rc.stdout).slice(0, 60)}` };
  return { ok: n === 0, detail: `real_calls=${n}` };
}

/** 实跑交付 .bat（清空开发 ZS_*——启动器自注入全部变量；自测只加调试端口/演练钩子）。 */
async function runLauncher(pkg, debugPort, drill) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith('ZS_')) cleanEnv[k] = v;
  }
  cleanEnv.ZS_DEV25_DEBUG_PORT = String(debugPort);
  if (drill) cleanEnv.ZS_DEV25_DRILL = '1';
  const child = spawn('cmd.exe', ['/c', join(pkg, 'start-server.bat')], { cwd: pkg, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('\r\n'); // pause 预供（到达即过）
  return { child, getOut: () => out, snapshotOut: () => { launcherLogs.push('===== ' + new Date().toISOString() + ' =====\n' + out); } };
}

async function selfTest() {
  // 阶段 0：RESULTS 保护反例——已有回填文件在重建后必须原样保留。
  const markerPath = join(outRoot, 'RESULTS', '用户回填保护反例.md');
  const tplPath = join(outRoot, 'RESULTS', 'RESULT-template.md');
  const pristineTpl = existsSync(tplPath) ? readFileSync(tplPath, 'utf8') : RESULT_TEMPLATE;
  mkdirSync(join(outRoot, 'RESULTS'), { recursive: true });
  writeFileSync(markerPath, '用户回填标记 SELFTEST-KEEP-951\n', 'utf8');
  writeFileSync(tplPath, pristineTpl + '\n<!-- 用户已回填 SELFTEST-TPL-952 -->\n', 'utf8');
  const built = await build();
  const markerKept = existsSync(markerPath) && readFileSync(markerPath, 'utf8').includes('SELFTEST-KEEP-951');
  const tplKept = readFileSync(tplPath, 'utf8').includes('SELFTEST-TPL-952');
  console.log('[self-test] results-protection ' + (markerKept && tplKept ? 'PASS' : 'FAIL') + `（marker=${markerKept} template=${tplKept}）`);
  // 还原洁净模板与移除反例标记（交付包不带自测痕迹）。
  writeFileSync(tplPath, pristineTpl, 'utf8');
  rmSync(markerPath, { force: true });
  if (!markerKept || !tplKept) throw new Error('RESULTS 保护反例失败——重建删除了用户结果');
  // 阶段 1：中文+空格临时目录（普通用户环境等价）；副本与包本体互不撞管道名。
  const tmp = mkdtempSync(join(tmpdir(), '双机 自测-'));
  const pkg = join(tmp, 'dev25-dual-win');
  cpSync(outRoot, pkg, { recursive: true, dereference: true });
  const appData = join(pkg, 'server-data');
  const evidenceDir = join(repo, 'dist', 'desktop', 'dev25-dual-evidence', new Date().toISOString().replace(/[:T]/g, '').slice(0, 14) + '-' + randomIdSuffix());
  const seedJson = () => {
    const p = join(pkg, 'RESULTS', 'seed.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  /** 证据归档（第三十四轮四.3）：原始启动输出/种子/停机事实/real_calls/保护结论——临时目录清理前落持久目录。 */
  const archiveEvidence = (label) => {
    try {
      mkdirSync(evidenceDir, { recursive: true });
      const runLog = join(evidenceDir, label + '-launcher-output.log');
      writeFileSync(runLog, launcherLogs.join('\n'), 'utf8');
      for (const [name, src] of [
        [label + '-seed.json', join(pkg, 'RESULTS', 'seed.json')],
        [label + '-desktop-shutdown.json', join(appData, 'desktop-shutdown.json')],
      ]) {
        if (existsSync(src)) writeFileSync(join(evidenceDir, name), readFileSync(src, 'utf8'), 'utf8');
      }
      const rc = realCallsCheck(pkg, appData);
      writeFileSync(join(evidenceDir, label + '-real-calls.txt'), JSON.stringify({ checkedAt: new Date().toISOString(), childOk: rc.detail.startsWith('real_calls='), detail: rc.detail }), 'utf8');
      console.log('[self-test] evidence -> ' + join(evidenceDir, label + '-*'));
    } catch (e) { console.log('[self-test] evidence 尽力失败：' + (e && e.message)); }
  };
  let rc1Detail = 'not-reached';
  try {
    let facts1 = null;
    {
      console.log('[self-test] 启动 1/2（实跑 start-server.bat + 演练）…');
      const run = await runLauncher(pkg, 9391, true);
      void run;
      const appFacts = await assertAppFacts(9391, appData);
      console.log('[self-test] app-facts PASS（project=' + appFacts.projectName + ' runtime=fake）');
      const t0 = Date.now();
      while (Date.now() - t0 < 150_000) {
        facts1 = seedJson();
        if (facts1 != null && facts1.drill != null) break;
        await sleep(3000);
      }
      if (facts1 == null || facts1.ids?.dmConversationA == null) throw new Error('种子失败：seed.json 缺失或不完整');
      if (facts1.drill.stopAccepted !== true || facts1.drill.stoppedAtExecState !== 'terminal') {
        throw new Error('停止演练未收口：' + JSON.stringify(facts1.drill));
      }
      console.log('[self-test] seed+drill PASS（reused=' + String(facts1.reused) + ' drill=' + facts1.drill.stoppedAtExecState + ' ' + facts1.drill.elapsedMs + 'ms）');
      // 优雅停机（正式关窗链——非 taskkill）。
      const stop1 = await gracefulStop(9391, pkg);
      console.log('[self-test] graceful-stop 1 ' + (stop1.ok ? 'PASS' : 'FAIL') + '（' + stop1.detail + '）');
      if (!stop1.ok) throw new Error('优雅停机 1 失败（强杀兜底不参与成功路径——见事实）');
      const rc1 = realCallsCheck(pkg, appData);
      rc1Detail = rc1.detail;
      console.log('[self-test] real_calls 1 ' + (rc1.ok ? 'PASS' : 'FAIL') + '（' + rc1.detail + '）');
      if (!rc1.ok) throw new Error('real_calls 核对失败：' + rc1.detail);
      run.snapshotOut();
      archiveEvidence('launch1');
      await sleep(2000); // 端口/句柄释放余量。
    }
    {
      // 阶段 2：同一包第二次启动——种子幂等（不重造房间/DM/消息）。
      console.log('[self-test] 启动 2/2（同包二次启动——种子幂等）…');
      rmSync(join(pkg, 'RESULTS', 'seed.json'), { force: true }); // 等本启新鲜结果（不读旧文件）
      const run2 = await runLauncher(pkg, 9392, false);
      void run2;
      await assertAppFacts(9392, appData);
      const t0 = Date.now();
      let facts2 = null;
      while (Date.now() - t0 < 150_000) {
        facts2 = seedJson();
        if (facts2 != null) break;
        await sleep(3000);
      }
      if (facts2 == null) throw new Error('二次启动种子未完成');
      // 事实核对：种子私信恰 2 条且标题命中（不重造）。
      const dms = await cdpEvalPage(9392, `window.zs.command({ protocolVersion: 1, commandId: 'selftest-2nd-list-1', method: 'conversation.list', params: {} }).then((r) => JSON.stringify((r.data && r.data.conversations) || []))`);
      const convList = JSON.parse(String(dms));
      const seededDmTitles = convList.filter((c) => c.title === 'DM A - stop drill' || c.title === 'DM B - accept drill').length;
      const seedMsgCount = facts2.commands?.['message.submit'] ?? 0;
      console.log('[self-test] second-launch idempotent ' + (facts2.reused === true && seededDmTitles === 2 && seedMsgCount === 0 ? 'PASS' : 'FAIL') + `（reused=${String(facts2.reused)} seededDms=${seededDmTitles} newMessages=${seedMsgCount}）`);
      if (facts2.reused !== true || seededDmTitles !== 2 || seedMsgCount !== 0) throw new Error('二次启动种子不幂等（reused=' + String(facts2.reused) + ' dms=' + seededDmTitles + ' newMessages=' + seedMsgCount + '）');
      const stop2 = await gracefulStop(9392, pkg);
      console.log('[self-test] graceful-stop 2 ' + (stop2.ok ? 'PASS' : 'FAIL') + '（' + stop2.detail + '）');
      if (!stop2.ok) throw new Error('优雅停机 2 失败');
      run2.snapshotOut();
      archiveEvidence('launch2');
    }
    const rc = realCallsCheck(pkg, appData);
    const pass = rc.ok;
    try {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'summary.txt'), `buildId=${built.buildId}
verified=${built.verified}
launch1: seed+drill PASS, graceful-stop PASS, real_calls ${rc1Detail}
launch2: idempotent PASS, graceful-stop PASS
results-protection: PASS
final: ${pass ? 'PASS' : 'FAIL'}
at=${new Date().toISOString()}
`, 'utf8');
    } catch { /* 尽力 */ }
    writeFileSync(join(pkg, 'RESULTS', 'selftest-summary.txt'),
      `buildId=${built.buildId}\nverified=${built.verified}\nlaunch1: seed+drill PASS, graceful-stop PASS, real_calls ${rc.detail}\nlaunch2: idempotent PASS, graceful-stop PASS\nresults-protection: PASS\nat=${new Date().toISOString()}\n`, 'utf8');
    console.log('[self-test] ' + (pass ? 'PASS' : 'FAIL') + ' buildId=' + built.buildId + ' pkg=' + pkg);
    if (!pass) process.exit(1);
  } finally {
    // 清理：先确保进程收口（失败兜底强杀并如实记录），再删临时目录。
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '${pkg.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
      { timeout: 30_000 });
    for (let i = 0; i < 5; i += 1) { try { rmSync(tmp, { recursive: true, force: true }); break; } catch { /* 句柄 */ } }
  }
}

const mode = process.argv.includes('--self-test') ? '--self-test' : (process.argv[2] ?? '--build');
const frozenArg = process.argv.find((a) => a.startsWith('--frozen='));
if (mode === '--self-test') {
  await selfTest();
} else {
  await build(frozenArg != null ? resolve(repo, frozenArg.slice('--frozen='.length)) : frozenDefault);
}
