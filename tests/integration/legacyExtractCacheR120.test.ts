import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { assembleDirectTurn } from '../../src/daemon/turnInput.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { disposeParsePool } from '../../src/daemon/parsePool.ts';
import { CURRENT_PARSER_VERSIONS, validateExtractCache, validateExtractCacheForInput, renderSheetWindow, type ExtractCache } from '../../src/daemon/parseContracts.ts';
import { makeAsciiPdf } from '../../scripts/lib/craftDocuments.mjs';

const root = mkdtempSync(join(tmpdir(), 'zs-legacy-r120-'));
const blobRoot = join(root, 'blobstore');
mkdirSync(blobRoot);
const raw = makeAsciiPdf([['LEGACY-CONTENT']]);
const hash = createHash('sha256').update(raw).digest('hex');
const blobPath = join(blobRoot, `${hash}.bin`);
writeFileSync(blobPath, raw);
afterAll(async () => { await disposeParsePool(); rmSync(root, { recursive: true, force: true }); });

function cache(kind: ExtractCache['kind'], truncated = false): ExtractCache {
  const parser = CURRENT_PARSER_VERSIONS[kind];
  const common = { cacheSchema: 2 as const, sourceHash: hash, parserName: parser.name, parserVersion: parser.version,
    extractedAt: 1, totalTextBytes: 6, truncatedTotal: truncated };
  switch (kind) {
    case 'pdf': return { ...common, kind, budgets: { pageText: 65536, totalText: 524288 }, totalPages: truncated ? 2 : 1,
      pages: [{ page: 1, text: 'legacy', bytes: 6, truncated }] };
    case 'docx': return { ...common, kind, budgets: { totalText: 524288 }, text: 'legacy', html: '<p>legacy</p>', htmlTruncated: truncated, paragraphCount: 1 };
    case 'slides': return { ...common, kind, budgets: { slideText: 65536, totalText: 524288 }, totalSlides: truncated ? 2 : 1,
      slides: [{ slide: 1, text: 'legacy', notes: '', truncated }] };
    case 'sheet': return { ...common, kind, budgets: { cellText: 4096, totalText: 524288 }, sourceFormat: 'xlsx', encoding: 'internal',
      sheets: [{ name: 'S', rowCount: 1, colCount: 1, cells: [['legacy']], merges: [], rowTruncated: false, colTruncated: false, formulaMissing: false }] };
  }
}

