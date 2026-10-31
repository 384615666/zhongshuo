// Test-only deterministic provider: no HTTP, SDK client or real model is used.
// Mounted only by the isolated official-cli test overlay; excluded from tgz.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'zhongshuo-dsh-test-provider';
export const inject = ['llm', 'tools'];
export function apply(ctx) {
  class Fixture extends LlmAdapter {
    providerInfo() { return { id: 'fixture', name: 'Local fixture (no model)' }; }
    async listModels() { return [{ provider: 'fixture', id: 'scripted', name: 'Scripted fixture' }]; }
    async resolveModel() { return { provider: 'fixture', id: 'scripted', name: 'Scripted fixture', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }; }
    async *stream(options) {
      const prompts = options.messages.filter((message) => message.role === 'user').flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text)).filter((text) => text.startsWith('fixture:'));
      const prompt = prompts.at(-1) ?? '';
      if (prompt === 'fixture:wait') {
        await new Promise((resolve) => {
          if (options.signal.aborted) return resolve();
          options.signal.addEventListener('abort', resolve, { once: true });
        });
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Fixture cancelled' } } }; return;
      }
      if (prompt === 'fixture:error') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_FAILURE', message: 'test-secret-must-not-leak' } } }; return; }
      const lastUser = options.messages.findLastIndex((message) => message.role === 'user');
      const toolDone = options.messages.slice(lastUser + 1).some((message) => message.role === 'tool');
      if (prompt === 'fixture:tool' && !toolDone) {
        const block = { type: 'tool-call', id: 'fixture-tool-1', name: 'fixture_echo', arguments: '{"value":"hello"}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const system = options.messages.filter((message) => message.role === 'system').map((message) => JSON.stringify(message.content)).join('');
      if (!system.includes('fixture-instruction={{literal}}')) throw Error('Developer instruction was lost or interpolated');
      const text = `fixture response prompts=${prompts.length} effort=${options.reasoningEffort ?? 'default'}`;
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: 'scripted reasoning' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'scripted reasoning' } };
      yield { type: 'block-start', index: 1, blockType: 'text' };
      yield { type: 'text-delta', index: 1, text };
      yield { type: 'block-end', index: 1, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 12, cacheReadTokens: 4, outputTokens: 6 } };
      yield { type: 'finish', reason: { kind: prompt === 'fixture:max' ? 'max-tokens' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fixture());
  ctx.tools.register({ name: 'fixture_echo', description: 'Deterministic local test tool', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    output: { schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return args; } });
}
