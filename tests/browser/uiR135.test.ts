import {describe, expect, it} from 'vitest';

type Report = {
  ok: boolean;
  syntheticOnly: boolean;
  databaseOpened: boolean;
  realBusinessCalls: number;
  checks: Array<{name: string; ok: boolean}>;
};

describe('R135 production RecoveryPanel and Composer in isolated Electron', () => {
  it('closes only after navigation and keeps mode exit separate from member selection', async () => {
    const verifierUrl = new URL('../../scripts/verify-R135-ui.cjs', import.meta.url).href;
    const module = await import(verifierUrl) as {default: {runVerifier: () => Promise<Report>}};
    const report = await module.default.runVerifier();
    expect(report.ok).toBe(true);
    expect(report.syntheticOnly).toBe(true);
    expect(report.databaseOpened).toBe(false);
    expect(report.realBusinessCalls).toBe(0);
    expect(report.checks.filter(check => !check.ok)).toEqual([]);
    for (const name of [
      'recovery_1_failure_keeps_dialog', 'recovery_1_pending_keeps_dialog',
      'recovery_1_success_closes_once', 'recovery_3_formal_route',
      'primary_contains_parallel_actions', 'member_menu_has_no_mode_exit',
      'natural_exit_only_changes_collaboration', 'natural_send_body_mentions_only',
      'natural_send_omits_deliberation_budget', 'thread_primary_offers_natural_exit',
      'readonly_menu_has_no_mode_actions', 'only_read_rpcs_no_dispatch_or_resume',
    ]) expect(report.checks.find(check => check.name === name)?.ok, name).toBe(true);
  }, 65_000);
});
