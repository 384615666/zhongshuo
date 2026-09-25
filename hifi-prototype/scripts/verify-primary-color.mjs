/**
 * 复核：主按钮在**启用/禁用**两种状态下的实际渲染色，
 * 并与参考图逐像素对照饱和度（属性直方图，而不只是均值）。
 *
 * 结论用于回答用户"新建群聊、发送、保存、引用按钮颜色没改"：
 * 需要区分「渐变没生效」与「渐变生效但被 disabled 的 opacity 冲淡」。
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-desktop-preview');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function conn() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = l.find((t) => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 25000);
    pending.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
  };
  return { ws, send, ev };
}

/** 取矩形内「前 20% 最饱和像素」的均值 —— 比全均值更能反映渐变端点色 */
function topSat(file, x, y, w, h) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${file}')
$list=New-Object System.Collections.ArrayList
for($yy=${Math.round(y)}; $yy -lt ${Math.round(y + h)}; $yy++){
  for($xx=${Math.round(x)}; $xx -lt ${Math.round(x + w)}; $xx++){
    if($xx -lt 0 -or $yy -lt 0 -or $xx -ge $b.Width -or $yy -ge $b.Height){ continue }
    $c=$b.GetPixel($xx,$yy)
    $s=[Math]::Max($c.R,[Math]::Max($c.G,$c.B))-[Math]::Min($c.R,[Math]::Min($c.G,$c.B))
    [void]$list.Add([pscustomobject]@{s=$s;r=$c.R;g=$c.G;b=$c.B})
  }
}
$sorted = $list | Sort-Object -Property s -Descending
$topN = [int]($sorted.Count * 0.2); if($topN -lt 1){$topN=1}
$sel = $sorted | Select-Object -First $topN
$ar=0;$ag=0;$ab=0;$as=0
foreach($p in $sel){ $ar+=$p.r;$ag+=$p.g;$ab+=$p.b;$as+=$p.s }
$n=$sel.Count
Write-Output ("sat={0} avg=#{1:x2}{2:x2}{3:x2}" -f [int]($as/$n),[int]($ar/$n),[int]($ag/$n),[int]($ab/$n))
$b.Dispose()`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
console.log('参考图 发送按钮       :', topSat(REF, 706, 822, 90, 23));
console.log('参考图 侧栏选中项     :', topSat(REF, 24, 288, 100, 12));

/* ---- Electron 窗口：私信页，打开新建弹窗 ---- */
const c = await conn();
await c.ev(`window.zhongshuo?.window.show()`);
await c.ev(`location.hash='/project/proj_zs_01/dm?recovery=0'; location.reload(); true`);
c.ws.close();
await sleep(3600);

let c2 = await conn();
const DPR = await c2.ev('window.devicePixelRatio') || 1;
await c2.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('新建私聊')); if(b)b.click(); return !!b; })()`);
await sleep(1300);
const r = await c2.ev(`(() => {
  const b = document.querySelector('.modal .btn.primary');
  const q = b.getBoundingClientRect();
  return { x:q.x, y:q.y, w:q.width, h:q.height, disabled:b.disabled, op:getComputedStyle(b).opacity };
})()`);
const shot = await c2.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(out, 'probe.png'), Buffer.from(shot.result.data, 'base64'));
console.log(`\nElectron 新建私聊「创建」: disabled=${r.disabled} opacity=${r.op}`);
console.log('  饱和度(前20%)       :', topSat(join(out, 'probe.png'), (r.x+6)*DPR, (r.y+4)*DPR, (r.w-12)*DPR, 6*DPR));

// 选一个成员 → 启用
await c2.ev(`(() => { const b=document.querySelector('.modal input[type="checkbox"]'); if(b)b.click(); return true; })()`);
await sleep(900);
const r2 = await c2.ev(`(() => {
  const b = document.querySelector('.modal .btn.primary');
  const q = b.getBoundingClientRect();
  return { x:q.x, y:q.y, w:q.width, h:q.height, disabled:b.disabled, op:getComputedStyle(b).opacity };
})()`);
const shot2 = await c2.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(out, 'probe2.png'), Buffer.from(shot2.result.data, 'base64'));
console.log(`Electron 新建私聊「创建」: disabled=${r2.disabled} opacity=${r2.op}`);
console.log('  饱和度(前20%)       :', topSat(join(out, 'probe2.png'), (r2.x+6)*DPR, (r2.y+4)*DPR, (r2.w-12)*DPR, 6*DPR));
c2.ws.close();
process.exit(0);
