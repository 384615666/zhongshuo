import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversationQuoteToDraft,
  advanceThreadReadWatermark,
  composeDraftOutboundBody,
  conversationQuotesForModel,
  getDraftFull,
  getState,
  initDraftPersistence,
  setDraftFull,
  setState,
  settleOutbound,
  type HifiState,
  type PendingSendEnvelope,
} from '../../src/ui/hifi/data/store';
import { Composer } from '../../src/ui/hifi/components/Composer.tsx';
import { messageSelectionText } from '../../src/ui/hifi/components/MessageView.tsx';
import { NavUnreadDot } from '../../src/ui/hifi/components/NavMarks.tsx';
import { RootCard } from '../../src/ui/hifi/pages/Room.tsx';
import { hasUnread, roomUnread, unreadCount } from '../../src/ui/hifi/data/selectors.ts';
import {
  cancelThreadReadOnOpen,
  loadRoomPool,
  loadThread,
  threadOpenReadRouteMatches,
} from '../../src/ui/hifi/loader.ts';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

const initial = getState();
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    body: { classList: { contains: () => false } },
  });
});

afterEach(() => {
  setState(() => initial);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('R127 structured conversation quotes', () => {
  it('keeps selected source text out of the editable body while preserving the full model body', () => {
    const draftKey = 'thread:quote-structured';
    const source = `第一行：保留完整历史。\n${'很长的引用正文 '.repeat(300)}\n最后一行不能丢失`;
    setDraftFull(draftKey, {
      body: '请基于这段历史继续修改',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
    });
    const added = addConversationQuoteToDraft(draftKey, {
      messageId: 'msg_history_long',
      authorLabel: '助手消息',
      threadMessageSeq: 42,
      text: source,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const duplicate = addConversationQuoteToDraft(draftKey, {
      messageId: 'msg_history_long',
      authorLabel: '助手消息',
      threadMessageSeq: 42,
      text: source,
    });
    expect(duplicate).toMatchObject({ ok: true, existed: true });
    const draft = getDraftFull(draftKey);
    expect(draft.body).toBe('请基于这段历史继续修改');
    expect(draft.body).not.toContain('很长的引用正文');
    expect(draft.conversationQuotes).toHaveLength(1);
    expect(draft.conversationQuotes?.[0]?.text).toBe(source);
    const outbound = composeDraftOutboundBody(draft.body, draft.conversationQuotes ?? []);
    expect(outbound.replace(/^> /gm, '')).toContain(source);
    expect(outbound.endsWith('请基于这段历史继续修改')).toBe(true);
    expect(storage.getItem('zs.hifi.persist.quote-ns')).toBeNull();
    initDraftPersistence('quote-ns');
    expect(storage.getItem('zs.hifi.persist.quote-ns')).toContain('msg_history_long');
  });

  it('renders only a compact quote trigger by default and keeps other draft targets isolated', () => {
    const draftKey = 'thread:quote-card';
    const otherKey = 'thread:quote-other';
    setDraftFull(draftKey, {
      body: '用户补充',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
    });
    const added = addConversationQuoteToDraft(draftKey, {
      messageId: 'msg_card',
      authorLabel: '成员甲',
      threadMessageSeq: 7,
      text: '卡片中的完整引用正文，不应进入 contenteditable。',
    });
    expect(added.ok).toBe(true);
    expect((getDraftFull(otherKey).conversationQuotes ?? [])).toEqual([]);
    const html = renderToStaticMarkup(createElement(Composer, {
      target: { kind: 'thread', roomId: 'r1', threadId: 't1' },
      draftKey,
      onSend: () => undefined,
    }));
    expect(html).toContain('data-zs-conversation-quote-count="1"');
    expect(html).toContain('1 条对话引用');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-zs-conversation-quote-popover');
    expect(html).not.toContain('成员甲 · #7');
    expect(html).not.toContain('卡片中的完整引用正文');
    const editor = html.slice(html.indexOf('class="composer-input composer-editor"'));
    expect(editor).not.toContain('卡片中的完整引用正文');
  });

  it('gives simultaneous root and thread composers distinct popover ids', () => {
    const rootKey = 'room:quote-id-root';
    const threadKey = 'thread:quote-id-thread';
    setDraftFull(rootKey, { body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    setDraftFull(threadKey, { body: '', mentions: [], attachments: [], access: 'default', sendAs: 'ai' });
    addConversationQuoteToDraft(rootKey, {
      messageId: 'root-message', authorLabel: '你', text: '主池引用',
    });
    addConversationQuoteToDraft(threadKey, {
      messageId: 'thread-message', authorLabel: '成员甲', threadMessageSeq: 4, text: '线程引用',
    });
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(Composer, {
        target: { kind: 'room_root', roomId: 'r1' },
        draftKey: rootKey,
        onSend: () => undefined,
      }),
      createElement(Composer, {
        target: { kind: 'thread', roomId: 'r1', threadId: 't1' },
        draftKey: threadKey,
        onSend: () => undefined,
      }),
    ));
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('settles only the quote ids sent by the frozen envelope', () => {
    const draftKey = 'thread:quote-settle';
    setDraftFull(draftKey, {
      body: '补充要求',
      mentions: [],
      attachments: [{ name: '保留.md', size: 1, attachmentId: 'att_keep' }],
      access: 'default',
      sendAs: 'ai',
    });
    const first = addConversationQuoteToDraft(draftKey, {
      messageId: 'm1', authorLabel: '成员甲', threadMessageSeq: 1, text: '第一条引用',
    });
    const second = addConversationQuoteToDraft(draftKey, {
      messageId: 'm2', authorLabel: '成员乙', threadMessageSeq: 2, text: '第二条引用',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const before = getDraftFull(draftKey);
    const body = composeDraftOutboundBody(before.body, before.conversationQuotes ?? []);
    const env: PendingSendEnvelope = {
      commandId: 'cmd_quote_settle',
      method: 'message.submit',
      params: { target: { kind: 'thread', threadId: 't1' }, body, intent: 'default', mentions: [] },
      targetLabel: draftKey,
      at: Date.now(),
      revAtSend: before.rev,
      quoteIds: [first.quote.id],
    };
    const settled = settleOutbound(draftKey, env);
    expect(settled.body).toBe('');
    expect(settled.conversationQuotes?.map((quote) => quote.id)).toEqual([second.quote.id]);
    expect(settled.attachments.map((attachment) => attachment.attachmentId)).toEqual(['att_keep']);
  });
});

describe('R127 selection and unread feedback', () => {
  it('accepts only a non-empty selection wholly inside the current message and preserves its whitespace', () => {
    const insideA = {} as Node;
    const insideB = {} as Node;
    const outside = {} as Node;
    const root = { contains: (node: Node) => node === insideA || node === insideB } as Node;
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: insideA,
      focusNode: insideB,
      toString: () => '  需要引用的选区  ',
    } as unknown as Selection;
    expect(messageSelectionText(root, selection)).toBe('  需要引用的选区  ');
    expect(messageSelectionText(root, { ...selection, focusNode: outside } as unknown as Selection)).toBe('');
    expect(messageSelectionText(root, { ...selection, isCollapsed: true } as unknown as Selection)).toBe('');
    expect(messageSelectionText(root, {
      ...selection,
      toString: () => ' \n\t ',
    } as unknown as Selection)).toBe('');
  });

  it('checks non-empty selection text with trim but stores the exact selected bytes', () => {
    const draftKey = 'thread:quote-whitespace';
    const selected = '  \n保留首行首尾空白\n\t';
    const added = addConversationQuoteToDraft(draftKey, {
      messageId: 'message-whitespace',
      authorLabel: '成员甲',
      threadMessageSeq: 12,
      text: selected,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(getDraftFull(draftKey).conversationQuotes?.[0]?.text).toBe(selected);
    expect(conversationQuotesForModel([added.quote])).toBe(
      '> 引用成员甲 · #12\n>   \n> 保留首行首尾空白\n> \t',
    );
  });

  it('advances card and loader watermarks together, monotonically', () => {
    setState((state) => ({
      ...state,
      readStates: { ...state.readStates, t_watermark: 7 },
      threadReadSeq: { ...state.threadReadSeq, t_watermark: 5 },
    }));
    advanceThreadReadWatermark('t_watermark', 3);
    expect(getState().readStates.t_watermark).toBe(7);
    expect(getState().threadReadSeq.t_watermark).toBe(7);
    advanceThreadReadWatermark('t_watermark', 9);
    expect(getState().readStates.t_watermark).toBe(9);
    expect(getState().threadReadSeq.t_watermark).toBe(9);
  });

  it('uses pool lastMessageSeq as the no-history unread gate in selectors, sidebar, and main-pool DOM', () => {
    const projectId = 'project_pool_badge';
    const roomId = 'room_pool_badge';
    const threadId = 'thread_pool_badge';
    const rootMessage = {
      id: 'root_pool_badge',
      projectId,
      roomId,
      authorType: 'human' as const,
      authorId: 'you',
      kind: 'text' as const,
      body: '主池根消息',
      createdAt: 1,
      attachmentIds: [],
    };
    const poolCard = {
      threadId,
      projectId,
      roomId,
      anchorMessageId: rootMessage.id,
      lastMessageSeq: 10,
      taskId: null,
      taskStatus: null,
      roomTaskNumber: null,
      taskTitle: null,
      body: rootMessage.body,
      createdAt: 1,
      replyCount: 3,
      lastReplyAt: 2,
      unread: 3,
      muted: false,
      followed: false,
    };
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '未读水位', conversationId: 'conv_pool_badge',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 3,
      }],
      members: [],
      messages: [rootMessage],
      threads: [{
        id: threadId, projectId, roomId, conversationId: 'conv_pool_badge',
        anchorMessageId: rootMessage.id, status: 'open', lastMessageSeq: 10, revision: 1,
      }],
      roomPool: { [roomId]: [poolCard] },
      readStates: { [threadId]: 10 },
      threadReadSeq: { [threadId]: 10 },
      threadEntities: {},
      threadMessages: {},
      threadAnchors: {},
      threadTasks: {},
    }));
    expect(unreadCount(getState(), threadId)).toBe(0);
    expect(hasUnread(getState(), threadId)).toBe(false);
    expect(roomUnread(getState(), roomId)).toBe(0);
    expect(renderToStaticMarkup(createElement(NavUnreadDot, {
      count: roomUnread(getState(), roomId),
      where: '未读水位',
    }))).toBe('');
    expect(renderToStaticMarkup(createElement(RootCard, {
      message: rootMessage,
      selected: false,
    }))).not.toContain('3 条未读');

    setState((state) => ({
      ...state,
      readStates: { ...state.readStates, [threadId]: 5 },
      threadReadSeq: { ...state.threadReadSeq, [threadId]: 5 },
    }));
    expect(unreadCount(getState(), threadId)).toBe(3);
    expect(hasUnread(getState(), threadId)).toBe(true);
    expect(renderToStaticMarkup(createElement(NavUnreadDot, {
      count: roomUnread(getState(), roomId),
      where: '未读水位',
    }))).toContain('side-unread-dot');
    expect(renderToStaticMarkup(createElement(RootCard, {
      message: rootMessage,
      selected: false,
    }))).toContain('3 条未读');

    setState((state) => ({
      ...state,
      readStates: { ...state.readStates, [threadId]: 10 },
      threadReadSeq: { ...state.threadReadSeq, [threadId]: 10 },
      roomPool: {
        ...state.roomPool,
        [roomId]: [{ ...poolCard, lastMessageSeq: 7 }],
      },
    }));
    expect(unreadCount(getState(), threadId)).toBe(0);

    setState((state) => ({
      ...state,
      roomPool: {
        ...state.roomPool,
        [roomId]: [{ ...poolCard, lastMessageSeq: 11, unread: 2 }],
      },
    }));
    expect(unreadCount(getState(), threadId)).toBe(2);
    expect(hasUnread(getState(), threadId)).toBe(true);

    setState((state) => ({
      ...state,
      messages: [
        rootMessage,
        {
          ...rootMessage,
          id: 'old_reply_pool_badge',
          threadId,
          threadMessageSeq: 9,
          body: '旧历史窗口里的回复',
        },
      ],
    }));
    expect(unreadCount(getState(), threadId)).toBe(2);

    setState((state) => ({
      ...state,
      readStates: { ...state.readStates, [threadId]: 11 },
      threadReadSeq: { ...state.threadReadSeq, [threadId]: 11 },
    }));
    expect(unreadCount(getState(), threadId)).toBe(0);
  });

  it('projects pool lastMessageSeq into the thread view and never lowers an authoritative newer sequence', async () => {
    const projectId = 'project_pool_seq';
    const roomId = 'room_pool_seq';
    const threadId = 'thread_pool_seq';
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: 'pool seq', conversationId: 'conv_pool_seq',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 1,
      }],
      members: [],
      messages: [],
      threads: [{
        id: threadId, projectId, roomId, conversationId: 'conv_pool_seq',
        anchorMessageId: 'root_pool_seq', status: 'open', lastMessageSeq: 12, revision: 3,
      }],
      roomPool: {},
      threadEntities: {
        [threadId]: {
          id: threadId, projectId, roomId, conversationId: 'conv_pool_seq',
          anchorMessageId: 'root_pool_seq', status: 'open', lastMessageSeq: 12, revision: 3,
        },
      },
      threadAnchors: {},
      threadMessages: {},
      threadTasks: {},
    }));
    let poolSeq = 9;
    const command = vi.fn(async (envelope: { method: string }) => {
      expect(envelope.method).toBe('room.pool');
      return {
        ok: true,
        data: {
          items: [{
            threadId,
            anchorMessageId: 'root_pool_seq',
            lastMessageSeq: poolSeq,
            body: { text: 'root' },
            createdAt: 1,
            replyCount: 1,
            unread: 1,
          }],
        },
      };
    });
    vi.stubGlobal('window', {
      zs: { command },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    await loadRoomPool(roomId);
    expect(getState().roomPool[roomId]?.[0]?.lastMessageSeq).toBe(9);
    expect(getState().threadEntities[threadId]?.lastMessageSeq).toBe(12);
    expect(getState().threads.find((thread) => thread.id === threadId)?.lastMessageSeq).toBe(12);

    poolSeq = 14;
    await loadRoomPool(roomId);
    expect(getState().roomPool[roomId]?.[0]?.lastMessageSeq).toBe(14);
    expect(getState().threadEntities[threadId]?.lastMessageSeq).toBe(14);
    expect(getState().threads.find((thread) => thread.id === threadId)?.lastMessageSeq).toBe(14);
  });

  it('checks the exact current thread route instead of merely matching the project', () => {
    expect(threadOpenReadRouteMatches('t1', 'p1', 'r1', '/project/p1/room/r1?thread=t1')).toBe(true);
    expect(threadOpenReadRouteMatches('t1', 'p1', 'r1', '/thread/t1?tab=delivery')).toBe(true);
    expect(threadOpenReadRouteMatches('t1', 'p1', 'r1', '/project/p1/room/r1?thread=t2')).toBe(false);
    expect(threadOpenReadRouteMatches('t1', 'p1', 'r1', '/project/p1/room/r1')).toBe(false);
    expect(threadOpenReadRouteMatches('t1', 'p1', 'r1', '/settings')).toBe(false);
  });

  it('advances locally as soon as thread.get returns and does not wait for the markRead ACK', async () => {
    const projectId = 'project_read_open';
    const roomId = 'room_read_open';
    const threadId = 'thread_read_open';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '读取测试', conversationId: 'conv_read_open',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 3,
      }],
      members: [],
      messages: [],
      threads: [],
      readStates: {},
      threadReadSeq: {},
      ui: { ...state.ui, activeThreadId: threadId },
      roomPool: {},
      threadEntities: {},
      threadAnchors: {},
      threadMessages: {},
      threadTasks: {},
    }));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let releaseHistory = (): void => {};
    const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    let releaseAck = (): void => {};
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const command = vi.fn(async (envelope: { method: string; params: Record<string, unknown> }) => {
      calls.push({ method: envelope.method, params: envelope.params });
      switch (envelope.method) {
        case 'thread.get':
          return {
            ok: true,
            data: {
              thread: {
                id: threadId, projectId, conversationId: 'conv_read_open', roomId,
                anchorMessageId: 'root_read_open', rootTaskId: null, status: 'open',
                lastMessageSeq: 7, revision: 1,
              },
              anchor: {
                id: 'root_read_open', authorType: 'human', authorId: 'you',
                body: { text: '开始' }, createdAt: 1, conversationSeq: 1,
              },
              lastReadSeq: 2,
            },
          };
        case 'thread.history':
          await historyGate;
          return {
            ok: true,
            data: {
              items: [{
                id: 'reply_read_open', authorType: 'agent', authorId: 'm1', seq: 7,
                body: { text: '最新回复' }, createdAt: 2,
              }],
              rootAttachments: [],
            },
          };
        case 'thread.markRead':
          await ackGate;
          return { ok: true, data: { marked: true } };
        case 'room.pool':
          return { ok: true, data: { items: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadId}` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const loading = loadThread(threadId, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => true,
    });
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === 'thread.markRead'
        && call.params.throughMessageSeq === 7)).toBe(true);
      expect(getState().readStates[threadId]).toBe(7);
      expect(getState().threadReadSeq[threadId]).toBe(7);
    });
    expect(calls.some((call) => call.method === 'thread.history')).toBe(true);
    releaseAck();
    releaseHistory();
    await loading;
    expect(base.threadReadSeq[threadId]).toBeUndefined();
  });

  it('marks a cached entity before delayed thread.get and keeps its newer authoritative sequence when the old ACK fails', async () => {
    const projectId = 'project_cached_delayed_get';
    const roomId = 'room_cached_delayed_get';
    const threadId = 'thread_cached_delayed_get';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '缓存开读', conversationId: 'conv_cached_delayed_get',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 5,
      }],
      members: [],
      messages: [],
      threads: [],
      readStates: { [threadId]: 2 },
      threadReadSeq: { [threadId]: 2 },
      roomPool: {},
      threadEntities: {
        [threadId]: {
          id: threadId,
          projectId,
          conversationId: 'conv_cached_delayed_get',
          roomId,
          anchorMessageId: 'root_cached_delayed_get',
          status: 'open',
          lastMessageSeq: 7,
          revision: 1,
        },
      },
      threadAnchors: {},
      threadMessages: {},
      threadTasks: {},
      ui: { ...state.ui, activeThreadId: threadId },
    }));
    let releaseGet = (): void => {};
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let rejectFirst = (): void => {};
    const firstGate = new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(new Error('older cached ACK failed'));
    });
    let releaseSecond = (): void => {};
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const markSequences: number[] = [];
    const command = vi.fn(async (envelope: { method: string; params: Record<string, unknown> }) => {
      switch (envelope.method) {
        case 'thread.get':
          await getGate;
          return {
            ok: true,
            data: {
              thread: {
                id: threadId, projectId, conversationId: 'conv_cached_delayed_get', roomId,
                anchorMessageId: 'root_cached_delayed_get', rootTaskId: null, status: 'open',
                lastMessageSeq: 10, revision: 2,
              },
              anchor: null,
              lastReadSeq: 2,
            },
          };
        case 'thread.markRead': {
          const seq = Number(envelope.params.throughMessageSeq);
          markSequences.push(seq);
          if (seq === 7) {
            await firstGate;
          } else if (seq === 10) {
            await secondGate;
          } else {
            throw new Error(`unexpected mark sequence ${seq}`);
          }
          return { ok: true, data: { marked: true } };
        }
        case 'thread.history':
          return { ok: true, data: { items: [], rootAttachments: [] } };
        case 'room.pool':
          return { ok: true, data: { items: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadId}` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const loading = loadThread(threadId, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => true,
    });
    await vi.waitFor(() => {
      expect(markSequences).toEqual([7]);
      expect(getState().readStates[threadId]).toBe(7);
      expect(getState().threadReadSeq[threadId]).toBe(7);
    });
    releaseGet();
    await vi.waitFor(() => {
      expect(getState().readStates[threadId]).toBe(10);
      expect(getState().threadReadSeq[threadId]).toBe(10);
      expect(markSequences).toEqual([7]);
    });
    rejectFirst();
    await vi.waitFor(() => {
      expect(markSequences).toEqual([7, 10]);
      expect(getState().readStates[threadId]).toBe(10);
      expect(getState().threadReadSeq[threadId]).toBe(10);
    });
    releaseSecond();
    await loading;
    await vi.waitFor(() => {
      expect(getState().readStates[threadId]).toBe(10);
      expect(getState().threadReadSeq[threadId]).toBe(10);
    });
    expect(base.readStates[threadId]).toBeUndefined();
  });

  it('drops a delayed thread.get response after the user switches from A to B', async () => {
    const projectId = 'project_delayed_get';
    const roomId = 'room_delayed_get';
    const threadA = 'thread_delayed_a';
    const threadB = 'thread_delayed_b';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '切串测试', conversationId: 'conv_delayed_get',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 2,
      }],
      members: [],
      messages: [],
      threads: [],
      readStates: {},
      threadReadSeq: {},
      roomPool: {},
      threadEntities: {},
      threadAnchors: {},
      threadMessages: {},
      threadTasks: {},
      ui: { ...state.ui, activeThreadId: threadA },
    }));
    let releaseGet = (): void => {};
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
    const calls: string[] = [];
    const command = vi.fn(async (envelope: { method: string }) => {
      calls.push(envelope.method);
      switch (envelope.method) {
        case 'thread.get':
          await getGate;
          return {
            ok: true,
            data: {
              thread: {
                id: threadA, projectId, conversationId: 'conv_delayed_get', roomId,
                anchorMessageId: 'root_delayed_a', rootTaskId: null, status: 'open',
                lastMessageSeq: 9, revision: 1,
              },
              anchor: null,
              lastReadSeq: 2,
            },
          };
        case 'thread.history':
          return { ok: true, data: { items: [], rootAttachments: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadA}` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const loading = loadThread(threadA, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => getState().ui.activeThreadId === threadA,
    });
    setState((state) => ({ ...state, ui: { ...state.ui, activeThreadId: threadB } }));
    window.location.hash = `#/thread/${threadB}`;
    cancelThreadReadOnOpen(threadA);
    releaseGet();
    await loading;
    expect(calls).not.toContain('thread.markRead');
    expect(getState().readStates[threadA]).toBe(2);
    expect(getState().threadReadSeq[threadA]).toBe(2);
    expect(getState().readStates[threadB]).toBeUndefined();
    expect(base.readStates[threadA]).toBeUndefined();
  });

  it('keeps an already advanced A through a delayed ACK after switching to B and never touches B', async () => {
    const projectId = 'project_delayed_ack';
    const roomId = 'room_delayed_ack';
    const threadA = 'thread_delayed_ack_a';
    const threadB = 'thread_delayed_ack_b';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: 'ACK 测试', conversationId: 'conv_delayed_ack',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 4,
      }],
      members: [], messages: [], threads: [], readStates: {}, threadReadSeq: {},
      roomPool: {}, threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {},
      ui: { ...state.ui, activeThreadId: threadA },
    }));
    let releaseAck = (): void => {};
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const calls: string[] = [];
    const command = vi.fn(async (envelope: { method: string }) => {
      calls.push(envelope.method);
      switch (envelope.method) {
        case 'thread.get':
          return {
            ok: true,
            data: {
              thread: {
                id: threadA, projectId, conversationId: 'conv_delayed_ack', roomId,
                anchorMessageId: 'root_delayed_ack_a', rootTaskId: null, status: 'open',
                lastMessageSeq: 11, revision: 1,
              },
              anchor: null,
              lastReadSeq: 3,
            },
          };
        case 'thread.markRead':
          await ackGate;
          return { ok: true, data: { marked: true } };
        case 'thread.history':
          return { ok: true, data: { items: [], rootAttachments: [] } };
        case 'room.pool':
          return { ok: true, data: { items: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadA}` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const loading = loadThread(threadA, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => getState().ui.activeThreadId === threadA,
    });
    await vi.waitFor(() => {
      expect(getState().readStates[threadA]).toBe(11);
      expect(calls).toContain('thread.markRead');
    });
    setState((state) => ({ ...state, ui: { ...state.ui, activeThreadId: threadB } }));
    window.location.hash = `#/thread/${threadB}`;
    cancelThreadReadOnOpen(threadA);
    releaseAck();
    await loading;
    expect(getState().readStates[threadA]).toBe(11);
    expect(getState().threadReadSeq[threadA]).toBe(11);
    expect(getState().readStates[threadB]).toBeUndefined();
    expect(calls).not.toContain('room.pool');
    expect(base.threadReadSeq[threadA]).toBeUndefined();
  });

  it('rolls back a failed ACK and permits the next open to retry', async () => {
    const projectId = 'project_ack_retry';
    const roomId = 'room_ack_retry';
    const threadId = 'thread_ack_retry';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '失败重试', conversationId: 'conv_ack_retry',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 2,
      }],
      members: [], messages: [], threads: [], readStates: {}, threadReadSeq: {},
      roomPool: {}, threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {},
      ui: { ...state.ui, activeThreadId: threadId },
    }));
    let markAttempts = 0;
    const command = vi.fn(async (envelope: { method: string }) => {
      switch (envelope.method) {
        case 'thread.get':
          return {
            ok: true,
            data: {
              thread: {
                id: threadId, projectId, conversationId: 'conv_ack_retry', roomId,
                anchorMessageId: 'root_ack_retry', rootTaskId: null, status: 'open',
                lastMessageSeq: 8, revision: 1,
              },
              anchor: null,
              lastReadSeq: 2,
            },
          };
        case 'thread.markRead':
          markAttempts += 1;
          if (markAttempts === 1) throw new Error('FIFO unavailable');
          return { ok: true, data: { marked: true } };
        case 'thread.history':
          return { ok: true, data: { items: [], rootAttachments: [] } };
        case 'room.pool':
          return { ok: true, data: { items: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadId}` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    await loadThread(threadId, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => true,
    });
    await vi.waitFor(() => {
      expect(markAttempts).toBe(1);
      expect(getState().readStates[threadId]).toBe(2);
      expect(getState().threadReadSeq[threadId]).toBe(2);
    });
    await loadThread(threadId, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => true,
    });
    await vi.waitFor(() => {
      expect(markAttempts).toBe(2);
      expect(getState().readStates[threadId]).toBe(8);
      expect(getState().threadReadSeq[threadId]).toBe(8);
    });
    expect(base.readStates[threadId]).toBeUndefined();
  });

  it('does not mark while the reply tab or foreground gate is false', async () => {
    const projectId = 'project_detail_gate';
    const roomId = 'room_detail_gate';
    const threadId = 'thread_detail_gate';
    const base = getState();
    setState((state): HifiState => ({
      ...state,
      activeProjectId: projectId,
      loadGen: state.loadGen + 1,
      rooms: [{
        id: roomId, projectId, name: '详情门', conversationId: 'conv_detail_gate',
        coordinatorMemberId: 'm1', memberIds: ['m1'], revision: 1, unread: 5,
      }],
      members: [], messages: [], threads: [], readStates: {}, threadReadSeq: {},
      roomPool: {}, threadEntities: {}, threadAnchors: {}, threadMessages: {}, threadTasks: {},
      ui: { ...state.ui, activeThreadId: threadId },
    }));
    const calls: string[] = [];
    const command = vi.fn(async (envelope: { method: string }) => {
      calls.push(envelope.method);
      switch (envelope.method) {
        case 'thread.get':
          return {
            ok: true,
            data: {
              thread: {
                id: threadId, projectId, conversationId: 'conv_detail_gate', roomId,
                anchorMessageId: 'root_detail_gate', rootTaskId: null, status: 'open',
                lastMessageSeq: 13, revision: 1,
              },
              anchor: null,
              lastReadSeq: 7,
            },
          };
        case 'thread.history':
          return { ok: true, data: { items: [], rootAttachments: [] } };
        default:
          throw new Error(`unexpected command ${envelope.method}`);
      }
    });
    vi.stubGlobal('window', {
      zs: { command },
      location: { hash: `#/thread/${threadId}?tab=delivery` },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    await loadThread(threadId, {
      markRead: true,
      markReadOnOpen: true,
      readOpenGuard: () => false,
    });
    expect(calls).not.toContain('thread.markRead');
    expect(getState().readStates[threadId]).toBe(7);
    expect(getState().threadReadSeq[threadId]).toBe(7);
    expect(base.readStates[threadId]).toBeUndefined();
  });
});
