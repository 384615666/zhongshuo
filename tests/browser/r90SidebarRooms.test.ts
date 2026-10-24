import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HifiState } from '../../src/ui/hifi/data/store';
import { getState, setState } from '../../src/ui/hifi/data/store';
import { focusProject } from '../../src/ui/hifi/data/actions-nav';
import { buildRoomRootEnvelope, buildThreadEnvelope, defaultDeliberationMaxTurns, loadSidebarRooms, openSidebarRoom } from '../../src/ui/hifi/loader';
import { cancelAllNavIntents } from '../../src/ui/hifi/lib/navIntent';
import { currentNavSeq } from '../../src/ui/hifi/lib/router';

type Command = (envelope: { commandId: string; method: string; params: Record<string, unknown> }) =>
  Promise<{ ok: boolean; data: unknown }>;

const originalWindow = (globalThis as { window?: unknown }).window;
const originalEvent = (globalThis as { HashChangeEvent?: unknown }).HashChangeEvent;
let initial: HifiState;

function project(id: string, displayName: string) {
  return {
    id,
    displayName,
    rootPath: `C:/synthetic/${id}`,
    canonicalPath: `C:/synthetic/${id}`,
    directoryIdentity: id,
    status: 'ok' as const,
    revision: 0,
    isGit: false,
  };
}

function room(id: string, projectId: string, conversationId: string, name = `房间 ${id}`) {
  return {
    id,
    projectId,
    name,
    conversationId,
    coordinatorMemberId: 'm1',
    memberIds: ['m1', 'm2'],
    revision: 0,
    unread: 0,
  };
}

