// Local JSON-RPC adversary. No account, external executable or network API.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [configPath, logPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const contexts = new Map(), waiting = new Map();
let threadCount = 0, offset = 0;
const log = row => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...row }) + '\n');
const send = frame => { log({ type: 'out', frame }); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); };
const expand = value => {
  if (Array.isArray(value)) return value.map(expand);
  if (value != null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\$(THREAD|TURN)\{([^}]+)\}/g, (_, field, key) => contexts.get(key)[field]);
};
const controls = () => {
  if (!existsSync(config.controlPath)) return;
  const lines = readFileSync(config.controlPath, 'utf8').split('\n').slice(0, -1);
  for (const line of lines.slice(offset)) {
    const control = JSON.parse(line);
    for (const frame of control.frames ?? []) send(expand(frame));
    log({ type: 'control.applied', sequence: ++offset });
  }
};
setInterval(controls, 10);
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); log({ type: 'in', frame });
  if (frame.method == null) {
    const release = waiting.get(frame.id);
    if (release != null) { waiting.delete(frame.id); release(); }
    return;
  }
  const reply = result => send({ id: frame.id, result });
  switch (frame.method) {
    case 'initialize': reply({}); break;
    case 'model/list': controls(); reply({ data: [], nextCursor: null }); break;
    case 'thread/start': reply({ thread: { id: `r126-thread-${++threadCount}` } }); break;
    case 'thread/resume': reply({ thread: { id: frame.params.threadId } }); break;
    case 'turn/start': {
      const key = frame.params.clientUserMessageId, script = config.turns[key] ?? {};
      const context = { THREAD: frame.params.threadId, TURN: script.providerTurnId ?? `provider-${key}` };
      contexts.set(key, context); log({ type: 'turn.registered', key, context });
      const respond = () => reply({ turn: { id: script.responseTurnId ?? context.TURN, status: 'inProgress', items: [] } });
      if (script.waitApproval != null) waiting.set(script.waitApproval, respond);
      if (!script.omitStarted) send({ method: 'turn/started', params: { threadId: context.THREAD, turn: { id: context.TURN, status: 'inProgress' } } });
      if (script.waitApproval != null) send({ id: script.waitApproval, method: 'item/commandExecution/requestApproval', params: { threadId: context.THREAD, turnId: context.TURN, command: 'echo LOCAL_ONLY' } });
      if (script.errorBeforeResponse) send({ method: 'error', params: { threadId: context.THREAD, turnId: context.TURN, willRetry: false, error: { kind: 'SyntheticEarlyError', message: 'synthetic failure before response' } } });
      else if (script.waitApproval == null) respond();
      break;
    }
    default: if (frame.id != null) reply({});
  }
});
