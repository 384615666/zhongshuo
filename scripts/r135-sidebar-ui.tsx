import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/ui/hifi/App';
import { setState } from '../src/ui/hifi/data/store';
import type { Project } from '../src/ui/hifi/data/types';

// Real App/store/menus, entirely synthetic bridge; no preload, daemon or database.
const calls: string[] = [];
const unexpected: string[] = [];
const projects: Project[] = ['VoiceMeeter-backup', '中文长项目名称与English混合布局验证'.repeat(3), '短名'].map((displayName, i) => ({
  id: `r135-project-${i}`, displayName, rootPath: `Z:/r135-synthetic/project-${i}`, revision: 1,
  canonicalPath: `Z:/r135-synthetic/project-${i}`, directoryIdentity: `synthetic-${i}`, status: 'ok', isGit: false,
}));
const roomNames = ['这是很长的房间名称-VoiceMeeter-backup-'.repeat(4), '短房间'];
const rooms = projects.flatMap(p => roomNames.map((name, i) => ({ id: `${p.id}-room-${i}`, projectId: p.id, name, revision: 1, conversationId: `conversation-${p.id}-${i}`, memberIds: [], coordinatorMemberId: '', unread: 0 })));
(window as unknown as { zs: unknown }).zs = {
  command: async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === 'app.appearance.get') return { ok: true, data: { showAvatars: true, avatars: {} } };
    if (method === 'recovery.status') return { ok: true, data: { gateHeld: false, unknownTurns: [], pendingRelease: [], activeUndos: [], interruptedRuns: [], pendingDispatchCount: 0 } };
    if (method === 'navigation.preferences.update') return { ok: true, data: {} };
    unexpected.push(method);
    return { ok: false, error: { code: 'SYNTHETIC_ONLY', message: `No real service: ${method}` } };
  }, onDisconnect: () => {}, onReconnected: () => {},
};
setState(s => ({ ...s, boot: 'ready', projects, activeProjectId: projects[0]!.id,
  visibleProjectIds: projects.map(p => p.id), expandedProjectIds: projects.map(p => p.id), rooms,
  sidebarRoomIndexes: Object.fromEntries(projects.map(p => [p.id, { status: 'ready', rooms: rooms.filter(r => r.projectId === p.id) }])),
  // The first long room has both a task mark and an unread dot.
  tasks: [{ id: 'synthetic-task', projectId: projects[0]!.id, roomId: rooms[0]!.id, status: 'ACTIVE', conversationThreadId: 'synthetic-thread', roomTaskNumber: 1, displayNumber: 1, title: '合成任务', objective: null, revision: 1 }],
  threads: [{ id: 'synthetic-thread', projectId: projects[0]!.id, roomId: rooms[0]!.id, anchorMessageId: 'synthetic-message', status: 'open', lastMessageSeq: 3, revision: 1 }],
  messages: [{ id: 'synthetic-message', projectId: projects[0]!.id, roomId: rooms[0]!.id, threadId: 'synthetic-thread', threadMessageSeq: 3, authorType: 'agent', authorId: 'synthetic', kind: 'text', body: '合成消息', createdAt: 1 }],
}));
document.body.classList.add('hifi-on');
createRoot(document.getElementById('root')!).render(createElement(App));

const row = (i: number) => document.querySelectorAll<HTMLElement>('.sidebar .side-project > .side-row')[i]!;
const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
const visible = (el: Element) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && Number(s.opacity) > .99; };
(window as unknown as { r135: unknown }).r135 = {
  ready: () => document.querySelectorAll('.side-project').length === 3,
  setSidebar: (width: number | null) => { document.querySelector<HTMLElement>('.sidebar')!.style.width = width == null ? '' : `${width}px`; },
  focus: (i: number) => row(i).querySelector<HTMLElement>('.side-item-label-btn')!.focus(),
  blur: () => (document.activeElement as HTMLElement)?.blur(),
  point: (i: number, target: string) => { const r = rect(row(i).querySelector(target)!); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; },
  roomPoint: (i: number) => { const r = rect(document.querySelectorAll('.sidebar .side-item.sub')[i]!); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; },
  roomFocus: (i: number) => (document.querySelectorAll('.sidebar .side-item.sub')[i] as HTMLElement).focus(),
  snapshot: () => ({
    sidebar: rect(document.querySelector('.sidebar')!),
    projects: [...document.querySelectorAll('.sidebar .side-project > .side-row')].map(el => {
      const label = el.querySelector<HTMLElement>('.side-item-label')!;
      const actions = el.querySelector('.side-row-actions')!;
      return { row: rect(el), label: rect(label), actions: rect(actions), text: label.textContent,
        scrollWidth: label.scrollWidth, ellipsis: getComputedStyle(label).textOverflow, overflow: getComputedStyle(label).overflow,
        buttons: [...actions.querySelectorAll('button')].map(b => { const r = rect(b); return { rect: r, visible: visible(b), hit: b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), pointerEvents: getComputedStyle(b).pointerEvents }; }),
      };
    }),
    rooms: [...document.querySelectorAll('.sidebar .side-item.sub')].map(el => { const label = el.querySelector<HTMLElement>('.side-item-label')!; return {
      row: rect(el), label: rect(label), marks: rect(el.querySelector('.side-marks')!), scrollWidth: label.scrollWidth,
      ellipsis: getComputedStyle(label).textOverflow, overflow: getComputedStyle(label).overflow,
      stateMark: !!el.querySelector('.side-state'), unread: !!el.querySelector('.side-unread-dot'),
    }; }),
    active: document.activeElement?.className,
    activeAction: [...document.querySelectorAll('.sidebar .side-row-act')].indexOf(document.activeElement!),
    menu: !!document.querySelector('[role="menu"]'), dialog: document.querySelector('[role="dialog"]')?.textContent ?? '',
    calls, unexpected,
  }),
};
