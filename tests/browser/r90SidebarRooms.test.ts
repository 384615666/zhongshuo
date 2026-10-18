import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HifiState } from '../../src/ui/hifi/data/store';
import { getState, setState } from '../../src/ui/hifi/data/store';
import { buildRoomRootEnvelope, buildThreadEnvelope, defaultDeliberationMaxTurns, loadSidebarRooms, openSidebarRoom } from '../../src/ui/hifi/loader';
import { cancelAllNavIntents } from '../../src/ui/hifi/lib/navIntent';

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

function room(id: string, projectId: string, conversationId: string) {
  return {
    id,
    projectId,
    name: `房间 ${id}`,
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
    setState((state) => ({
      ...state,
      projects: [a, b],
      activeProjectId: a.id,
      visibleProjectIds: [a.id, b.id],
      expandedProjectIds: [a.id, b.id],
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
    expect(defaultDeliberationMaxTurns(2)).toBe(14);
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
});
