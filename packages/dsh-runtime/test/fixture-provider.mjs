// Test-only deterministic provider: no HTTP, SDK client or real model is used.
// Mounted only by the isolated official-cli test overlay; excluded from tgz.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
export const name = 'zhongshuo-dsh-test-provider';
export const inject = ['llm', 'tools'];
export function apply(ctx) {
  let currentAgent;
  let bodies = 0; let extensionHooks = 0;
  const definition = (name) => ({ name, description: 'Tool denial fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'null' }] },
    async execute() { bodies++; return null; } });
  ctx.on('agent/created', ({ agent }) => {
    currentAgent = agent;
    // Installed AFTER setup: restrict({allow:[]}) cannot hide this own-scope tool.
    agent.ctx.get('tools').register(definition('fixture_scoped'));
  });
  ctx.on('tools/pre-execute', async (_exec, next) => { extensionHooks++; return next(); });
  ctx.on('tools/execute', async (_exec, next) => { extensionHooks++; return next(); });
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, tools: [...assembly.tools, { name: 'fixture_extension', description: 'Extension-added schema', parameters: { type: 'object', properties: {} } }] };
  });
  class Fixture extends LlmAdapter {
    providerInfo() { return { id: 'fixture', name: 'Local fixture (no model)' }; }
    async listModels() { return [{ provider: 'fixture', id: 'scripted', name: 'Scripted fixture' }]; }
    async resolveModel() { return { provider: 'fixture', id: 'scripted', name: 'Scripted fixture', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }; }
    async *stream(options) {
      const prompts = options.messages.filter((message) => message.role === 'user').flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text)).filter((text) => text.startsWith('fixture:'));
      const prompt = prompts.at(-1) ?? '';
      const repairCall = prompt.startsWith('fixture:repair-call:');
      const planning = prompt.startsWith('fixture:planning');
      const planningCall = prompt.startsWith('fixture:planning-call:');
      const schemaCase = prompt.startsWith('fixture:schema\n') || prompt.startsWith('fixture:repair\n') || prompt.startsWith('fixture:planning\n');
      let supplied;
      if (schemaCase || repairCall || planningCall) {
        supplied = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
        const systemText = options.messages.filter((message) => message.role === 'system').flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text)).join('\n');
        if (!systemText.includes(JSON.stringify(supplied.schema))) throw Error('Complete literal outputSchema missing at actual SDK provider boundary');
        if (!systemText.includes('exactly one raw JSON') || !systemText.includes('Never invent completed work')) throw Error('Structured final rules missing');
        if (prompt.startsWith('fixture:repair') || planning) {
          const deniedCode=planning?'PLANNING_TOOL_DENIED':'FORMAT_REPAIR_TOOL_DENIED';
          if (planning) {
            if (!systemText.includes('COORDINATION PLANNING ONLY') || !systemText.includes('coordinationPlan/handoffs first') || !systemText.includes('your own implementation as a child step') || systemText.includes('FORMAT-ONLY REPAIR')) throw Error('Planning instructions missing or mislabeled repair');
          } else if (!systemText.includes('FORMAT-ONLY REPAIR') || !systemText.includes('收到')) throw Error('Format-only rules missing');
          if (options.tools?.length) throw Error('Repair model received tools, including scoped or extension tools');
          if (prompts.length !== 1) throw Error('Repair inherited work history');
          const agent = currentAgent;
          const tools = agent.ctx.get('tools');
          tools.register(definition('fixture_late'));
          // Own scoped tools remain in the registry: prove the guard, not only
          // filtering or absence, prevents them from executing.
          if (!tools.get('fixture_scoped', agent) || !tools.get('fixture_late', agent)) throw Error('Scoped fixture tools missing');
          const names = ['fixture_echo', 'fixture_scoped', 'fixture_late', 'run_code', 'fixture_extension', 'stale_known_tool'];
          for (const name of names) {
            const exec = { name, arguments: {}, agent, callId: `denied-${name}`, signal: options.signal };
            const result = await tools.execute(exec);
            if (!result.isError || result.error.info?.code !== deniedCode) throw Error(`Tool not explicitly denied: ${name}`);
            // Exercise the actual scoped dispatch waterfall directly, including
            // stale names and run_code, without relying on registry lookup.
            const dispatch = await ctx.waterfall(scopeTarget(ctx.get('tools'), agent), 'tools/execute', exec, async () => { bodies++; throw Error('Dispatch reached fallback'); });
            if (!dispatch.isError || dispatch.error.info?.code !== deniedCode) throw Error(`Dispatch interceptor lost: ${name}`);
          }
          if (bodies !== 0 || extensionHooks !== 0) throw Error('Repair reached a tool body or execution extension hook');
          // A later extension can skip the pre-execute waterfall. The official
          // monotonic guard must STILL deny the newly registered scoped tool.
          agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), true);
          const guarded = await tools.execute({ name: 'fixture_late', arguments: {}, agent, callId: 'guard-only', signal: options.signal });
          if (!guarded.isError || !guarded.error.message.includes(planning?'disabled during coordination planning':'disabled during format-only repair') || bodies || extensionHooks) throw Error('Monotonic scoped guard failed');
        }
      }
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
      if ((prompt === 'fixture:tool' || repairCall || planningCall) && !toolDone) {
        const name = repairCall || planningCall ? prompt.slice((planningCall?'fixture:planning-call:':'fixture:repair-call:').length).split('\n')[0] : 'fixture_echo';
        const block = { type: 'tool-call', id: 'fixture-tool-1', name, arguments: name === 'fixture_echo' ? '{"value":"hello"}' : '{}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const system = options.messages.filter((message) => message.role === 'system').map((message) => JSON.stringify(message.content)).join('');
      if (!prompt.startsWith('fixture:repair') && !planning && !system.includes('fixture-instruction={{literal}}')) throw Error('Developer instruction was lost or interpolated');
      const text = schemaCase ? JSON.stringify(supplied.value) : `fixture response prompts=${prompts.length} effort=${options.reasoningEffort ?? 'default'}`;
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
    async execute(args) { bodies++; return args; } });
}
