import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { ParsePool } from '../../src/daemon/parsePool.ts';
import { validateExtractCache, renderSheetWindow, type ParseJobKind } from '../../src/daemon/parseContracts.ts';
import { safeUnzipWith } from '../../src/daemon/zipGuard.ts';
import { validatePptxPagesCache } from '../../src/daemon/pptxPages.ts';
import { makeDocx, makeXlsx, makePptxSlides, makePptxPagesSample } from '../../scripts/lib/craftDocuments.mjs';

const root = mkdtempSync(join(tmpdir(), 'zs-r120-parse-'));
const pool = new ParsePool();
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
function blob(raw: Buffer) {
  const hash = sha(raw); const path = join(root, hash);
  writeFileSync(path, raw); return { path, hash };
}
async function parse(kind: ParseJobKind, raw: Buffer) {
  const b = blob(raw); const r = await pool.run(kind, b.path, b.hash);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  expect(validateExtractCache(JSON.stringify(r.result), b.hash, r.result.kind)).not.toBeNull();
  const old = { ...r.result, budgets: { totalText: 524288, pageText: 65536 } };
  expect(validateExtractCache(JSON.stringify(old), b.hash, r.result.kind)).toBeNull();
  expect(r.result.truncatedTotal).toBe(false);
  return r.result;
}
afterAll(async () => { await pool.dispose(); rmSync(root, { recursive: true, force: true }); });

