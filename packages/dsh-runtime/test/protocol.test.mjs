import test from 'node:test';
import { Buffer } from 'node:buffer';
import { setImmediate, setTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { RuntimeProtocol, RuntimeError, createWriter, bindInput, splitModelSelection } from '../protocol.mjs';

test('model selection retains nested provider and model ids',()=>{
  const providers=[{id:'gateway'},{id:'gateway/team'},{id:'other'}];
  assert.deepEqual(splitModelSelection('gateway/team/model/v1',providers),{provider:'gateway/team',model:'model/v1'});
  assert.throws(()=>splitModelSelection('unknown/model',providers),{code:'INVALID_MODEL'});
  assert.throws(()=>splitModelSelection('gateway/team/',providers),{code:'INVALID_MODEL'});
});

const command = (overrides = {}) => ({ v: 1, type: 'execute', requestId: 'one', cwd: '/fixture', prompt: 'hello', mode: 'full', ...overrides });
function fixture(overrides = {}) {
  const records = []; const calls = [];
  const handle = { sessionId: 'actual-session', run: async () => ({ reason: 'completed', text: 'ok' }), cancel: () => calls.push('cancel'), flush: async () => calls.push('flush'), dispose: async () => calls.push('dispose'), ...overrides };
  const backend = { prepare: async () => { calls.push('prepare'); return handle; } };
  const protocol = new RuntimeProtocol(backend, async (record) => { calls.push(record.type); records.push(record); });
  return { records, calls, handle, backend, protocol };
}
test('completed follows the official flush and dispose barriers', async () => {
  const f = fixture(); await f.protocol.receive(command());
  assert.deepEqual(f.calls, ['prepare', 'session', 'flush', 'dispose', 'result']);
  assert.equal(f.records.at(-1).status, 'completed');
});
test('readonly and malformed mode are rejected before creating an agent', async () => {
  for (const mode of ['readonly', 'other']) { const f = fixture(); await f.protocol.receive(command({ mode })); assert.ok(!f.calls.includes('prepare')); assert.equal(f.records[0].status, 'failed'); }
});
test('max-tokens and missing terminals never complete', async () => {
  for (const reason of ['max-tokens', undefined, 'blocked', 'error']) { const f = fixture({ run: async () => ({ reason }) }); await f.protocol.receive(command()); assert.equal(f.records.at(-1).status, 'failed'); }
});
test('resume id mismatch fails without running', async () => {
  let ran = false; const f = fixture({ run: async () => { ran = true; } });
  await f.protocol.receive(command({ sessionId: 'wanted' })); assert.equal(ran, false); assert.equal(f.records.at(-1).error.code, 'SESSION_ID_MISMATCH');
});
test('cancel during creation remains armed even before the handle is available', async () => {
  const f = fixture(); let release; let ran = false;
  f.handle.run = async () => { ran = true; }; f.backend.prepare = () => new Promise((resolve) => { release = resolve; });
  const task = f.protocol.receive(command()); await f.protocol.receive({ v: 1, type: 'cancel', requestId: 'one' });
  release(f.handle); await task; assert.equal(ran, false); assert.equal(f.records.at(-1).status, 'cancelled'); assert.ok(f.calls.includes('cancel'));
});
test('cancel before execute acknowledges the unopened request and prevents delayed startup', async () => {
  const f = fixture(); await f.protocol.receive({ v: 1, type: 'cancel', requestId: 'one' }); await f.protocol.receive(command());
  assert.deepEqual(f.calls, ['result']); assert.equal(f.records.length, 1); assert.equal(f.records[0].status, 'cancelled'); assert.equal(f.records[0].sessionId, '');
});
test('cancel reaches the official live handle and unrelated ids cannot cancel it', async () => {
  const f = fixture(); let release; f.handle.run = () => new Promise((resolve) => { release = resolve; });
  const task = f.protocol.receive(command()); await new Promise(setImmediate);
  await f.protocol.receive({ v: 1, type: 'cancel', requestId: 'other' }); assert.ok(!f.calls.includes('cancel'));
  await f.protocol.receive({ v: 1, type: 'cancel', requestId: 'one' }); release({ reason: 'aborted' }); await task; assert.equal(f.records.at(-1).status, 'cancelled');
});
test('close cancels an unpublished creation through AbortSignal', async () => {
  const f = fixture(); f.backend.prepare = (_command, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const task = f.protocol.receive(command()); await f.protocol.close(); await task; assert.equal(f.records.at(-1).status, 'cancelled');
});
test('flush or cleanup failure overrides completed', async () => {
  for (const key of ['flush', 'dispose']) { const f = fixture({ [key]: async () => { throw Error('failure'); } }); await f.protocol.receive(command()); assert.equal(f.records.at(-1).status, 'failed'); }
});
test('foreign provider errors cannot expose secrets, while own errors remain actionable', async () => {
  const f = fixture({ run: async () => { throw Error('api-key=DO-NOT-EXPOSE'); } }); await f.protocol.receive(command()); assert.ok(!JSON.stringify(f.records).includes('DO-NOT-EXPOSE'));
  const g = fixture(); g.backend.prepare = async () => { throw new RuntimeError('MISSING_SESSION', 'No existing session.'); }; await g.protocol.receive(command()); assert.equal(g.records.at(-1).error.code, 'MISSING_SESSION');
});
test('parallel request is refused and duplicate IDs never produce extra terminals', async () => {
  const f = fixture(); let release; f.handle.run = () => new Promise((resolve) => { release = resolve; });
  const task = f.protocol.receive(command()); await new Promise(setImmediate);
  await f.protocol.receive(command()); await f.protocol.receive(command({ requestId: 'two' }));
  release({ reason: 'completed' }); await task;
  assert.equal(f.records.filter((r) => r.type === 'result' && r.requestId === 'one').length, 1);
  assert.equal(f.records.find((r) => r.requestId === 'two').error.code, 'BUSY');
});
test('JSONL input accepts CRLF, split UTF-8 and literal Unicode separators', async () => {
  const input = new PassThrough(); const frames = []; let error;
  const done = new Promise((resolve) => bindInput(input, { receive: async (frame) => frames.push(frame) }, resolve, (value) => { error = value; resolve(); }));
  const data = Buffer.from(`${JSON.stringify(command({ prompt: '中文\u2028分隔\u2029' }))}\r\n`);
  input.write(data.subarray(0, data.length - 12)); input.end(data.subarray(data.length - 12)); await done;
  assert.equal(error, undefined); assert.equal(frames.length, 1); assert.equal(frames[0].prompt, '中文\u2028分隔\u2029');
});
test('writer preserves JSONL order and awaits delayed output callbacks', async () => {
  const chunks = []; const output = new Writable({ write(chunk, _encoding, callback) { setTimeout(() => { chunks.push(chunk.toString()); callback(); }, 5); } });
  const writer = createWriter(output); writer.send({ n: 1 }); writer.send({ n: 2 }); await writer.flush(); assert.equal(chunks.join(''), '{"n":1}\n{"n":2}\n');
});
