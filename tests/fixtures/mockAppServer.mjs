/**
 * 本地 App Server 协议回放 mock（DEV-06 修复轮；不消耗模型额度）。
 * 用法：node mockAppServer.mjs <scenario.json> <rpc-log.jsonl>
 * 协议：stdin 换行 JSON-RPC；响应 initialize/thread/start|resume/turn/start|steer|interrupt；
 * 按 scenario 推送通知（可控制响应延迟以制造「通知先于响应」）。
 * 收到的每条请求追加写入 rpc-log（含 method/params），供测试断言 initialize 次数、
 * thread/resume、审批 deny 等。
 */
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rpcLog = process.argv[3];
const log = (entry) => appendFileSync(rpcLog, `${JSON.stringify(entry)}\n`, 'utf8');

let nextId = 9000;
let threadCounter = 0;
let turnCounter = 0;
let currentResultKey = null;
let buffer = '';
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\n');
    if (line.length === 0) continue;
    handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.id != null && msg.method != null) {
    log({ direction: 'request', id: msg.id, method: msg.method, params: msg.params });
    handleRequest(msg);
    return;
  }
  log({ direction: 'notification', method: msg.method, params: msg.params });
}

function handleRequest(msg) {
  const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const delay = scenario.initializeDelayMs ?? 0;
      setTimeout(() => reply({ codexHome: 'mock', userAgent: 'mock/0.157.1' }), delay);
      break;
    }
    case 'model/list':
      reply({data:scenario.models??[],nextCursor:null});
      break;
    case 'thread/start':
    case 'thread/resume': {
      threadCounter += 1;
      const threadId = msg.method === 'thread/resume' && msg.params?.threadId
        ? msg.params.threadId
        : `mock-thread-${threadCounter}`;
      const delay = scenario.threadStartDelayMs ?? 0;
      setTimeout(() => reply({ thread: { id: threadId }, model: 'mock', modelProvider: 'mock', serviceTier: null, cwd: 'D:/mock', approvalPolicy: 'never', sandbox: {} }), delay);
      break;
    }
    case 'turn/start': {
      // turns[i] = { notifications: [...], emitBeforeResponse?, responseDelayMs? }
      const script = scenario.turns?.[turnCounter] ?? {};
      turnCounter += 1;
      const threadId = currentThreadIdOf(msg.params);
      const providerTurnId = `mock-turn-${turnCounter}`;
      // 从输入包文本提取 resultKey（worker 信封含 resultKey=xxx），供结构化终态回显。
      const text = String(msg.params?.input?.[0]?.text ?? '');
      const rk = /resultKey=([A-Za-z0-9_-]+)/.exec(text);
      currentResultKey = rk?.[1] ?? null;
      const startNotifications = () => {
        for (const n of script.notifications ?? []) emit(threadId, providerTurnId, n);
      };
      const respond = () => reply({ turn: { id: providerTurnId, items: [], status: 'inProgress' } });
      if (script.emitBeforeResponse) {
        startNotifications();
        setTimeout(respond, script.responseDelayMs ?? 30);
      } else {
        setTimeout(() => {
          respond();
          startNotifications();
        }, script.responseDelayMs ?? 0);
      }
      break;
    }
    case 'turn/steer':
      reply({});
      break;
    case 'turn/interrupt':
      reply({});
      break;
    default:
      reply({});
  }
}

function currentThreadIdOf(params) {
  return params?.threadId ?? 'mock-thread-1';
}

/** 通知发射器：n = { kind, ...payload }，按真实协议形状映射（修复轮 3：
 * turn/started 与 turn/completed 无顶层 turnId——provider ID 只在 turn.id）。 */
function emit(threadId, providerTurnId, n) {
  const base = { threadId, turnId: providerTurnId };
  switch (n.kind) {
    case 'turn.started':
      notify('turn/started', { threadId, turn: { id: providerTurnId, status: 'inProgress' } });
      break;
    case 'agentMessage.delta':
      notify('item/agentMessage/delta', { ...base, itemId: n.itemId ?? 'item_1', delta: n.text ?? '' });
      break;
    case 'agentMessage.completed':
      notify('item/completed', { ...base, item: { type: 'agentMessage', id: n.itemId ?? 'item_1', text: n.text ?? '' } });
      break;
    case 'tool.started':
      notify('item/started', {
        ...base,
        item: n.toolType === 'fileChange'
          ? { type: 'fileChange', id: n.itemId ?? 'tool_1', status: 'inProgress', changes: (n.paths ?? ['D:/mock/target.txt']).map((path) => ({ path, kind: 'add', diff: '' })) }
          : { type: n.toolType ?? 'commandExecution', id: n.itemId ?? 'tool_1', command: n.command ?? 'echo', status: 'inProgress' },
      });
      break;
    case 'tool.completed':
      notify('item/completed', { ...base, item: { type: n.toolType ?? 'commandExecution', id: n.itemId ?? 'tool_1', status: n.status ?? 'completed', command: n.command ?? 'echo' } });
      break;
    case 'usage':
      notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { inputTokens: n.input ?? 10, cachedInputTokens: n.cached ?? 0, outputTokens: n.output ?? 5 }, last: {} } });
      break;
    case 'turn.completed': {
      // finalText 中的 {RESULT_KEY} 占位符替换为从输入提取的 resultKey（结构化终态回显）。
      const finalText = String(n.finalText ?? '').replaceAll('{RESULT_KEY}', currentResultKey ?? 'result_mock_unbound');
      notify('turn/completed', { threadId, turn: { id: providerTurnId, status: n.status ?? 'completed', error: n.error ?? null, items: n.items ?? [{ type: 'agentMessage', id: 'item_final', text: finalText }] } });
      break;
    }
    case 'error':
      notify('error', { ...base, error: { kind: n.code ?? 'MOCK', message: n.message ?? 'mock error' }, willRetry: n.willRetry ?? false });
      break;
    case 'unattributedTerminal': {
      // 未知归属终态：turn.id 与任何已登记 provider turn 无关（真实协议无顶层 turnId）。
      notify('turn/completed', { threadId, turn: { id: n.unknownTurnId ?? 'ghost-turn-999', status: n.status ?? 'failed', error: n.error ?? null, items: [] } });
      break;
    }
    case 'lateMessage': {
      // 迟到事件：携带旧的 provider turnId（由 n.providerTurnId 指定）。
      notify('item/completed', { threadId, turnId: n.providerTurnId, item: { type: 'agentMessage', id: n.itemId ?? 'item_late', text: n.text ?? '' } });
      break;
    }
    case 'approvalRequest': {
      // Server→Client 审批请求：带 id（JSON-RPC 请求）。
      const id = nextId++;
      write({ jsonrpc: '2.0', id, method: n.method ?? 'item/commandExecution/requestApproval', params: { threadId, turnId: providerTurnId, ...(n.params ?? {}) } });
      break;
    }
    default:
      break;
  }
}
