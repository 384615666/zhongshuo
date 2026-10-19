/**
 * R91 module-1（Composer 光标/选区/IME）定向测试。
 *
 * 1) 纯函数单测：组合输入结束时的「DOM 文本 + 草稿 token」权威合并规则
 *    （文本=DOM、token 集合/顺序=草稿；新增不丢、移除不复活、按相邻 token 锚定位置）。
 * 2) 真实 Chromium 挂载断言：本仓库 vitest 只有 node 环境（无 jsdom/happy-dom），
 *    因此用已安装的 Electron 隐藏窗口（show:false，无可见 GUI、不占鼠标键盘剪贴板）
 *    + esbuild 绑定**实际 React Composer**，驱动真实 selection/composition/DOM 事件；
 *    覆盖用户报告的 5s 轮询场景。脚本本身由本测试通过原生动态 import 调用。
 *
 * 说明：tsconfig.hifi 的 `types: []` 不引入 @types/node，所以这里不静态 import node
 * 内置模块；脚本路径用 import.meta.url，加载用运行时动态 import（脚本自身是 CJS，
 * 只对外导出 runVerifier，避免在测试进程里额外引入 Node 类型）。
 */
import { describe, expect, it } from 'vitest';
import { mergeCompositionEditorBody } from '../../src/ui/hifi/components/Composer.tsx';
import { inlineAttachmentToken, parseInlineBody } from '../../src/ui/hifi/data/store.ts';

type Check = { name: string; ok: boolean; detail?: unknown };
type VerifierResult = { ok: boolean; checks: Check[]; facts?: Record<string, unknown> };
type VerifierModule = { default?: { runVerifier?: () => Promise<VerifierResult> } };

function attachmentIds(body: string): string[] {
  return parseInlineBody(body)
    .filter((segment) => segment.kind === 'attachment')
    .map((segment) => segment.token.attachmentId ?? segment.token.uploadId ?? '');
}

function visibleText(body: string): string {
  return parseInlineBody(body).map((segment) => segment.kind === 'text' ? segment.text : '').join('');
}

const uploadToken = inlineAttachmentToken({ kind: 'upload', uploadId: 'upl_r91_1', name: '报告.txt' });
const readyToken = inlineAttachmentToken({
  kind: 'file', attachmentId: 'att_r91_1', uploadId: 'upl_r91_1', name: '报告.txt', fileKind: 'text_file', revision: 2,
});

describe('R91 composer composition merge authority', () => {
  it('采用 DOM 组合文本，同时把 DOM 里过期的 upload token 换成草稿最新 file token', () => {
    const dom = `前文 ${uploadToken} 后文拼音`;
    const stored = `前文 ${readyToken} 后文`;
    const merged = mergeCompositionEditorBody(dom, stored);
    expect(merged).toBe(`前文 ${readyToken} 后文拼音`);
    expect(visibleText(merged)).toBe('前文  后文拼音');
  });

  it('草稿里已移除的 token 不会被 DOM 复活，用户组合文本保留', () => {
    const merged = mergeCompositionEditorBody(`甲 ${uploadToken} 乙拼`, '甲 乙');
    expect(attachmentIds(merged)).toEqual([]);
    expect(visibleText(merged)).toContain('甲');
    expect(visibleText(merged)).toContain('乙拼');
  });

  it('组合期间草稿新增的 token 不丢：按相邻 token 锚定，无锚时追加到正文末尾', () => {
    const first = inlineAttachmentToken({ kind: 'file', attachmentId: 'att_first', uploadId: 'upl_first', name: '一.txt', fileKind: 'text_file', revision: 1 });
    const second = inlineAttachmentToken({ kind: 'file', attachmentId: 'att_second', uploadId: 'upl_second', name: '二.txt', fileKind: 'text_file', revision: 1 });
    // DOM 里只有第二个 token；第一个是组合期间草稿新增的——按草稿顺序插到第二个之前。
    const anchored = mergeCompositionEditorBody(`A B ${second}`, `A ${first} B ${second} B`);
    expect(attachmentIds(anchored)).toEqual(['att_first', 'att_second']);
    // 没有任何锚点时按 hydrate 既有口径追加；DOM 里的组合文本不被草稿覆盖。
    const appended = mergeCompositionEditorBody('内容拼', `内容 ${second}`);
    expect(attachmentIds(appended)).toEqual(['att_second']);
    expect(visibleText(appended)).toContain('内容拼');
  });

  it('无 token 的普通正文原样返回 DOM 文本（快路径不引入格式变化）', () => {
    expect(mergeCompositionEditorBody('中文组合输入', '较早的草稿')).toBe('中文组合输入');
  });
});

describe('R91 composer caret/selection/IME (actual React mount in hidden Chromium)', () => {
  it('keeps DOM/caret/selection/scroll/@candidates/IME stable across same-target polling and receipts', async () => {
    const scriptUrl = new URL('../../scripts/verify-r91-composer-caret.cjs', import.meta.url).href;
    const module = await import(scriptUrl) as unknown as VerifierModule;
    const runVerifier = module.default?.runVerifier;
    expect(typeof runVerifier, 'verifier must export runVerifier').toBe('function');
    const result = await runVerifier!();
    const failures = (result.checks ?? []).filter((check) => !check.ok);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(80);
    const names = new Set(result.checks.map((check) => check.name));
    for (const required of [
      'poll_text_node_identity_kept',
      'poll_no_editor_dom_mutation',
      'poll_caret_and_direction_unchanged',
      'poll_backward_selection_preserved',
      'poll_mention_popup_still_open',
      'poll_mention_candidates_follow_roster',
      'composition_poll_no_dom_rebuild',
      'composition_upload_no_dom_rebuild_during_ime',
      'token_authority_flush_drops_removed_token',
      'token_authority_flush_renders_new_token',
      'token_length_caret_inside_text_after_token_stable',
      'token_length_backward_selection_stable',
      'late_hydrate_no_dom_rebuild_during_composition',
      'switch_restores_target_draft',
      'late_receipt_other_draft_dom_clean',
    ]) {
      expect(names.has(required), `missing check: ${required}`).toBe(true);
    }
  }, 260_000);
});
