import { describe, expect, it } from 'vitest';
import { bindMemberMention, buildMemberMentionIndex, detectMentionRange, emptyMemberMentionBindings, resolveMemberMentions } from '../../src/ui/hifi/lib/mentionText.ts';

const members = ['m1', 'm2', 'm3'].map(id => ({ id, displayName: '同名', runtime: 'codex · fixture' }));
const indexOf = (roster = members) => buildMemberMentionIndex(roster, m => m.runtime);

describe('R134 member identity in mention text', () => {
  it('makes every same-name/channel/model token short and unique, including the third', () => {
    const index = indexOf();
    expect(new Set(index.tokenById.values()).size).toBe(3);
    for (const token of index.tokenById.values()) { expect(token).toMatch(/^同名（codex·fixture·#[a-z0-9]{6}）$/); expect(token).not.toContain('成员:'); }
    for (const member of members) {
      expect(resolveMemberMentions(`@${index.tokenById.get(member.id)} 请回复`, index).ids).toEqual([member.id]);
    }
  });

  it('preserves selection through rename, model change, reordered roster and a third duplicate', () => {
    const original = indexOf([members[0]!]);
    const text = `@${original.tokenById.get('m1')}`;
    const renamed = indexOf([...members].reverse().map(m => m.id === 'm1' ? { ...m, displayName: '新名字', runtime: 'claude · new-model' } : m));
    const selected = bindMemberMention(original, 'm1', emptyMemberMentionBindings());
    expect(original.tokenById.get('m1')).toBe('同名');
    expect(resolveMemberMentions(text, renamed, selected.bindings).ids).toEqual(['m1']);
  });

  it('deduplicates and keeps textual ordering when stable and legacy tokens mix', () => {
    const index = indexOf([...members, { id: 'u', displayName: '唯一', runtime: 'x' }]);
    expect(resolveMemberMentions(`@${index.tokenById.get('m3')} @唯一 @${index.tokenById.get('m1')} @${index.tokenById.get('m3')}`, index).ids).toEqual(['m3', 'u', 'm1']);
  });

  it('keeps ordinary unique legacy names and unique old runtime qualifiers compatible', () => {
    const index = indexOf([{ id: 'u', displayName: '唯一', runtime: 'codex · fixture' }, { ...members[0]!, runtime: 'claude · other' }, members[1]!]);
    expect(resolveMemberMentions('@唯一 @同名（codex·fixture）', index).ids).toEqual(['u', 'm2']);
    expect(resolveMemberMentions('@同名', index).unresolved).toEqual(['@同名']);
  });

  it('rejects ambiguous plain and runtime-qualified legacy text without trusting a last map entry', () => {
    expect(resolveMemberMentions('@同名 @同名（codex·fixture）', indexOf()).unresolved).toEqual(['@同名', '@同名（codex·fixture）']);
  });

  it('rejects a removed bound member rather than resolving its visible name to another member', () => {
    const original = indexOf();
    const text = `@${original.tokenById.get('m1')}`;
    const selected = bindMemberMention(original, 'm1', emptyMemberMentionBindings());
    expect(resolveMemberMentions(text, indexOf(members.slice(1)), selected.bindings).unresolved).toEqual([text]);
  });

  it('never exposes IDs, even reserved characters and Unicode, in readable tokens', () => {
    const roster = ['x/〕 %', 'x%2F', '成员😺'].map(id => ({ id, displayName: '同名', runtime: 'x' }));
    const index = indexOf(roster);
    for (const m of roster) {
      const selected = bindMemberMention(index, m.id, emptyMemberMentionBindings());
      expect(selected.token).not.toContain(m.id);
      expect(resolveMemberMentions(`@${selected.token}`, index, selected.bindings).ids).toEqual([m.id]);
    }
  });

  it.each([
    (token: string) => `\`@${token}\``,
    (token: string) => `\`\`code @${token} with \` tick\`\``,
    (token: string) => `\`\`\`ts\n@${token}\n\`\`\``,
    (token: string) => `~~~ts\n@${token}\n~~~`,
    (token: string) => `\`\`\`ts\n@${token}`,
    (token: string) => `\`\`\` @${token}`,
    (token: string) => `\`unfinished @${token}`,
    (token: string) => `\`\`\`\`ts\n\`\`\`\n@${token}\n\`\`\`\``,
    (token: string) => `> @${token}\n\n引用`,
    (token: string) => `email@${token}`,
  ])('does not resolve identity or ambiguity inside code, quotations or emails (%#)', wrap => {
    const index = indexOf();
    for (const token of [index.tokenById.get('m1')!, '同名', '同名（codex·fixture）']) {
      expect(resolveMemberMentions(wrap(token), index).ids).toEqual([]);
      expect(resolveMemberMentions(wrap(token), index).unresolved).toEqual([]);
    }
  });

  it('does not open mention candidates inside quoted text or tilde code', () => {
    expect(detectMentionRange('> @同', 4)).toBeNull();
    const text = '~~~ts\n@同';
    expect(detectMentionRange(text, text.length)).toBeNull();
    const afterCode = '``literal ` tick`` @同';
    expect(detectMentionRange(afterCode, afterCode.length)?.query).toBe('同');
  });

  it('does not turn a member named 全体 into broadcast when selected explicitly', () => {
    const index = indexOf([{ id: 'u', displayName: '全体', runtime: 'x' }]);
    expect(resolveMemberMentions(`@${index.tokenById.get('u')}`, index).ids).toEqual(['u']);
  });

  it('keeps an already unique plain name bound after a duplicate arrives and an old name is reassigned', () => {
    const original = indexOf([members[0]!]);
    const parsed = resolveMemberMentions('@同名 请回答', original);
    expect(parsed.bindings.tokens).toEqual({ 同名: 'm1' });
    const next = indexOf([{ ...members[0]!, displayName: '改名' }, members[1]!, { ...members[2]!, displayName: '同名 请回答' }]);
    expect(resolveMemberMentions('@同名 请回答', next, parsed.bindings).ids).toEqual(['m1']);
  });

  it('does not overwrite a visible old binding when selecting a new owner of that name', () => {
    const old = resolveMemberMentions('@同名', indexOf([members[0]!]));
    const next = indexOf([{ ...members[0]!, displayName: '改名' }, members[1]!]);
    const picked = bindMemberMention(next, 'm2', old.bindings);
    expect(picked.token).not.toBe('同名');
    expect(resolveMemberMentions(`@同名 @${picked.token}`, next, picked.bindings).ids).toEqual(['m1', 'm2']);
  });

  it('retires deleted token bindings and keeps quoted selections inactive without losing identity', () => {
    const bound = resolveMemberMentions('@同名', indexOf([members[0]!]));
    const quoted = resolveMemberMentions('> @同名', indexOf(), bound.bindings);
    expect(quoted.ids).toEqual([]);
    expect(quoted.bindings).toEqual(bound.bindings);
    expect(resolveMemberMentions('已经删掉', indexOf(), bound.bindings).bindings.tokens).toEqual({});
  });
});
