'use strict';
/**
 * DEV-25 双机验收——自检结果导出（第三十三轮六重做）。
 * 机械负例（错码 401+fail_count 递增/伪造 Host 403/伪造 Origin 403/无 token 401/同 commandId
 * 恰一次+remote_audit_log 事实核对/自检设备吊销清理）**已改为服务进程内执行**（UI 远程面板
 * 「自检（机械负例）」按钮——remote.pairing.selfcheck，仅隔离验收模式 ZS_REMOTE_SELFCHECK=1
 * 开放；明文码只在进程内使用、结束即失效，不落任何存储）。本脚本只做两件事：
 * - 读取 server-data/selfcheck-latest.json（自检报告），核对结构完整与全项结论；
 * - 复制为 RESULTS/self-check-<ts>.json 并打印摘要（用户回填唯一真源不受影响）。
 * 报告缺失=提示先在 UI 点自检按钮（如实退出码 2，不冒充）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const appDataDir = argOf('--appdata');
if (appDataDir == null) { console.error('usage: node self-check.cjs --appdata <dir>'); process.exit(2); }
const pkgRoot = path.dirname(appDataDir); // RESULTS 与 appData（server-data）同级（第三十八轮：原多取一层 dirname 导致输出落包外 dist/desktop/RESULTS）

(async () => {
  const src = path.join(appDataDir, 'selfcheck-latest.json');
  if (!fs.existsSync(src)) {
    console.error('[self-check] 未找到自检报告——先在应用「远程访问」面板点「自检（机械负例）」按钮，再运行本脚本');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    console.error('[self-check] 自检报告损坏：' + (e && e.message));
    process.exit(1);
  }
  const items = Array.isArray(report.items) ? report.items : [];
  if (items.length === 0) {
    console.error('[self-check] 自检报告无结论项——重跑 UI 自检按钮');
    process.exit(1);
  }
  for (const it of items) {
    console.log((it.ok ? 'PASS ' : 'FAIL ') + String(it.name).slice(0, 90) + ' | ' + String(it.detail).slice(0, 110));
  }
  // 凭据脱敏核对（结果文件不含明文凭据——R11/第三十三轮六合同）。
  const raw = fs.readFileSync(src, 'utf8');
  const hasSecret = /zc_[A-Za-z0-9_-]{20,}/.test(raw) || /"accessToken"/.test(raw) || /"ticket"\s*:/.test(raw);
  if (hasSecret) {
    console.error('[self-check] 结果文件疑似含凭据明文——拒绝导出（合同违约）');
    process.exit(1);
  }
  // 证书指纹一致性（人工核对 UI 完整指纹）——两层证书分别登记（第三十八轮：模板分别记录
  // CA 与服务证书两枚指纹——identity.cer=服务证书；ca.cer=信任根，客户端导入信任时核对它）。
  let fingerprint = null;
  let caFingerprint = null;
  const cerPath = path.join(appDataDir, 'remote', 'identity.cer');
  if (fs.existsSync(cerPath)) {
    fingerprint = crypto.createHash('sha256').update(fs.readFileSync(cerPath)).digest('hex');
    console.log('INFO  服务证书 SHA-256 指纹（人工核对 UI 完整 64 位一致）| ' + fingerprint);
  }
  const caPath = path.join(appDataDir, 'remote', 'ca.cer');
  if (fs.existsSync(caPath)) {
    caFingerprint = crypto.createHash('sha256').update(fs.readFileSync(caPath)).digest('hex');
    console.log('INFO  信任根（CA）SHA-256 指纹（客户端导入 ca.cer 时核对）| ' + caFingerprint);
  }
  const resultsDir = path.join(pkgRoot, 'RESULTS');
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = { at: new Date().toISOString(), source: src, fingerprint, caFingerprint, pass: items.filter((i) => i.ok).length, total: items.length, items, secretsRedacted: true };
  fs.writeFileSync(path.join(resultsDir, 'self-check-' + Date.now() + '.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('[self-check] ' + out.pass + '/' + out.total + ' -> RESULTS/self-check-*.json');
  process.exit(out.pass === out.total ? 0 : 1);
})().catch((e) => { console.error('[self-check] ERROR: ' + (e && e.message)); process.exit(1); });
