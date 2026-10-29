import { describe, expect, it } from 'vitest';
import { DispatchAdmission, type AdmissionDimensions } from '../../src/daemon/admission.ts';

const dimensions = (overrides: Partial<AdmissionDimensions> = {}): AdmissionDimensions => ({
  memberId: 'role', projectId: 'project', providerKey: 'provider', writeRootKey: null,
  executionScopeKey: 'scope-a', ...overrides,
});
const admission = () => new DispatchAdmission({
  globalMaxInFlight: 10, perProjectMaxInFlight: 10, perProviderMaxInFlight: 10,
});
const memberDenied = { granted: false, reason: 'member' };

describe('R123 session admission', () => {
  it('allows two scopes for one role and counts both slots', () => {
    const a = admission();
    expect(a.tryAcquire('a', dimensions())).toEqual({ granted: true });
    expect(a.tryAcquire('b', dimensions({ executionScopeKey: 'scope-b' }))).toEqual({ granted: true });
    expect(a.snapshot()).toEqual({
      global: 2, byProject: { project: 2 }, byProvider: { provider: 2 }, byMember: { role: 2 },
    });
    expect(a.tryAcquire('duplicate', dimensions())).toEqual(memberDenied);
    expect(a.has('duplicate')).toBe(false);
    expect(a.snapshot().global).toBe(2);
  });

  it('allows different roles with the same scope', () => {
    const a = admission();
    expect(a.tryAcquire('a', dimensions())).toEqual({ granted: true });
    expect(a.tryAcquire('b', dimensions({ memberId: 'other-role' }))).toEqual({ granted: true });
    expect(a.snapshot().byMember).toEqual({ role: 1, 'other-role': 1 });
  });

  it.each(['acquire', 'restore'] as const)('legacy held via %s blocks every new scope for that member', (method) => {
    const a = admission();
    const legacy = dimensions();
    delete legacy.executionScopeKey;
    if (method === 'acquire') expect(a.tryAcquire('legacy', legacy)).toEqual({ granted: true });
    else a.restore('legacy', legacy);
    for (const executionScopeKey of ['scope-a', 'scope-b']) {
      expect(a.tryAcquire(executionScopeKey, dimensions({ executionScopeKey }))).toEqual(memberDenied);
    }
    expect(a.tryAcquire('other', dimensions({ memberId: 'other-role' }))).toEqual({ granted: true });
    expect(a.has('legacy')).toBe(true);
  });

  it('a legacy request cannot bypass any existing scoped slot', () => {
    const a = admission();
    a.restore('a', dimensions());
    a.restore('b', dimensions({ executionScopeKey: 'scope-b' }));
    expect(a.tryAcquire('legacy', dimensions({ executionScopeKey: undefined }))).toEqual(memberDenied);
    expect(a.release('a')).toBe(true);
    expect(a.tryAcquire('legacy', dimensions({ executionScopeKey: undefined }))).toEqual(memberDenied);
    expect(a.release('b')).toBe(true);
    expect(a.tryAcquire('legacy', dimensions({ executionScopeKey: undefined }))).toEqual({ granted: true });
  });

  it('restores an opaque UNKNOWN scope unchanged and only blocks that scope for the same member', () => {
    const a = admission();
    const unknown = dimensions({ executionScopeKey: 'unknown/project/conversation/thread/member', writeRootKey: 'physical-root' });
    a.restore('unknown', unknown);
    a.restore('unknown', dimensions({ executionScopeKey: 'replacement' }));
    expect(a.has('unknown')).toBe(true);
    expect(a.has('unknown')).toBe(true);
    expect(a.tryAcquire('same', { ...unknown, writeRootKey: null })).toEqual(memberDenied);
    expect(a.tryAcquire('other-scope', dimensions({ executionScopeKey: 'scope-b' }))).toEqual({ granted: true });
    expect(a.tryAcquire('other-role', { ...unknown, memberId: 'other-role', writeRootKey: null })).toEqual({ granted: true });
    expect(a.snapshot()).toEqual({
      global: 3, byProject: { project: 3 }, byProvider: { provider: 3 }, byMember: { role: 2, 'other-role': 1 },
    });
    expect(a.forceReleaseAll().find((slot) => slot.turnId === 'unknown')?.dims).toEqual(unknown);
  });

  it.each([
    ['globalMaxInFlight', 'global', { projectId: 'other-project', providerKey: 'other-provider' }],
    ['perProjectMaxInFlight', 'project', { providerKey: 'other-provider' }],
    ['perProviderMaxInFlight', 'provider', { projectId: 'other-project' }],
  ] as const)('UNKNOWN scoped slots still enforce %s', (limit, reason, overrides) => {
    const a = new DispatchAdmission({ globalMaxInFlight: 10, perProjectMaxInFlight: 10, perProviderMaxInFlight: 10, [limit]: 1 });
    a.restore('unknown', dimensions());
    const next = dimensions({ executionScopeKey: 'scope-b', ...overrides });
    expect(a.tryAcquire('b', next)).toEqual({ granted: false, reason });
    expect(a.has('b')).toBe(false);
    expect(a.has('unknown')).toBe(true);
    a.release('unknown');
    expect(a.tryAcquire('b', next)).toEqual({ granted: true });
  });

  it('keeps physical write roots exclusive across scopes, members and projects', () => {
    const a = admission();
    a.restore('unknown', dimensions({ writeRootKey: 'physical-root' }));
    expect(a.tryAcquire('writer', dimensions({
      memberId: 'other-role', projectId: 'other-project', executionScopeKey: 'scope-b', writeRootKey: 'physical-root',
    }))).toEqual({ granted: false, reason: 'write-root' });
    expect(a.tryAcquire('other-root', dimensions({ executionScopeKey: 'scope-b', writeRootKey: 'other-root' }))).toEqual({ granted: true });
    expect(a.tryAcquire('reader', dimensions({ executionScopeKey: 'scope-c' }))).toEqual({ granted: true });
    expect(a.has('unknown')).toBe(true);
  });

  it('releases only the requested slot, with idempotent has/release and no UNKNOWN overwrite', () => {
    const a = admission();
    a.restore('unknown', dimensions());
    a.tryAcquire('b', dimensions({ executionScopeKey: 'scope-b' }));
    expect(a.tryAcquire('unknown', dimensions({ executionScopeKey: 'scope-c' }))).toEqual(memberDenied);
    expect(a.release('missing')).toBe(false);
    expect(a.has('unknown')).toBe(true);
    expect(a.release('b')).toBe(true);
    expect(a.release('b')).toBe(false);
    expect(a.has('b')).toBe(false);
    expect(a.has('unknown')).toBe(true);
    expect(a.snapshot().byMember).toEqual({ role: 1 });
    expect(a.tryAcquire('same', dimensions())).toEqual(memberDenied);
    expect(a.tryAcquire('b-again', dimensions({ executionScopeKey: 'scope-b' }))).toEqual({ granted: true });
    expect(a.release('unknown')).toBe(true);
    expect(a.release('unknown')).toBe(false);
    expect(a.has('b-again')).toBe(true);
    expect(a.snapshot().global).toBe(1);
  });

  it('restores all persisted slots even above configured limits', () => {
    const a = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 1, perProviderMaxInFlight: 1 });
    a.restore('unknown-a', dimensions());
    a.restore('unknown-b', dimensions({ executionScopeKey: 'scope-b' }));
    expect(a.snapshot()).toEqual({
      global: 2, byProject: { project: 2 }, byProvider: { provider: 2 }, byMember: { role: 2 },
    });
    expect(a.forceReleaseAll().map(({ dims }) => dims.executionScopeKey)).toEqual(['scope-a', 'scope-b']);
    expect(a.snapshot().global).toBe(0);
    expect(a.forceReleaseAll()).toEqual([]);
  });
});
