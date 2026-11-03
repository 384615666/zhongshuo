import type { ZhongshuoDatabase } from '../persistence/db.ts';

interface Candidate { providerId: string; memberId: string }
export type ArchiveStoredCodexThread = (memberId: string, providerId: string, eligible: () => boolean) => Promise<void>;

/** One pass over exact recorded Codex identities, spread across normal daemon
 * ticks. No title matching, vendor-wide history scan, migrations or task writes.
 * UNKNOWN, active starts and missing execution evidence are left untouched. */
export function createCodexHistoryCleanup(db: ZhongshuoDatabase, archive: ArchiveStoredCodexThread) {
  let candidates: Candidate[] | null = null;
  const idle = (candidate: Candidate): boolean => {
    const row = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id LIKE 'codex-session-%' AND s.provider_session_id=?) owned,
      EXISTS(SELECT 1 FROM runtime_sessions s JOIN agent_turns a ON a.session_id=s.id
        WHERE s.provider_session_id=? AND a.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')) unsettled,
      EXISTS(SELECT 1 FROM agent_turns a WHERE a.member_id=? AND a.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')) member_busy,
      EXISTS(SELECT 1 FROM runtime_sessions s JOIN agent_turns a ON a.session_id=s.id
        WHERE s.provider_session_id=? AND a.status IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')) recorded_terminal
    `).get(candidate.providerId, candidate.providerId, candidate.memberId, candidate.providerId) as {
      owned: number; unsettled: number; member_busy: number; recorded_terminal: number;
    };
    return row.owned === 1 && row.unsettled === 0 && row.member_busy === 0 && row.recorded_terminal === 1;
  };
  return {
    async runOnce(): Promise<void> {
      try {
        candidates ??= db.prepare(`SELECT provider_session_id providerId, member_id memberId
          FROM runtime_sessions WHERE id LIKE 'codex-session-%' AND provider_session_id IS NOT NULL AND provider_session_id!=''
          GROUP BY provider_session_id ORDER BY rowid DESC`).all() as Candidate[];
        const candidate = candidates.shift();
        if (candidate && idle(candidate)) await archive(candidate.memberId, candidate.providerId, () => idle(candidate));
      } catch {
        // Maintenance never changes dispatch/terminal facts and never prevents
        // the next tick or shutdown. A later app start can retry this identity.
        process.stderr.write('[zhongshuo-daemon] Codex history cleanup deferred\n');
      }
    },
  };
}
