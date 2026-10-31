import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { RuntimeError, splitModelSelection } from './protocol.mjs';

const samePath = (a, b) => process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
const checkAbort = (signal) => { signal.throwIfAborted(); };
const required = (ctx, name) => { const service = ctx.get(name); if (!service) throw new RuntimeError('MISSING_SERVICE', `Required Harness service is missing: ${name}`); return service; };

export function createBackend(ctx) {
  return {
    async models() {
      const llm = required(ctx, 'llm');
      const models = [];
      for (const provider of llm.listProviders()) {
        for (const model of await llm.listModels(provider.id)) {
          const resolved = await llm.resolveModelInfo(provider.id, model.id);
          models.push({ id: `${provider.id}/${model.id}`, label: model.name || model.id,
            ...(resolved.reasoning?.efforts ? { efforts: resolved.reasoning.efforts.map((effort) => effort.id) } : {}) });
        }
      }
      return models;
    },
    async prepare(command, signal, emit) {
      if (!isAbsolute(command.cwd)) throw new RuntimeError('INVALID_CWD', 'cwd must be an absolute existing directory.');
      const cwd = await realpath(command.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new RuntimeError('INVALID_CWD', 'cwd must be a directory.');
      checkAbort(signal);
      const agents = required(ctx, 'agents');
      const sessions = required(ctx, 'sessions');
      required(ctx, 'sessionPersistence');
      const selection = { ...required(ctx, 'agentDefaultModel').currentSelection() };
      if (command.model !== undefined) {
        Object.assign(selection,splitModelSelection(command.model,required(ctx,'llm').listProviders()));
        delete selection.reasoningEffort;
      }
      if (command.effort !== undefined) selection.reasoningEffort = ReasoningEffortId(command.effort==='none'?'off':command.effort);
      await required(ctx, 'llm').resolveCallConfig(selection, signal);
      checkAbort(signal);
      const sessionId = command.sessionId ?? `session-${randomUUID()}`;
      const setup = async (agentCtx, agent) => {
        checkAbort(signal);
        if (String(agent.session.id) !== sessionId) throw new RuntimeError('SESSION_ID_MISMATCH', 'Harness returned a different session.');
        const origin = agent.session.header.cwd;
        if (typeof origin !== 'string' || !samePath(await realpath(origin), cwd)) throw new RuntimeError('SESSION_CWD_MISMATCH', 'The session belongs to another working directory.');
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
        if (command.developerInstructions) agentCtx.get('systemPrompt').section({ name: 'zhongshuo-developer-instructions', order: 10000, text: command.developerInstructions, interpolate: false });
      };
      // resume() strictly loads an existing log. Never fall back to create().
      const handle = command.sessionId === undefined
        ? await agents.create({ sessionId, meta: { cwd }, agentOptions: selection, setup, signal })
        : await agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup, signal });
      const agent = handle.agent;
      const disposers = [];
      let disposed = false;
      let reason; let failure; let text = '';
      const cancel = () => { if (!disposed) agent.cancel({ kind: 'user' }); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const stop = async () => {
        if (disposed) return;
        signal.removeEventListener('abort', cancel);
        const errors = [];
        try { await ctx.get('subagents')?.drainDescendants([agent]); } catch (error) { errors.push(error); }
        try { if (!await sessions.flush(agent.session)) throw new Error('No durability listener participated'); } catch (error) { errors.push(error); }
        for (const dispose of disposers) dispose();
        try { await handle.dispose(); } catch (error) { errors.push(error); }
        disposed = true;
        if (errors.length) throw new AggregateError(errors, 'Harness cleanup failed');
      };
      disposers.push(ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) failure = error; }));
      disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject !== agent || frame.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          emit({ kind: chunk.type === 'text-delta' ? 'text' : 'thinking', text: chunk.text });
        }
      }));
      disposers.push(ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        const data = event.data;
        if (event.type === 'turn/end') { reason = data.reason; failure = undefined; }
        if (event.type === 'assistant/message') {
          text = data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
          if (data.usage) emit({ kind: 'usage', inputTokens: data.usage.inputTokens,
            cachedTokens: data.usage.cacheReadTokens, outputTokens: data.usage.outputTokens,
            model: `${selection.provider}/${selection.model}` });
        }
        if (event.type === 'tool/call') {
          let input; try { input = JSON.parse(data.arguments); } catch { input = data.arguments; }
          emit({ kind: 'tool-start', id: String(data.callId), name: data.name, input });
        }
        if (event.type === 'tool/result') emit({ kind: 'tool-end', id: String(data.message.toolCallId), isError: data.message.isError === true, output: data.message.content });
      }));
      return {
        sessionId: String(agent.session.id), cancel, dispose: stop,
        async flush() { if (!await sessions.flush(agent.session)) throw new Error('No durability listener participated'); },
        async run() {
          checkAbort(signal);
          let content = [{ type: 'text', text: command.prompt }];
          if (command.images?.length) {
            const encoded = command.images.map((image) => {
              const mediaType = image.mediaType ?? image.mimeType;
              if (typeof image.data !== 'string' || typeof mediaType !== 'string') throw new RuntimeError('INVALID_IMAGE', 'Images require base64 data and mediaType or mimeType.');
              return { data: image.data, mediaType };
            });
            const refs = await admitEncodedImages(required(ctx, 'attachments'), encoded);
            content = [...content, ...refs.map((attachment) => ({ type: 'image', attachment }))];
          }
          checkAbort(signal);
          agent.followup(createUserMessage({ content, source: { kind: 'user' } }));
          while (true) {
            await agent.whenIdle();
            const seq = agent.session.seq;
            if (!await ctx.get('subagents')?.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) break;
          }
          if (failure) throw failure;
          return { reason: reason?.kind, text, code: reason?.kind === 'error' ? reason.error.code : undefined };
        },
      };
    },
  };
}
