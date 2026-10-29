// Local JSON-RPC process only. No Codex binary, network, or model calls.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers';

if (process.argv[2] === '--hold-pipes') {
  const timer = setInterval(() => {
    if (existsSync(process.argv[3])) {
      clearInterval(timer);
      process.stdout.write(process.argv[4], () => process.exit(0));
    }
  }, 10);
} else {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const logPath = process.argv[3];
  let threadCount = 0;
  let startCount = 0;
  let latestExpand = frames => frames ?? [];
  const pending = [];
  const write = frames => process.stdout.write(frames.map(f => JSON.stringify({ jsonrpc: '2.0', ...f }) + '\n').join(''));
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    appendFileSync(logPath, JSON.stringify(msg) + '\n');
    if (msg.id == null || msg.method == null) return;
    const reply = result => write([{ id: msg.id, result }]);
    switch (msg.method) {
      case 'initialize': reply({}); break;
      case 'model/list': {
        const respond = () => {
          reply({ data: [], nextCursor: null });
          write(latestExpand(config.modelNotifications));
        };
        if (config.holdModelList) {
          const timer = setInterval(() => {
            if (existsSync(config.modelReleasePath)) { clearInterval(timer); respond(); }
          }, 10);
        } else respond();
        break;
      }
      case 'thread/start': reply({ thread: { id: `r123-thread-${++threadCount}` } }); break;
      case 'thread/resume': reply({ thread: { id: msg.params.threadId } }); break;
      case 'turn/start': {
        const script = config.turns[msg.params.clientUserMessageId];
        const turnId = script.providerTurnId ?? 'reused-provider-turn';
        const expand = frames => JSON.parse(JSON.stringify(frames ?? [])
          .replaceAll('$THREAD', msg.params.threadId).replaceAll('$TURN', turnId));
        latestExpand = expand;
        write(expand(script.before));
        pending.push(() => {
          // Response and following notifications deliberately share one pipe write.
          write([{ id: msg.id, result: { turn: { id: turnId } } }, ...expand(script.after)]);
          if (script.exitWithOpenPipes) {
            // The real server exits, but an inherited stdout/stderr keeps its close
            // event pending until the test has opened sessions in the next process.
            const late = expand(script.lateBeforeClose).map(f => JSON.stringify({ jsonrpc: '2.0', ...f }) + '\n').join('');
            spawn(process.execPath, [import.meta.filename, '--hold-pipes', config.releasePath, late], {
              stdio: ['ignore', process.stdout, process.stderr], windowsHide: true,
            }).unref();
            setImmediate(() => process.exit(7));
          } else if (script.exitCode != null) setImmediate(() => process.exit(script.exitCode));
        });
        if (++startCount >= (config.startBarrier ?? 1)) {
          for (const respond of pending.splice(0).reverse()) respond();
        }
        break;
      }
      default: reply({});
    }
  });
}
