/** Rebuild input caches only from verified managed bytes, in the bounded parser process. */
import { join, resolve } from 'node:path';
import { readVerifiedBlob } from './attachments.ts';
import { ARTIFACT_PARSE_KINDS, validateExtractCache, type ExtractCache } from './parseContracts.ts';
import { getParsePool } from './parsePool.ts';

export interface DocumentCacheSource {
  hash: string;
  blob_path: string;
  kind: string;
  source_name: string | null;
}

export async function regenerateDocumentCache(
  row: DocumentCacheSource,
  blobRoot?: string,
): Promise<{ ok: true; cache: ExtractCache } | { ok: false; error: { code: string; message: string } }> {
  const mapping = ARTIFACT_PARSE_KINDS[row.kind];
  if (mapping == null) return { ok: false, error: { code: 'attachment-kind-invalid', message: '附件类型不支持文档提取' } };
  const verified = readVerifiedBlob(row.blob_path, row.hash, blobRoot);
  if (!verified.ok) return verified;
  // readVerifiedBlob relocates old absolute paths into this data root. The worker
  // must consume that same verified copy, never the stale path from the database.
  const blobPath = blobRoot == null ? row.blob_path : resolve(join(blobRoot, `${row.hash}.bin`));
  const parseKind = mapping.cache === 'sheet' && /\.(csv|tsv)$/i.test(row.source_name ?? '') ? 'csv' : mapping.parse;
  const parsed = await getParsePool().run(parseKind, blobPath, row.hash);
  if (!parsed.ok) return parsed;
  const cacheBody = { ...parsed.result };
  delete cacheBody.artifactKind;
  const cache = validateExtractCache(JSON.stringify(cacheBody), row.hash, mapping.cache);
  if (cache == null) return { ok: false, error: { code: 'parse-cache-invalid', message: '解析器返回的提取缓存未通过结构、版本或源文件校验' } };
  // Recheck the managed file after the async boundary as well as inside the
  // worker. A valid response cannot authorize a replaced or missing source.
  const current = readVerifiedBlob(row.blob_path, row.hash, blobRoot);
  if (!current.ok) return current;
  return { ok: true, cache };
}