function installWindow(command: Command): { location: { hash: string } } {
  const location = { hash: '#/project/projA/room/roomA' };
  const host = {
    zs: { command },
    location,
    dispatchEvent: () => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  (globalThis as { window?: unknown }).window = host;
  (globalThis as { HashChangeEvent?: unknown }).HashChangeEvent = class {
    type: string;
    constructor(type: string) { this.type = type; }
  };
  return { location };
}

describe('R90 independent project room index', () => {
  beforeEach(() => {
    initial = getState();
    const a = project('projA', '项目 A');
    const b = project('projB', '项目 B');
    const c = project('projC', '项目 C');
    setState((state) => ({
      ...state,
      projects: [a, b, c],
      activeProjectId: a.id,
      visibleProjectIds: [a.id, b.id, c.id],
      expandedProjectIds: [a.id, b.id, c.id],
      rooms: [room('roomA', a.id, 'convA')],
      members: [],
      dms: [],
      loadGen: state.loadGen + 1,
    }));
  });

  afterEach(() => {
    setState(() => initial);
    cancelAllNavIntents();
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { HashChangeEvent?: unknown }).HashChangeEvent = originalEvent;
  });

  it('loads an inactive project room index without replacing active rooms', async () => {
    installWindow(async (envelope) => {
      expect(envelope.method).toBe('room.list');
      expect(envelope.params.projectId).toBe('projB');
      return {
        ok: true,
        data: {
          items: [{ id: 'roomB', name: '项目 B 房间', conversationId: 'convB', revision: 3 }],
        },
      };
    });
    const rooms = await loadSidebarRooms('projB');
    expect(rooms).toEqual([{ id: 'roomB', name: '项目 B 房间', archivedAt: undefined, revision: 3 }]);
    expect(getState().activeProjectId).toBe('projA');
    expect(getState().rooms.map((item) => item.id)).toEqual(['roomA']);
  });

  it('freezes the room-only deliberation budget into the envelope', () => {
    expect(defaultDeliberationMaxTurns(2)).toBe(17);
    const envelope = buildRoomRootEnvelope(
      'r90-envelope-budget',
      'roomA',
      'Synthetic envelope',
      'default',
      ['m1', 'm2'],
      undefined,
      { collaboration: 'deliberate', deliberationBudget: { maxTurns: 10 } },
    );
    expect(envelope.params.deliberationBudget).toEqual({ maxTurns: 10 });
  });

  it('freezes thread collaboration, budget, recipients, and member version into the envelope', () => {
    const version = 'a'.repeat(64);
    setState((state) => ({
      ...state,
      threadMemberships: {
        ...state.threadMemberships,
        threadA: {
          projectId: 'projA',
          threadId: 'threadA',
          roomId: 'roomA',
          version,
          memberIds: ['m1', 'm2'],
          eligibleMemberIds: ['m1', 'm2'],
          runningMemberIds: [],
        },
      },
    }));
    const envelope = buildThreadEnvelope(
      'r90-thread-envelope',
      'threadA',
      'Synthetic thread request',
      'default',
      undefined,
      {
        mentionIds: ['m1', 'm2'],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      },
    );
    expect(envelope.params).toMatchObject({
      collaboration: 'deliberate',
      deliberationBudget: { maxTurns: 10 },
      threadMemberVersion: version,
      mentions: [
        { kind: 'member', memberId: 'm1' },
        { kind: 'member', memberId: 'm2' },
      ],
    });
  });

  it('enters the correct project room and ignores a cancelled late load', async () => {
    const pendingRoomList: { resolve: ((value: { ok: boolean; data: unknown }) => void) | null } = { resolve: null };
    let holdFirstRoomList = true;
    const { location } = installWindow(async (envelope) => {
      if (envelope.method === 'room.list' && holdFirstRoomList) {
        holdFirstRoomList = false;
        return await new Promise((resolve) => { pendingRoomList.resolve = resolve; });
      }
      switch (envelope.method) {
        case 'room.list':
          return {
            ok: true,
            data: {
              items: [{ id: 'roomB', name: '项目 B 房间', conversationId: 'convB', revision: 3 }],
            },
          };
        case 'member.list':
          return {
            ok: true,
            data: {
              items: [
                { id: 'm1', displayName: 'A', principalType: 'agent', enabled: true },
                { id: 'm2', displayName: 'B', principalType: 'agent', enabled: true },
              ],
            },
          };
        case 'conversation.list':
          return { ok: true, data: { conversations: [] } };
        case 'runtime.status':
          return { ok: true, data: { memberBindings: [], dispatchGuard: null } };
        case 'navigation.set':
          return { ok: true, data: { saved: true } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    const beforeHash = location.hash;
    const cancelled = openSidebarRoom('projB', 'roomB');
    cancelAllNavIntents();
    pendingRoomList.resolve?.({ ok: true, data: { items: [] } });
    await expect(cancelled).resolves.toBe(false);
    expect(getState().activeProjectId).toBe('projA');
    expect(location.hash).toBe(beforeHash);

    await expect(openSidebarRoom('projB', 'roomB')).resolves.toBe(true);
    expect(getState().activeProjectId).toBe('projB');
    expect(getState().rooms.find((item) => item.id === 'roomB')?.conversationId).toBe('convB');
    expect(getState().rooms.find((item) => item.id === 'roomB')?.memberIds).toEqual(['m1', 'm2']);
    expect(location.hash.replace(/^#/, '')).toBe('/project/projB/room/roomB');
  });

  it('keeps the R106 landing marker while a post-commit refresh is delayed so the stale route yields', async () => {
    setState((state) => ({
      ...state,
      rooms: [room('room_default_projA', 'projA', 'conv_default_projA', '默认房间')],
    }));
    const urlSeqAtStart = currentNavSeq();
    let roomListCalls = 0;
    let refreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let staleRouteResult: 'not-run' | 'yielded' | 'stole-focus' = 'not-run';

    const runStaleProjectAlignEffect = () => {
      const state = getState();
      const routeProjectId = 'projA';
      if (state.activeProjectId === routeProjectId) return;
      const opening = state.openInFlightTarget;
      if (opening != null && opening.projectId !== routeProjectId && opening.urlSeqAtStart >= currentNavSeq()) {
        staleRouteResult = 'yielded';
        return;
      }
      staleRouteResult = 'stole-focus';
      focusProject(routeProjectId, { system: true });
    };

    const { location } = installWindow(async (envelope) => {
      switch (envelope.method) {
        case 'room.list':
          roomListCalls += 1;
          if (roomListCalls === 2) {
            runStaleProjectAlignEffect();
            refreshStarted();
            await delayedRefresh;
          }
          return {
            ok: true,
            data: {
              items: [{ id: 'room_default_projB', name: '默认房间', conversationId: 'conv_default_projB', revision: 1 }],
            },
          };
        case 'member.list':
          return { ok: true, data: { items: [{ id: 'mB', displayName: 'B', principalType: 'agent', enabled: true }] } };
        case 'conversation.list':
          return { ok: true, data: { conversations: [] } };
        case 'runtime.status':
          return { ok: true, data: { memberBindings: [], dispatchGuard: null } };
        case 'navigation.set':
          return { ok: true, data: { saved: true } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });

    const opening = openSidebarRoom('projB', 'room_default_projB');
    await refreshGate;
    expect(staleRouteResult).toBe('yielded');
    expect(getState().openInFlightTarget).toEqual({ projectId: 'projB', urlSeqAtStart });
    releaseRefresh();

    await expect(opening).resolves.toBe(true);
    expect(getState().activeProjectId).toBe('projB');
    expect(getState().rooms.map((item) => [item.id, item.conversationId])).toEqual([
      ['room_default_projB', 'conv_default_projB'],
    ]);
    expect(getState().openInFlight).toBe(false);
    expect(getState().openInFlightTarget).toBeNull();
    expect(location.hash.replace(/^#/, '')).toBe('/project/projB/room/room_default_projB');
  });

  it('lets only the latest of three rapid project-room opens own state and drops a late refresh', async () => {
    setState((state) => ({
      ...state,
      rooms: [room('room_default_projA', 'projA', 'conv_default_projA', '默认房间')],
    }));
    let bRoomLists = 0;
    let cRoomLists = 0;
    let bRefreshStarted!: () => void;
    let cRefreshStarted!: () => void;
    const bStarted = new Promise<void>((resolve) => { bRefreshStarted = resolve; });
    const cStarted = new Promise<void>((resolve) => { cRefreshStarted = resolve; });
    let releaseBRefresh!: () => void;
    let releaseCRefresh!: () => void;
    const bRefreshGate = new Promise<void>((resolve) => { releaseBRefresh = resolve; });
    const cRefreshGate = new Promise<void>((resolve) => { releaseCRefresh = resolve; });

    const { location } = installWindow(async (envelope) => {
      switch (envelope.method) {
        case 'room.list': {
          const targetProjectId = envelope.params.projectId;
          if (targetProjectId === 'projB') {
            bRoomLists += 1;
            if (bRoomLists === 2) {
              bRefreshStarted();
              await bRefreshGate;
            }
            return {
              ok: true,
              data: {
                items: [{ id: 'room_default_projB', name: '默认房间', conversationId: 'conv_default_projB', revision: 1 }],
              },
            };
          }
          if (targetProjectId === 'projC') {
            cRoomLists += 1;
            if (cRoomLists === 2) {
              cRefreshStarted();
              await cRefreshGate;
            }
            return {
              ok: true,
              data: {
                items: [{ id: 'room_default_projC', name: '默认房间', conversationId: 'conv_default_projC', revision: 1 }],
              },
            };
          }
          throw new Error(`unexpected room project ${String(targetProjectId)}`);
        }
        case 'member.list':
          return { ok: true, data: { items: [{ id: 'mLatest', displayName: 'Latest', principalType: 'agent', enabled: true }] } };
        case 'conversation.list':
          return { ok: true, data: { conversations: [] } };
        case 'runtime.status':
          return { ok: true, data: { memberBindings: [], dispatchGuard: null } };
        case 'navigation.set':
          return { ok: true, data: { saved: true } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });

    const openingB = openSidebarRoom('projB', 'room_default_projB');
    await bStarted;
    expect(getState().activeProjectId).toBe('projB');
    expect(getState().openInFlightTarget?.projectId).toBe('projB');
    const bGeneration = getState().loadGen;

    const openingC = openSidebarRoom('projC', 'room_default_projC');
    await cStarted;
    expect(getState().activeProjectId).toBe('projC');
    expect(getState().openInFlight).toBe(true);
    expect(getState().openInFlightTarget?.projectId).toBe('projC');
    const cGeneration = getState().loadGen;
    expect(cGeneration).toBeGreaterThan(bGeneration);

    releaseBRefresh();
    await expect(openingB).resolves.toBe(false);
    expect(getState().activeProjectId).toBe('projC');
    expect(getState().loadGen).toBe(cGeneration);
    expect(getState().openInFlight).toBe(true);
    expect(getState().openInFlightTarget?.projectId).toBe('projC');
    expect(getState().rooms.map((item) => item.projectId)).not.toContain('projB');

    releaseCRefresh();
    await expect(openingC).resolves.toBe(true);
    expect(getState().activeProjectId).toBe('projC');
    expect(getState().rooms.map((item) => [item.id, item.conversationId])).toEqual([
      ['room_default_projC', 'conv_default_projC'],
    ]);
    expect(getState().openInFlight).toBe(false);
    expect(getState().openInFlightTarget).toBeNull();
    expect(location.hash.replace(/^#/, '')).toBe('/project/projC/room/room_default_projC');
  });

  it('rolls back only its own post-commit snapshot when the delayed refresh fails', async () => {
    setState((state) => ({
      ...state,
      rooms: [room('room_default_projA', 'projA', 'conv_default_projA', '默认房间')],
    }));
    const previousLoadGen = getState().loadGen;
    let roomListCalls = 0;
    let refreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });

    const { location } = installWindow(async (envelope) => {
      switch (envelope.method) {
        case 'room.list':
          roomListCalls += 1;
          if (roomListCalls === 2) {
            refreshStarted();
            await delayedRefresh;
            throw new Error('synthetic post-commit refresh failure');
          }
          return {
            ok: true,
            data: {
              items: [{ id: 'room_default_projB', name: '默认房间', conversationId: 'conv_default_projB', revision: 1 }],
            },
          };
        case 'member.list':
          return { ok: true, data: { items: [] } };
        case 'conversation.list':
          return { ok: true, data: { conversations: [] } };
        case 'runtime.status':
          return { ok: true, data: { memberBindings: [], dispatchGuard: null } };
        case 'navigation.set':
          return { ok: true, data: { saved: true } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });

    const opening = openSidebarRoom('projB', 'room_default_projB');
    await refreshGate;
    expect(getState().openInFlightTarget?.projectId).toBe('projB');
    releaseRefresh();

    await expect(opening).resolves.toBe(false);
    expect(getState().activeProjectId).toBe('projA');
    expect(getState().loadGen).toBeGreaterThan(previousLoadGen);
    expect(getState().rooms.map((item) => [item.id, item.conversationId])).toEqual([
      ['room_default_projA', 'conv_default_projA'],
    ]);
    expect(getState().openInFlight).toBe(false);
    expect(getState().openInFlightTarget).toBeNull();
    expect(location.hash).toBe('#/project/projA/room/roomA');
  });
});
