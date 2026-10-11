import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeExecutable, CLAUDE_ADAPTER_VERSION } from '../adapter/claude/cliAdapter.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import certification from '../adapter/image-certification-r76.json' with { type: 'json' };

const hashes = new Map<string, { stamp: string; hash: string }>();
export function claudeImageIdentity(executable?: string | null) {
  const entry = resolveClaudeExecutable(executable ?? undefined);
  const path = entry.prefixArgs[0] ?? entry.command;
  const st = statSync(path); const stamp = `${st.mtimeMs}:${st.size}`;
  let cached = hashes.get(path);
  if (cached?.stamp !== stamp) { cached = { stamp, hash: createHash('sha256').update(readFileSync(path)).digest('hex') }; hashes.set(path, cached); }
  let endpoint = process.env.ANTHROPIC_BASE_URL;
  if (endpoint == null) {
    try { endpoint = (JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {env?:{ANTHROPIC_BASE_URL?:string}}).env?.ANTHROPIC_BASE_URL; } catch { /* default official endpoint */ }
  }
  return { executableHash: cached.hash, endpointHash: createHash('sha256').update(endpoint ?? 'https://api.anthropic.com').digest('hex') };
}

/** Real evidence is limited to this tested model, CLI bytes, adapter and endpoint. */
export function memberImageCapability(db: ZhongshuoDatabase, memberId: string) {
  const runtime = resolveMemberRuntime(db, memberId, process.env.ZS_RUNTIME ?? null);
  const base = { memberId, kind: runtime.kind, model: runtime.model, status: 'unverified' as 'supported' | 'unverified' | 'unsupported', evidence: null as string | null };
  if (runtime.kind === 'fake') return { ...base, status: 'unsupported' as const };
  if (runtime.kind !== 'claude' || runtime.model !== certification.model || (runtime.permissionMode ?? 'plan') !== 'plan') return base;
  try {
    const identity = claudeImageIdentity(runtime.executable);
    if (identity.executableHash === certification.executableHash && identity.endpointHash === certification.endpointHash && CLAUDE_ADAPTER_VERSION === certification.adapterVersion) {
      return { ...base, status: 'supported' as const, evidence: certification.evidence };
    }
  } catch { /* no guessing from a filename/model name */ }
  return base;
}
