/**
 * 解析池生命周期与队列身份（第三十轮一/二/三）：
 * - **队列身份**：排队项各自带 kind/blob/hash/参数——慢 A(pdf)→B(docx)→C(csv) 逐项按
 *   **自己的内容**结算（修复前 B 会被当 A 解析）；A 超时/失败不影响 B/C；
 * - 命令层三会话并发上传：各自 artifact 归属/缓存 sourceHash/内容暗号对上；
 * - IPC 超时语义：UI 放弃等待后同 commandId 重试=回执预查返回持久结果，不生成另一请求；
 * - dev worker 源码指纹：旧指纹产物自动重建；
 * - OOM（外部 Buffer 大额分配）：整进程提交内存上限由 Job Object 承载——子进程被收拢、
 *   daemon 后续命令正常（--max-old-space-size 不约束 Buffer 的缺口由此闭合）；
 * - zip 实际输出上限（说谎声明：deflate 声明小、解出大——流式计数拒，不等整包解完）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { ParsePool, disposeParsePool, getParsePool } from '../../src/daemon/parsePool.ts';
import { PARSE_TOTAL_MEMORY_LIMIT_BYTES } from '../../src/daemon/parseContracts.ts';
import { jobObjectCapability } from '../../src/daemon/parseJobObject.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { makeAsciiPdf, makeDocx, makeCsvText } from '../../scripts/lib/craftDocuments.mjs';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;
process.env.ZS_TEST_PARSE_HOOKS = '1';
delete process.env.ZS_TEST_PARSE_BUSY_MS;
delete process.env.ZS_TEST_PARSE_ALLOC_MB;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-parselife-'));
const appData = join(tmpRoot, 'app-data');
mkdirSync(join(tmpRoot, 'blobstore'), { recursive: true });
mkdirSync(appData, { recursive: true });
afterAll(async () => {
  delete process.env.ZS_TEST_PARSE_BUSY_MS;
  delete process.env.ZS_TEST_PARSE_ALLOC_MB;
  await disposeParsePool();
  for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } }
});

const blobOf = (buf: Buffer): { path: string; hash: string } => {
  const hash = createHash('sha256').update(buf).digest('hex');
  const path = join(tmpRoot, 'blobstore', `${hash}.bin`);
  writeFileSync(path, buf);
  return { path, hash };
};

describe('队列身份：A/B/C 各自参数与内容（逐项核对）', () => {
  it('慢 PDF A → DOCX B → CSV C：B/C 按自己的文件/格式解析（内容/sourceHash 逐项对上）', async () => {
    const pool = new ParsePool();
    const a = blobOf(makeAsciiPdf([[`慢A内容 PDF-A-${randomUUID().slice(0, 4)}`]]));
    const b = blobOf(makeDocx({ paras: [`DOCX-B-7788 真身 ${randomUUID().slice(0, 4)}`] }));
    const c = blobOf(makeCsvText([['CSV-C-3355', '列二'], ['值', '1']]));
    const ra = pool.run('pdf', a.path, a.hash, { hooks: { busyMs: 1_500 } }); // 慢 A 占槽
    const rb = pool.run('docx', b.path, b.hash);
    const rc = pool.run('csv', c.path, c.hash);
    await new Promise((r) => setTimeout(r, 200));
    expect(pool.stats().queued).toBe(2);
    const [rsa, rsb, rsc] = await Promise.all([ra, rb, rc]);
    expect(rsa.ok).toBe(true);
    // **逐项核对**（不只 ok/计数）：kind/sourceHash/内容暗号。
    expect(rsb.ok).toBe(true);
    if (rsb.ok) {
      expect(rsb.result.kind).toBe('docx'); // 修复前：按 A 的参数被当 pdf 解析（或 hash 不符失败）
      expect(rsb.result.sourceHash).toBe(b.hash);
      expect(rsb.result.kind === 'docx' && rsb.result.text.includes('DOCX-B-7788')).toBe(true);
    }
    expect(rsc.ok).toBe(true);
    if (rsc.ok) {
      expect(rsc.result.kind).toBe('sheet');
      expect(rsc.result.sourceHash).toBe(c.hash);
      expect(JSON.stringify(rsc.result)).toContain('CSV-C-3355');
    }
    if (rsa.ok) {
      expect(rsa.result.kind).toBe('pdf');
      expect(rsa.result.sourceHash).toBe(a.hash);
    }
    expect(pool.stats().completed).toBe(3);
    await pool.dispose();
  }, 60_000);
  it('A 超时不影响 B/C：B/C 仍各自正确解析', async () => {
    const pool = new ParsePool();
    const a = blobOf(makeAsciiPdf([['A 将超时']]));
    const b = blobOf(makeDocx({ paras: ['超时后 B 真身 DOCX-B-AFTER-9921'] }));
    const ra = pool.run('pdf', a.path, a.hash, { deadlineMs: 400, hooks: { busyMs: 20_000 } });
    const rb = pool.run('docx', b.path, b.hash);
    const t0 = Date.now();
    const [rsa, rsb] = await Promise.all([ra, rb]);
    expect(Date.now() - t0).toBeLessThan(15_000); // 不等满 A 的 busy
    expect(rsa.ok).toBe(false);
    if (!rsa.ok) expect(rsa.error.code).toBe('pdf-timeout');
    expect(rsb.ok).toBe(true);
    if (rsb.ok) expect(rsb.result.kind === 'docx' && rsb.result.text.includes('DOCX-B-AFTER-9921')).toBe(true);
    await pool.dispose();
  }, 60_000);
});

describe('命令层三会话并发上传：归属与内容', () => {
  it('pdf/docx/csv 并发上传——各自 artifact 归属会话、缓存 sourceHash 与内容暗号对上', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    for (const [i, conv] of ['c1', 'c2', 'c3'].entries()) {
      db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?,?, 'dm', NULL)`).run(conv, 'p1');
      db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?,?, 'human','u_local'),(?,?, 'agent','mA')`).run('p1', conv, 'p1', conv);
      void i;
    }
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
    const send = (method: string, params: unknown) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `pl-${randomUUID().slice(0, 8)}`, method, params }) as Promise<{ ok: boolean; data?: never; error?: { code: string; message: string } }>;
    const pdfB = makeAsciiPdf([['并发 PDF-CONV-441']]);
    const docxB = makeDocx({ paras: ['并发 DOCX-CONV-552'] });
    const csvB = makeCsvText([['并发 CSV-CONV-663', 'v']]);
    const [r1, r2, r3] = await Promise.all([
      send('attachment.uploadPdf', { conversationId: 'c1', filename: '并发a.pdf', contentBase64: pdfB.toString('base64') }),
      send('attachment.uploadOffice', { conversationId: 'c2', filename: '并发b.docx', contentBase64: docxB.toString('base64') }),
      send('attachment.uploadCsv', { conversationId: 'c3', filename: '并发c.csv', contentBase64: csvB.toString('base64') }),
    ]);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    const rows = db.prepare(`SELECT id, conversation_id, kind, hash, extracted_text_json FROM artifacts ORDER BY rowid`).all() as Array<{ id: string; conversation_id: string; kind: string; hash: string; extracted_text_json: string | null }>;
    expect(rows).toHaveLength(3);
    // 归属逐项核对。
    const byConv = new Map(rows.map((r) => [r.conversation_id, r]));
    expect(byConv.get('c1')!.kind).toBe('pdf_file');
    expect(byConv.get('c2')!.kind).toBe('docx_file');
    expect(byConv.get('c3')!.kind).toBe('sheet_file');
    // 缓存 sourceHash=各自内容 hash，内容暗号对上（不串包）。
    for (const r of rows) {
      const cache = JSON.parse(r.extracted_text_json ?? '{}') as { sourceHash?: string };
      expect(cache.sourceHash).toBe(r.hash);
    }
    expect(byConv.get('c1')!.extracted_text_json).toContain('PDF-CONV-441');
    expect(byConv.get('c2')!.extracted_text_json).toContain('DOCX-CONV-552');
    expect(byConv.get('c3')!.extracted_text_json).toContain('CSV-CONV-663');
    db.close();
  }, 90_000);
});

describe('IPC 超时语义：同 commandId 重试=持久结果，不另发', () => {
  it('UI 侧放弃等待后重试同 commandId → replayed 结果、artifact 不重复', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c9','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','c9','human','u_local'),('p1','c9','agent','mA')`).run();
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: appData };
    const commandId = `retry-${randomUUID().slice(0, 8)}`;
    const params = { conversationId: 'c9', filename: '重试语义.pdf', contentBase64: makeAsciiPdf([['重试暗号 RETRY-IPC-887']]).toString('base64') };
    process.env.ZS_TEST_PARSE_BUSY_MS = '900'; // 慢解析窗口
    try {
      // 模拟 UI 超时：600ms 放弃等待（daemon 侧继续完成）。
      const pending = dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method: 'attachment.uploadPdf', params }) as Promise<{ ok: boolean; replayed?: boolean; data?: { attachmentId: string } }>;
      const uiSawTimeout = await Promise.race([pending.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 600))]);
      expect(uiSawTimeout).toBe(true); // UI 已报超时
      const settled = await pending; // 后台完成（不悄悄丢弃——落库+回执）
      expect(settled.ok).toBe(true);
      expect((db.prepare('SELECT count(*) c FROM artifacts').get() as { c: number }).c).toBe(1);
      // UI 重试同 commandId：回执预查=持久结果，不生成另一请求/记录。
      const retried = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method: 'attachment.uploadPdf', params }) as { ok: boolean; replayed?: boolean; data?: { attachmentId: string } };
      expect(retried.ok).toBe(true);
      expect(retried.replayed).toBe(true);
      expect(retried.data!.attachmentId).toBe(settled.data!.attachmentId);
      expect((db.prepare('SELECT count(*) c FROM artifacts').get() as { c: number }).c).toBe(1); // 不重复
    } finally {
      delete process.env.ZS_TEST_PARSE_BUSY_MS;
    }
    db.close();
  }, 90_000);
});

describe('dev worker 源码指纹', () => {
  it('指纹不匹配的旧产物自动重建（解析仍正确）', async () => {
    const devDir = join(process.cwd(), 'dist', 'dev-parse');
    const fpFile = join(devDir, 'build-fingerprint.txt');
    // 确保产物存在（首次构建）。
    const a = blobOf(makeAsciiPdf([['指纹探针 FP-REBUILD-1']]));
    const first = await getParsePool().run('pdf', a.path, a.hash);
    expect(first.ok).toBe(true);
    const goodFp = readFileSync(fpFile, 'utf8');
    // 伪造旧指纹 → 下一次解析前重建。
    writeFileSync(fpFile, 'stale-fingerprint-from-old-source', 'utf8');
    const b = blobOf(makeAsciiPdf([['指纹探针 FP-REBUILD-2']]));
    const second = await getParsePool().run('pdf', b.path, b.hash);
    expect(second.ok).toBe(true);
    if (second.ok && second.result.kind === 'pdf') expect(second.result.pages[0]!.text).toContain('FP-REBUILD-2');
    expect(readFileSync(fpFile, 'utf8')).toBe(goodFp); // 已恢复为当前源码指纹
  }, 90_000);
});

describe('整进程内存（Job Object）——外部 Buffer 分配反例', () => {
  it('allocMB 超整进程硬界（--max-old-space-size 不约束 Buffer）：子进程被收拢、daemon 命令正常', async () => {
    const hasJob = jobObjectCapability();
    const pool = new ParsePool();
    const a = blobOf(makeAsciiPdf([['内存反例探针 MEM-1']]));
    // R71：PARSE_TOTAL_MEMORY_LIMIT_BYTES 384→896MiB（真 73MiB 表 XML）——600MB 不再超界；
    // 反例分配量相对常量取（硬界 + 200MB），保证仍验证 Buffer 不游离于限额外。
    const overAllocMB = Math.ceil(PARSE_TOTAL_MEMORY_LIMIT_BYTES / (1024 * 1024)) + 200;
    const r = await pool.run('pdf', a.path, a.hash, { hooks: { allocMB: overAllocMB } });
    // Job Object 生效：分配被拒/进程被终止（分类为失败），exit 确认后槽释放。
    // 附加失败的平台：Buffer 分配可能成功并继续解析（ok=true）——按降级口径如实断言。
    if (hasJob) {
      // 分配被整进程硬界拒绝：进程或被终止（exited/timeout），或存活并如实报错
      //（parse-worker-error + allocation 失败消息）——两者都证明 Buffer 不再游离于限额外。
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['parse-worker-exited', 'pdf-timeout', 'parse-worker-failed', 'parse-worker-error', 'parse-kill-unconfirmed']).toContain(r.error.code);
        if (r.error.code === 'parse-worker-error') expect(String(r.error.message)).toMatch(/allocation|memory|内存|分配/i);
      }
    } else {
      console.log('Job Object 不可用（非 Windows/无 koffi）——降级口径：仅 V8 上限');
    }
    expect(pool.stats().liveChildren).toBe(0); // 收拢确认（不悬挂）
    // daemon 侧后续命令正常（子进程故障不伤主进程）。
    const b = blobOf(makeAsciiPdf([['内存反例后续 MEM-2']]));
    const r2 = await pool.run('pdf', b.path, b.hash);
    expect(r2.ok).toBe(true);
    if (r2.ok && r2.result.kind === 'pdf') expect(r2.result.pages[0]!.text).toContain('MEM-2');
    await pool.dispose();
  }, 120_000);
});

describe('ZIP 完整性与旧容量边界', () => {
  it('local/central 声明解压1KB与实际数据不符仍报完整性错误', async () => {
    // 手工构造说谎 zip：stored 的元数据声明 + deflate 真身。
    const payload = Buffer.alloc(40 * 1024 * 1024, 0x61); // 40MB 可压缩真身
    const deflated = zlib.deflateSync(payload);
    const name = 'bomb.bin';
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method=deflate
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(0, 14); // crc（不作校验依据）
    local.writeUInt32LE(deflated.length, 18); // csize=真
    local.writeUInt32LE(1000, 22); // usize=**说谎 1KB**
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const nameBuf = Buffer.from(name, 'latin1');
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(deflated.length, 20); // csize=真
    central.writeUInt32LE(1000, 24); // usize=说谎
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(30 + nameBuf.length + deflated.length, 42); // local header offset
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); // 条目数=1
    eocd.writeUInt32LE(46 + nameBuf.length, 12); // central size
    eocd.writeUInt32LE(30 + nameBuf.length + deflated.length, 16); // central offset
    const zip = Buffer.concat([local, nameBuf, deflated, central, nameBuf, eocd]);
    const { path, hash } = blobOf(zip);
    const pool = new ParsePool();
    const t0 = Date.now();
    const r = await pool.run('docx', path, hash); // office/docx 路径必经 safeUnzip
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('zip-corrupt'); // 结构或尺寸声明不符仍拒绝，不使用容量门槛
    expect(Date.now() - t0).toBeLessThan(30_000); // 拒绝发生在解压中途，非整包解完
    expect(pool.stats().liveChildren).toBe(0);
    await pool.dispose();
  }, 120_000);
  it('越过旧总解压量上限后仍检查文档结构，不再容量拒绝', async () => {
    // 9条×20MiB=180MiB，越过旧160MiB容量；ZIP合法但缺Office主文档，仍应报结构错误。
    const { zipSync } = await import('fflate');
    const entries: Record<string, Buffer> = { '[Content_Types].xml': Buffer.from('<Types/>') };
    const chunk = Buffer.alloc(20 * 1024 * 1024, 0x63);
    for (let i = 0; i < 9; i += 1) entries[`f${i}.bin`] = chunk;
    const zip = Buffer.from(zipSync(entries, { level: 9 }));
    const { path, hash } = blobOf(zip);
    const pool = new ParsePool();
    const t0 = Date.now();
    const r = await pool.run('docx', path, hash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('office-corrupt');
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(pool.stats().liveChildren).toBe(0);
    await pool.dispose();
  }, 180_000);
});