// Small glyphs keep the long text physically within the page, so PDF.js extracts
// the actual text rather than dropping glyphs outside the crop box.
function densePdf(): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const ids: number[] = [];
  for (let i = 0; i < 201; i += 1) {
    const id = objects.length + 1; ids.push(id);
    const text = i < 9 ? 'a'.repeat(66000) : `page-${i + 1}`;
    const stream = `BT /F1 0.001 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count 201 >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('R120 complete local parsing beyond former capacity boundaries', () => {
  it('PDF >20MiB, 201 pages and >64KiB per page / >512KiB text retain last page', async () => {
    const pdf = densePdf();
    const r = await parse('pdf', Buffer.concat([pdf, Buffer.alloc(21 * 1024 * 1024, 32)]));
    if (r.kind !== 'pdf') throw new Error('kind');
    expect(r.pages).toHaveLength(201);
    expect(r.pages[0]!.bytes).toBeGreaterThan(65536);
    expect(r.totalTextBytes).toBeGreaterThan(524288);
    expect(r.pages[200]!.text).toContain('page-201');
    expect(validateExtractCache(JSON.stringify({ ...r, pages: r.pages.slice(0, 200) }), r.sourceHash, 'pdf')).toBeNull();
  }, 30000);

  it('DOCX >32MiB, 10001 paragraphs, complete text and >768KiB HTML', async () => {
    const original = makeDocx({ paras: Array.from({ length: 10001 }, (_, i) => `${i}:` + 'x'.repeat(80)) });
    const files = safeUnzipWith(original);
    files['padding.bin'] = Buffer.alloc(33 * 1024 * 1024);
    const r = await parse('docx', Buffer.from(zipSync(files, { level: 0 })));
    if (r.kind !== 'docx') throw new Error('kind');
    expect(r.paragraphCount).toBe(10001);
    expect(r.text).toContain('10000:');
    expect(Buffer.byteLength(r.html)).toBeGreaterThan(786432);
    expect(r.html).toContain('10000:');
    expect(r.htmlTruncated).toBe(false);
  }, 30000);

  it('XLSX 41 sheets, 201 rows, 33 cols and >200 merges remain available', async () => {
    const rows = Array.from({ length: 201 }, () => Array.from({ length: 33 }, () => 'v'));
    rows[200]![32] = 'last-cell';
    const merges = Array.from({ length: 201 }, (_, i) => `A${i + 1}:B${i + 1}`);
    const r = await parse('xlsx', makeXlsx(Array.from({ length: 41 }, (_, i) => ({ name: `S${i}`, rows: i === 0 ? rows : [['tail']], merges: i === 0 ? merges : [] }))));
    if (r.kind !== 'sheet') throw new Error('kind');
    expect(r.sheets).toHaveLength(41);
    expect(r.sheets[0]!.cells[200]![32]).toBe('last-cell');
    expect(r.sheets[0]!.merges).toHaveLength(201);
    const w = renderSheetWindow(r, 'S0!AG201:AG201', 65536);
    expect(w.ok && w.text).toContain('last-cell');
  }, 30000);

  it('CSV >5MiB / >4MiB IPC, >4096B cell and >2000 rows remains complete', async () => {
    const long = 'z'.repeat(5 * 1024 * 1024 + 1);
    const r = await parse('csv', Buffer.from(long + '\n' + Array.from({ length: 2001 }, (_, i) => `row-${i}`).join('\n')));
    if (r.kind !== 'sheet') throw new Error('kind');
    expect(r.sheets[0]!.cells[0]![0]).toBe(long);
    expect(r.sheets[0]!.rowCount).toBe(2002);
    expect(r.sheets[0]!.cells[2001]![0]).toBe('row-2000');
  }, 30000);

  it('PPTX 201 slides plus long text / notes preserve last slide and byte totals', async () => {
    const r = await parse('pptx', makePptxSlides({ slides: Array.from({ length: 201 }, (_, i) => ({ no: i + 1, texts: [i < 9 ? 's'.repeat(66000) : `slide-${i + 1}`], notes: i === 200 ? 'n'.repeat(66000) : '' })) }));
    if (r.kind !== 'slides') throw new Error('kind');
    expect(r.slides).toHaveLength(201);
    expect(r.slides[200]!.text).toBe('slide-201');
    expect(r.slides[200]!.notes).toHaveLength(66000);
    expect(r.totalTextBytes).toBeGreaterThan(524288);
    expect(validateExtractCache(JSON.stringify({ ...r, totalSlides: 202 }), r.sourceHash, 'slides')).toBeNull();
  }, 30000);

  it('PPTX pages >60, >2MiB/image, >6MiB images, >220KB SVG and >12MiB JSON round trip', async () => {
    const image = Buffer.alloc(2300 * 1024, 65);
    const raw = makePptxPagesSample({ slides: Array.from({ length: 61 }, (_, i) => ({ no: i + 1, shapes: i < 5 ? [{ kind: 'pic', x: 0, y: 0, cx: 952500, cy: 952500 }] : [], ...(i < 5 ? { image: { name: `img${i}.png`, mime: 'image/png', ext: 'png', bytes: image } } : {}), notes: 'notes'.repeat(100) })) });
    const b = blob(raw); const out = join(root, 'pages.json');
    const r = await pool.runPages(b.path, b.hash, out);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.pagesSummary.outBytes).toBeGreaterThan(12 * 1024 * 1024);
    const json = readFileSync(out, 'utf8');
    const pages = validatePptxPagesCache(json, b.hash);
    expect(pages?.slides).toHaveLength(61);
    expect(pages!.slides[0]!.svg).toContain(image.toString('base64'));
    expect(pages!.slides[0]!.notes).toHaveLength(500);
    expect(validatePptxPagesCache(json.replace('pptx-pages-v3', 'pptx-pages-v2'), b.hash)).toBeNull();
  }, 30000);

  it('ZIP >1500 entries, >128MiB entry and >160MiB total decompress without quotas', () => {
    const entries: Record<string, Uint8Array> = Object.fromEntries(Array.from({ length: 1501 }, (_, i) => [`f${i}`, new Uint8Array(0)]));
    entries['large'] = new Uint8Array(129 * 1024 * 1024);
    entries['extra'] = new Uint8Array(32 * 1024 * 1024);
    const zip = Buffer.from(zipSync(entries, { level: 1 }));
    const files = safeUnzipWith(zip);
    expect(Object.keys(files)).toHaveLength(1503);
    expect(files['large']!.length).toBe(129 * 1024 * 1024);
    expect(files['extra']!.length).toBe(32 * 1024 * 1024);
  }, 30000);

  it('ZIP traversal and incomplete streams, CSV unclosed quotes, and source hash mismatch still fail', async () => {
    expect(() => safeUnzipWith(Buffer.from(zipSync({ '../bad': new Uint8Array([1]) })))).toThrow(/路径穿越/);
    const zip = Buffer.from(zipSync({ 'f': new Uint8Array(1000) }));
    expect(() => safeUnzipWith(zip.subarray(0, 32))).toThrow();
    const b = blob(Buffer.from('"not closed'));
    const csv = await pool.run('csv', b.path, b.hash);
    expect(!csv.ok && csv.error.code).toBe('sheet-corrupt');
    const hash = await pool.run('csv', b.path, 'wrong');
    expect(!hash.ok && hash.error.code).toBe('source-hash-mismatch');
  }, 30000);
});
