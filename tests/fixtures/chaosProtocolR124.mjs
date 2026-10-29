// R124 synthetic JSON-RPC server. Only stdio/files and this same local script
// are used; there is no Codex executable, account, HTTP client, or model SDK.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

{
  const configPath = process.argv[2], logPath = process.argv[3];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const contexts = new Map();
  const log = event => appendFileSync(logPath, JSON.stringify({ pid: process.pid, role: 'server', at: Date.now(), ...event }) + '\n');
  const write = frames => {
    for (const frame of frames) log({ type: 'out', frame });
    process.stdout.write(frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n').join(''));
  };
  const expand = (value, current) => {
    if (Array.isArray(value)) return value.map(item => expand(item, current));
    if (value != null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, current)]));
    if (typeof value !== 'string') return value;
    return value.replace(/\$(THREAD|TURN|RESPONSE|FINAL)(?:\{([^}]+)\})?/g, (_, field, key) => {
      const context = key == null ? current : contexts.get(key);
      if (context == null) throw Error(`Missing fixture context: ${key}`);
      return context[field];
    });
  };
  let threadCount = 0;
  // Commands already consumed by a dead server are not commands for its successor.
  let controlOffset = existsSync(config.controlPath) ? readFileSync(config.controlPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  log({ type: 'server.ready', configPath, localOnly: true });
  setInterval(() => {
    if (!existsSync(config.controlPath)) return;
    const lines = readFileSync(config.controlPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(controlOffset)) {
      const control = JSON.parse(line);
      write(expand(control.frames ?? [], null));
      log({ type: 'control.applied', sequence: ++controlOffset });
      if (control.exitCode != null) {
        log({ type: 'server.exiting', exitCode: control.exitCode });
        setTimeout(() => process.exit(control.exitCode), 10);
      }
    }
  }, 10);
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    log({ type: 'in', frame: msg });
    if (msg.id == null || msg.method == null) return;
    const reply = result => write([{ id: msg.id, result }]);
    switch (msg.method) {
      case 'initialize': reply({}); break;
      case 'model/list': reply({ data: [], nextCursor: null }); break;
      case 'thread/start': reply({ thread: { id: `r124-thread-${++threadCount}` } }); break;
      case 'thread/resume': reply({ thread: { id: msg.params.threadId } }); break;
      case 'turn/start': {
        const text = msg.params.input.map(item => item.text ?? '').join('\n');
        const keys = Object.keys(config.turns);
        const key = keys.find(candidate => candidate === msg.params.clientUserMessageId)
          ?? keys.filter(candidate => candidate.startsWith('TOKEN_')).sort((a, b) => b.length - a.length).find(candidate => text.includes(candidate));
        if (key == null) throw Error('No synthetic turn script matches this local request');
        const script = config.turns[key];
        const resultKey = msg.params.outputSchema?.properties?.resultKey?.const ?? /resultKey=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? 'raw-protocol';
        const final = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, answer: `SAFE_${key}`, responseKind: 'conversation', changeSummary: '', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] });
        const context = { THREAD: msg.params.threadId, TURN: script.providerTurnId ?? `provider-${key}`, RESPONSE: script.responseTurnId ?? script.providerTurnId ?? `provider-${key}`, FINAL: final };
        contexts.set(key, context);
        log({ type: 'turn.registered', key, context, requestId: msg.id });
        write(expand(script.before ?? [], context));
        if (!script.noResponse) write([
          script.responseError != null ? { id: msg.id, error: script.responseError } : { id: msg.id, result: { turn: { id: context.RESPONSE, status: 'inProgress', items: [] } } },
          ...expand(script.after ?? [], context),
        ]);
        if (script.exitAfterStart != null) {
          log({ type: 'server.exiting', exitCode: script.exitAfterStart });
          setTimeout(() => process.exit(script.exitAfterStart), 10);
        }
        break;
      }
      default: reply({});
    }
  });
}
