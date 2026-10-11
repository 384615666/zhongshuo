/** User authorized: at most one real startTurn per channel, own synthetic image only. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ClaudeCliAdapter, CLAUDE_ADAPTER_VERSION } from '../src/adapter/claude/cliAdapter.ts';
import { CodexAppServerAdapter } from '../src/adapter/codex/appServerAdapter.ts';
import type { RuntimeAdapter } from '../src/contracts/runtime.ts';

async function main() {
const out = resolve('dist/desktop/r76-vision-cert');
if (existsSync(resolve(out, 'result.json'))) { console.log('已有认证回执：不自动追加调用或重试未知认证。'); return; }
const raw = readFileSync(resolve(out, 'input.png'));
const text = '请只根据这张图片回答：从左至右三个图形的颜色和形状是什么？下面四位数字是什么？不要读取文件或使用工具。只答简短 JSON。';
const facts: unknown[] = [];
for (const [kind, model, adapter] of [
  ['claude', 'deepseek-flash', new ClaudeCliAdapter({ model: 'deepseek-flash', extraArgs: ['--max-turns', '1'] })],
  ['codex', 'gpt-6-luna', new CodexAppServerAdapter({ model: 'gpt-6-luna', sandboxMode: 'read-only', approvalPolicy: 'never' })],
] as Array<[string, string, RuntimeAdapter]>) {
  const entry: Record<string, unknown> = { kind, model, imageHash: createHash('sha256').update(raw).digest('hex'), calls: 0, status: 'unverified', claudeAdapterVersion: CLAUDE_ADAPTER_VERSION };
  let session: Awaited<ReturnType<RuntimeAdapter['openSession']>> | undefined;
  try {
    entry.probe = await adapter.probe();
    session = await adapter.openSession({ projectId: 'r76-cert', memberId: kind, taskId: 'vision', threadId: kind, sessionGeneration: 0, cwd: out, policyId: 'policy-analyze' });
    const responses: string[] = [];
    const collect = (async () => {
      for await (const event of adapter.events(session!)) {
        if (event.kind === 'message.completed') responses.push(event.text);
        if (event.kind === 'usage.updated') entry.usage = { model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cost: event.cost };
        if (event.kind === 'turn.failed') { entry.error = event.message; break; }
        if (event.kind === 'turn.completed') { responses.push(event.finalText ?? ''); break; }
      }
    })();
    entry.calls = 1;
    await adapter.startTurn(session, { turnId: `r76-${kind}`, dispatchKey: `r76-cert-${kind}`, inputBundleId: 'own-generated-image',
      text, policyId: 'policy-analyze', taskRevision: 0,
      images: [{ artifactId: 'own-fixture', mime: 'image/png', hash: entry.imageHash as string, dataBase64: raw.toString('base64') }] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([collect, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('认证 120 秒超时；不自动重试')), 120000); })]).finally(() => clearTimeout(timer));
    entry.response = responses.join('\n');
    entry.status = !entry.error && /5837/.test(entry.response as string) && /红|red/i.test(entry.response as string) && /蓝|blue/i.test(entry.response as string) && /绿|green/i.test(entry.response as string) ? 'supported' : 'unverified';
  } catch (error) { entry.error = (error as Error).message.slice(0, 400); }
  finally {
    if (session != null) await adapter.close(session).catch(() => {});
    if ('dispose' in adapter) await (adapter as CodexAppServerAdapter).dispose().catch(() => {});
    facts.push(entry);
    writeFileSync(resolve(out, 'result.json'), JSON.stringify({ at: new Date().toISOString(), maxCalls: 2, facts }, null, 2));
    console.log(JSON.stringify({ kind, status: entry.status, calls: entry.calls, response: entry.response, error: entry.error }));
  }
}

}
void main();
