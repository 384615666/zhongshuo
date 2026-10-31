import { Buffer } from 'node:buffer';
const { AbortController } = globalThis;
export const PLUGIN_VERSION = '0.1.0';
export const DSH_VERSION = '0.2.1-rc.5';
export const RUNTIME = 'zhongshuo-dsh';
export const capabilities = Object.freeze({ sessionResume: true, sessionCancel: true, structuredEvents: true, readOnly: false });
export const identity = (type) => ({ v: 1, type, runtime: RUNTIME, protocol: 1, pluginVersion: PLUGIN_VERSION, capabilities });

export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const fail = (code, message) => { throw new RuntimeError(code, message); };
function validate(command) {
  if (command.mode === 'readonly') fail('READ_ONLY_UNSUPPORTED', 'This runtime cannot enforce read-only execution.');
  if (command.mode !== 'full') fail('INVALID_REQUEST', 'mode must be full or readonly.');
  if (typeof command.cwd !== 'string' || !command.cwd || typeof command.prompt !== 'string' || !command.prompt.trim()) fail('INVALID_REQUEST', 'cwd and a nonempty prompt are required.');
  for (const key of ['sessionId', 'model', 'effort']) {
    if (command[key] !== undefined && (typeof command[key] !== 'string' || !command[key].trim())) fail('INVALID_REQUEST', `${key} must be a nonempty string.`);
  }
  if (command.developerInstructions !== undefined && typeof command.developerInstructions !== 'string') fail('INVALID_REQUEST', 'developerInstructions must be a string.');
  if (command.images !== undefined && !Array.isArray(command.images)) fail('INVALID_REQUEST', 'images must be an array.');
}

// One process owns one live request. Reserve synchronously, before any await, so
// cancellation received during filesystem/model/session setup cannot be lost.
export class RuntimeProtocol {
  constructor(backend, send) { this.backend = backend; this.send = send; this.seen = new Set(); this.active = undefined; this.closed = false; }
  receive(command) {
    if (!command || command.v !== 1 || typeof command.requestId !== 'string' || !command.requestId || !['execute', 'cancel'].includes(command.type)) {
      return this.failure(command?.requestId ?? '', '', new RuntimeError('INVALID_FRAME', 'Expected a JSONL v1 execute or cancel record.'));
    }
    if (command.type === 'cancel') {
      const active = this.active;
      if (active?.command.requestId === command.requestId) {
        active.controller.abort();
        active.handle?.cancel();
      }
      // A host can cancel while waiting for ready and send no execute at all.
      // Acknowledge that unopened request and tombstone its id, so a later
      // buffered execute cannot start work after cancellation.
      if (!active && !this.seen.has(command.requestId)) {
        this.seen.add(command.requestId);
        return this.send({ v: 1, type: 'result', requestId: command.requestId, sessionId: '', status: 'cancelled', stopReason: 'aborted' });
      }
      return Promise.resolve();
    }
    if (this.closed) return this.failure(command.requestId, '', new RuntimeError('CLOSED', 'Runtime is closing.'));
    // Duplicate ids cannot produce a second terminal for an existing request.
    if (this.seen.has(command.requestId)) return Promise.resolve();
    this.seen.add(command.requestId);
    if (this.active) return this.failure(command.requestId, '', new RuntimeError('BUSY', 'Runtime already owns an active request.'));
    const active = { command, controller: new AbortController(), handle: undefined, task: undefined };
    this.active = active;
    active.task = this.execute(active);
    return active.task;
  }
  async failure(requestId, sessionId, error) {
    await this.send({ v: 1, type: 'result', requestId, sessionId, status: 'failed', error: publicError(error) });
  }
  async execute(active) {
    const { command, controller } = active;
    let sessionId = '';
    let result;
    try {
      validate(command);
      active.handle = await this.backend.prepare(command, controller.signal, (event) => {
        // Late notifications cannot leak into the next request.
        if (this.active === active) return this.send({ v: 1, type: 'event', requestId: command.requestId, event });
      });
      sessionId = active.handle.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || (command.sessionId !== undefined && sessionId !== command.sessionId)) fail('SESSION_ID_MISMATCH', 'Harness did not return the exact requested session.');
      await this.send({ v: 1, type: 'session', requestId: command.requestId, sessionId, resumed: command.sessionId !== undefined });
      if (controller.signal.aborted) active.handle.cancel();
      const outcome = controller.signal.aborted ? { reason: 'aborted' } : await active.handle.run();
      await active.handle.flush();
      const cancelled = controller.signal.aborted || outcome.reason === 'aborted';
      result = { v: 1, type: 'result', requestId: command.requestId, sessionId,
        status: cancelled ? 'cancelled' : outcome.reason === 'completed' ? 'completed' : 'failed',
        ...(outcome.text === undefined ? {} : { text: outcome.text }), stopReason: outcome.reason ?? 'missing-terminal' };
      if (result.status === 'failed') result.error = { code: outcome.code ?? (outcome.reason === 'max-tokens' ? 'MAX_TOKENS' : 'RUN_FAILED'), message: 'DeepSeek Harness did not complete the turn.' };
    } catch (error) {
      result = { v: 1, type: 'result', requestId: command.requestId, sessionId,
        status: controller.signal.aborted && error?.name === 'AbortError' ? 'cancelled' : 'failed',
        ...(controller.signal.aborted && error?.name === 'AbortError' ? { stopReason: 'aborted' } : { error: publicError(error) }) };
    } finally {
      try { await active.handle?.dispose(); }
      catch { result = { v: 1, type: 'result', requestId: command.requestId, sessionId, status: 'failed', error: { code: 'DISPOSE_FAILED', message: 'Harness cleanup or persistence did not finish.' } }; }
      try { await this.send(result); }
      finally { if (this.active === active) this.active = undefined; }
    }
  }
  async close() {
    this.closed = true;
    const active = this.active;
    if (active) { active.controller.abort(); active.handle?.cancel(); await active.task; }
  }
}

function publicError(error) {
  // Provider exceptions can contain headers, URLs or credentials. Only our own
  // validated diagnostics cross the transport; never serialize foreign causes.
  return error instanceof RuntimeError ? { code: error.code, message: error.message }
    : { code: 'HARNESS_ERROR', message: 'DeepSeek Harness setup, execution or persistence failed.' };
}

export function createWriter(output) {
  let pending = Promise.resolve();
  const send = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    pending = pending.then(() => new Promise((resolve, reject) => {
      output.write(line, (error) => error ? reject(error) : resolve());
    }));
    // Event listeners cannot await writes. Preserve the rejected tail for flush
    // while marking the promise observed until the driver reaches its barrier.
    pending.catch(() => {});
    return pending;
  };
  return { send, flush: () => pending };
}

export function bindInput(input, protocol, onEnd, onError) {
  let buffer = '';
  input.setEncoding('utf8');
  const data = (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { onError(new Error('Frame too large')); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { Promise.resolve(protocol.receive(JSON.parse(line))).catch(onError); } catch (error) { onError(error); }
    }
  };
  const end = () => { if (buffer.trim()) onError(new Error('Unterminated JSONL frame')); else onEnd(); };
  input.on('data', data); input.on('end', end); input.on('error', onError);
  return () => { input.off('data', data); input.off('end', end); input.off('error', onError); };
}
