import { describe, expect, it } from 'vitest';
import { detectMentionRange, resolveMentionIds } from '../../src/ui/hifi/lib/mentionText.ts';

const tokens = new Map([
  ['Claude', 'm_claude'],
  ['Codex', 'm_codex'],
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
  });

  it('tracks the exact @ range for direct typing and toolbar insertion', () => {
    expect(detectMentionRange('@Cod', 4)).toEqual({ index: 0, end: 4, query: 'Cod' });
    expect(detectMentionRange('正文 @Cl', 6)).toEqual({ index: 3, end: 6, query: 'Cl' });
    expect(detectMentionRange('user@Cod', 8)).toBeNull();
    expect(detectMentionRange('`@Cod`', 6)).toBeNull();
  });
});
