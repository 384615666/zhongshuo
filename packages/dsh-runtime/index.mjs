import { createBackend } from './backend.mjs';
import process from 'node:process';
import { bindInput, createWriter, identity, RuntimeProtocol, RUNTIME } from './protocol.mjs';

export const name = 'zhongshuo-dsh-runtime';
export const inject = ['cmdlineArgs', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'sessions', 'sessionPersistence', 'llm', 'agentDefaultModel', 'appExit', 'appReady'];

export function apply(ctx) {
  if (ctx.get('profileContext')?.name !== 'zhongshuo') throw new Error('Zhongshuo runtime requires --profile zhongshuo.');
  const args = ctx.cmdlineArgs.get();
  if (args.length !== 1 || !['--zs-stdio', '--zs-probe', '--zs-models'].includes(args[0])) throw new Error('Use exactly one of --zs-stdio, --zs-probe, --zs-models.');
  const writer = createWriter(process.stdout);
  const backend = createBackend(ctx);
  const protocol = new RuntimeProtocol(backend, writer.send);
  let unbind;
  let closing;
  const close = (code = 0) => closing ??= (async () => {
    unbind?.();
    try { await protocol.close(); await writer.flush(); }
    catch { code = 1; }
    ctx.appExit(code);
  })();
  const error = () => { process.stderr.write('Zhongshuo DSH transport failed.\n'); void close(1); };
  // Do not announce ready, consume stdin, or exit successfully before the entire
  // official composition has committed startup. Boot failures remain failures.
  const cancelReady = ctx.appReady.onReady(() => {
    void (async () => {
      if (args[0] === '--zs-probe') { await writer.send(identity('probe')); await close(); }
      else if (args[0] === '--zs-models') { await writer.send({ v: 1, type: 'models', runtime: RUNTIME, models: await backend.models() }); await close(); }
      else {
        await writer.send(identity('ready'));
        unbind = bindInput(process.stdin, protocol, () => void close(), error);
        if (process.stdin.readableEnded) await close();
      }
    })().catch(error);
  });
  ctx.on('dispose', async () => { cancelReady(); unbind?.(); await protocol.close(); await writer.flush(); });
}
