import { describe, expect, it } from 'vitest';

type Report = {
  ok: boolean;
  realBusinessCalls: number;
  checks: Array<{ name: string; ok: boolean }>;
  workerChecks: Array<{ name: string; ok: boolean; expected: string[]; actual: string[] }>;
};

describe('R134 actual Composer member recipients', () => {
  it('keeps clicked IDs in drafts, durable envelopes and formal worker starts', async () => {
    const verifierUrl = new URL('../../scripts/verify-r134-composer-mentions.cjs', import.meta.url).href;
    const module = await import(verifierUrl) as { default: { runVerifier: () => Promise<Report> } };
    const report = await module.default.runVerifier();
    expect(report.ok).toBe(true);
    expect(report.realBusinessCalls).toBe(0);
    expect(report.checks.filter(c => !c.ok)).toEqual([]);
    expect(report.workerChecks).toHaveLength(8);
    for (const check of report.workerChecks) expect(check.actual).toEqual(check.expected);
    for (const name of ['candidate_1_draft', 'candidate_2_draft', 'candidate_3_draft', 'rename_model_switch_envelope', 'room_switch_restores_id', 'code_quote_no_mentions', 'removed_member_no_fallback', 'unique_selection_plain_name', 'duplicate_selection_no_uuid', 'cold_reload_metadata_member_preserved', 'cold_reload_plain_name_not_retargeted']) {
      expect(report.checks.find(c => c.name === name)?.ok, name).toBe(true);
    }
  }, 90_000);
});