function fixture(c: ExtractCache) {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO projects (id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES ('p','P',?,?,'{}',0)").run(root, root);
  db.prepare("INSERT INTO conversations (id,project_id,kind) VALUES ('dm','p','dm')").run();
  db.prepare(`INSERT INTO messages (id,project_id,conversation_id,conversation_seq,task_id,author_type,author_id,body_json,created_at)
    VALUES ('msg','p','dm',1,'task','human','u','{"text":"read"}',0)`).run();
  db.prepare("INSERT INTO dm_participants (project_id,conversation_id,principal_type,principal_id) VALUES ('p','dm','human','u')").run();
  const artifactKind = { pdf: 'pdf_file', docx: 'docx_file', sheet: 'sheet_file', slides: 'slides_file' }[c.kind];
  db.prepare(`INSERT INTO artifacts (id,project_id,conversation_id,author_id,kind,hash,blob_path,extracted_text_json)
    VALUES ('a','p','dm','u',?,?,?,?)`).run(artifactKind, hash, blobPath, JSON.stringify(c));
  db.prepare("INSERT INTO message_attachments (id,message_id,artifact_id,display_name,source_hash) VALUES ('att','msg','a','legacy',?)").run(hash);
  const assemble = () => assembleDirectTurn({ db, blobRoot, task: { id: 'task', projectId: 'p', conversationId: 'dm', conversationKind: 'dm',
    roomId: '', threadId: '', rootMessageId: 'msg', title: 'read', objective: null, taskRevision: 0, inputThroughSeq: 1 },
    identity: { member: { id: 'm', displayName: 'M' }, project: { id: 'p', displayName: 'P' }, room: { id: '', name: '' } },
    turnId: 'turn', budget: { grantId: 'g', maxTurns: 10, usedTurns: 0, inFlightReservedTurns: 0 } });
  return { db, assemble };
}

describe('R120 legacy v2 input compatibility', () => {
  for (const kind of ['pdf', 'docx', 'sheet', 'slides'] as const) {
    for (const truncated of [false, true]) {
      it(`${kind} legacy ${truncated ? 'truncated' : 'complete'} assembles without rewriting cache`, () => {
        const c = cache(kind, truncated);
        const f = fixture(c);
        try {
          expect(validateExtractCache(JSON.stringify(c), hash, kind)).toBeNull();
          expect(validateExtractCacheForInput(JSON.stringify(c), hash, kind)).toEqual(c);
          const result = f.assemble();
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (!result.ok) throw new Error(JSON.stringify(result));
          const entry = result.value.envelope.attachments![0]!;
          expect(entry.text).toContain('legacy');
          expect(entry.truncated).toBe(truncated || kind === 'sheet');
          if (entry.truncated) expect(entry.text).toContain('不代表完整文档');
          expect((f.db.prepare("SELECT extracted_text_json AS j FROM artifacts WHERE id='a'").get() as { j: string }).j).toBe(JSON.stringify(c));
        } finally { f.db.close(); }
      });
    }
    it(`${kind} rejects wrong hash, broken structure, parser/schema/budget versions`, () => {
      const c = cache(kind);
      for (const patch of [{ sourceHash: 'wrong' }, { parserVersion: '999.0.0' }, { parserName: 'other' }, { cacheSchema: 3 },
        { totalTextBytes: -1 }, { totalTextBytes: 999999999 }, { truncatedTotal: 'false' }, { budgets: {} },
        { budgets: { ...c.budgets, unknown: 1 } }, { budgets: { totalText: 123 } }]) {
        expect(validateExtractCacheForInput(JSON.stringify({ ...c, ...patch }), hash, kind)).toBeNull();
      }
      expect(validateExtractCacheForInput('{broken', hash, kind)).toBeNull();
    });
    it(`${kind} input rejects corrupt cache and future parser version`, () => {
      const f = fixture(cache(kind));
      try {
        for (const value of ['{broken', JSON.stringify({ ...cache(kind), parserVersion: '999.0.0' }),
          JSON.stringify({ ...cache(kind), totalTextBytes: 7 }), JSON.stringify({ ...cache(kind), sourceHash: 'wrong' })]) {
          f.db.prepare("UPDATE artifacts SET extracted_text_json=? WHERE id='a'").run(value);
          expect(f.assemble().ok).toBe(false);
        }
      } finally { f.db.close(); }
    });
  }

  it('input rejects altered original bytes even with a valid historical cache', () => {
    const f = fixture(cache('pdf'));
    try {
      writeFileSync(blobPath, 'altered');
      expect(f.assemble().ok).toBe(false);
    } finally { writeFileSync(blobPath, raw); f.db.close(); }
  });

  it('legacy sheet limits actual cached range and handles historical CSV byte accounting', () => {
    const c = cache('sheet');
    if (c.kind !== 'sheet') throw new Error('kind');
    c.sheets[0]!.rowCount = 201;
    c.sheets[0]!.rowTruncated = true;
    c.sheets[0]!.cells = Array.from({ length: 200 }, () => ['legacy']);
    c.totalTextBytes = 1200;
    expect(validateExtractCacheForInput(JSON.stringify(c), hash, 'sheet')).toEqual(c);
    expect(renderSheetWindow(c, 'S!A201:A201', 65536).ok).toBe(false);
    c.sourceFormat = 'csv'; c.parserName = CURRENT_PARSER_VERSIONS.csv.name; c.parserVersion = CURRENT_PARSER_VERSIONS.csv.version;
    c.encoding = 'utf-8'; c.totalTextBytes = 1206;
    expect(validateExtractCacheForInput(JSON.stringify(c), hash, 'sheet')).toEqual(c);
  });

  it('legacy sheet total cutoff before default 50 rows still renders only saved rows', () => {
    const c = cache('sheet', true);
    if (c.kind !== 'sheet') throw new Error('kind');
    c.sheets[0]!.rowCount = 100;
    expect(validateExtractCacheForInput(JSON.stringify(c), hash, 'sheet')).toEqual(c);
    const window = renderSheetWindow(c, null, 65536);
    expect(window.ok).toBe(true);
    expect(window.ok && window.text).toContain('legacy');
    expect(renderSheetWindow(c, 'S!A2:A2', 65536).ok).toBe(false);
  });

  it('recognizes only the historical PDF final clipped-page accounting discrepancy', () => {
    const c = cache('pdf', true);
    if (c.kind !== 'pdf') throw new Error('kind');
    c.pages = Array.from({ length: 9 }, (_, i) => ({ page: i + 1, text: 'x'.repeat(i === 8 ? 8000 : 64536), bytes: i === 8 ? 8000 : 64536, truncated: i === 8 }));
    c.totalPages = 10; c.totalTextBytes = 516288;
    expect(validateExtractCacheForInput(JSON.stringify(c), hash, 'pdf')).toEqual(c);
    c.totalTextBytes--;
    expect(validateExtractCacheForInput(JSON.stringify(c), hash, 'pdf')).toBeNull();
  });

  it('new large complete DOCX remains valid and input keeps its context window', () => {
    const c = cache('docx');
    if (c.kind !== 'docx') throw new Error('kind');
    c.budgets = { completePreview: 1 }; c.text = 'x'.repeat(900000); c.html = `<p>${c.text}</p>`;
    c.totalTextBytes = 900000; c.paragraphCount = 10001;
    expect(validateExtractCache(JSON.stringify(c), hash, 'docx')).toEqual(c);
    const f = fixture(c);
    try {
      const result = f.assemble();
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.value.envelope.attachments![0]!.truncated).toBe(true);
      expect(Buffer.byteLength(result.value.envelope.attachments![0]!.text)).toBeLessThanOrEqual(65536);
    } finally { f.db.close(); }
  });

  it.each([false, true])('formal preview reparses legacy PDF (truncated=%s) into complete current cache', async (truncated) => {
    const f = fixture(cache('pdf', truncated));
    try {
      const result = await dispatchDaemonCommand({ db: f.db, localUserId: 'u', appDataDir: root, interruptTurn: async () => {} },
        { protocolVersion: 1, commandId: randomUUID(), method: 'attachment.previewPdf', params: { attachmentId: 'a' } });
      expect((result as { ok: boolean }).ok, JSON.stringify(result)).toBe(true);
      const updated = (f.db.prepare("SELECT extracted_text_json AS j FROM artifacts WHERE id='a'").get() as { j: string }).j;
      const parsed = validateExtractCache(updated, hash, 'pdf');
      expect(parsed?.budgets).toEqual({ completePreview: 1 });
      expect(parsed?.truncatedTotal).toBe(false);
      expect(updated).toContain('LEGACY-CONTENT');
    } finally { f.db.close(); }
  }, 30000);
});
