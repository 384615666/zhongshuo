import { describe, expect, it } from 'vitest';
import { detectMentionRange, resolveMentionIds, toolbarMentionInsertion } from '../../src/ui/hifi/lib/mentionText.ts';

const tokens = new Map([
  ['Claude', 'm_claude'],
  ['Codex', 'm_codex'],
  ['GLM', 'm_glm'],
  ['DeepSeek', 'm_deepseek'],
  ['同名（codex·gpt）', 'm_duplicate'],
]);

describe('R89 inline mention text', () => {
  it('keeps multiple exact member tokens, deduplicates, and follows deletion order', () => {
    expect(resolveMentionIds('@Claude @Codex 请分别回答', tokens)).toEqual(['m_claude', 'm_codex']);
    expect(resolveMentionIds('@Codex @Claude @Codex', tokens)).toEqual(['m_codex', 'm_claude']);
    expect(resolveMentionIds('@Codex 只剩一个', tokens)).toEqual(['m_codex']);
    expect(resolveMentionIds('@同名（codex·gpt） 请回答', tokens)).toEqual(['m_duplicate']);
  });

  it('does not treat email, fenced code or inline code as member recipients', () => {
    expect(resolveMentionIds('mail: user@Claude', tokens)).toEqual([]);
    expect(resolveMentionIds('example `@Claude` and `@Codex`', tokens)).toEqual([]);
    expect(resolveMentionIds('```\n@Claude @Codex\n```', tokens)).toEqual([]);
    expect(resolveMentionIds('普通 @ 文本', tokens)).toEqual([]);
    expect(resolveMentionIds('> @GLM 上次的原话\n\n这是引用，请说明内容。', tokens)).toEqual([]);
    expect(resolveMentionIds('> @全体 上次的原话\n\n这是引用。', tokens)).toEqual([]);
    expect(resolveMentionIds('@DeepSeek 请解释\n\n> @GLM 历史引用', tokens)).toEqual(['m_deepseek']);
  });

  it('tracks the exact @ range for direct typing and toolbar insertion', () => {
    expect(detectMentionRange('@Cod', 4)).toEqual({ index: 0, end: 4, query: 'Cod' });
    expect(detectMentionRange('正文 @Cl', 6)).toEqual({ index: 3, end: 6, query: 'Cl' });
    expect(detectMentionRange('user@Cod', 8)).toBeNull();
    expect(detectMentionRange('`@Cod`', 6)).toBeNull();
  });

  it('toolbar insertion starts the first token and appends later tokens without replacement', () => {
    expect(toolbarMentionInsertion('')).toMatchObject({ value: '@', index: 0, end: 1 });
    expect(toolbarMentionInsertion('请回答').value).toBe('@请回答');
    expect(toolbarMentionInsertion('@GLM 请回答')).toMatchObject({ value: '@GLM 请回答 @', index: 9, end: 10 });
    expect(toolbarMentionInsertion('@GLM 请回答 ')).toMatchObject({ value: '@GLM 请回答 @', index: 9, end: 10 });
  });
});
