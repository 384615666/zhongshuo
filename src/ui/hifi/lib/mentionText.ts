export type MentionTriggerRange = { index: number; end: number; query: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function codeMaskedText(text: string): string {
  const mask = (value: string) => value.replace(/[^\n]/g, ' ');
  let fence: { char: string; length: number } | null = null;
  // Preserve offsets and newlines. Longer closing fences are legal, shorter ones
  // cannot expose recipients inside a fenced example; unfinished fences stay masked.
  const blocks = text.split(/(?<=\n)/u).map(line => {
    if (fence != null) {
      const close = /^ {0,3}(`+|~+)[ \t]*\r?(?:\n|$)/u.exec(line);
      if (close != null && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      return mask(line);
    }
    if (/^\s*>/u.test(line)) return mask(line);
    const open = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (open != null) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      return mask(line);
    }
    return line;
  }).join('');
  const ticks = /`+/gu;
  let result = '', start = 0;
  for (let open = ticks.exec(blocks); open != null; open = ticks.exec(blocks)) {
    result += blocks.slice(start, open.index);
    let close = ticks.exec(blocks);
    while (close != null && close[0].length !== open[0].length) close = ticks.exec(blocks);
    const end = close == null ? (blocks.indexOf('\n', open.index) < 0 ? blocks.length : blocks.indexOf('\n', open.index)) : ticks.lastIndex;
    result += mask(blocks.slice(open.index, end));
    start = end;
    ticks.lastIndex = end;
  }
  return result + blocks.slice(start);
}

export function toolbarMentionInsertion(text: string): { value: string; index: number; end: number } {
  // First toolbar mention starts the body; once an inline token already exists,
  // another toolbar selection appends rather than replacing that first token.
  const append = text.startsWith('@');
  const separator = append && !/\s$/u.test(text) ? ' ' : '';
  const index = append ? text.length + separator.length : 0;
  if (append) return { value: `${text}${separator}@`, index, end: index + 1 };
  return { value: `${text.slice(0, index)}@${text.slice(index)}`, index, end: index + 1 };
}

export function insideCode(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if ((before.match(/```/g) ?? []).length % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return (line.match(/`/g) ?? []).length % 2 === 1;
}

export function detectMentionRange(text: string, cursor: number): MentionTriggerRange | null {
  const before = text.slice(0, cursor);
  const match = /(^|[\s，。！？、：；])@([^\s@]{0,80})$/u.exec(before);
  const index = match == null ? -1 : before.lastIndexOf('@');
  if (match == null || index < 0 || codeMaskedText(text)[index] !== '@') return null;
  return { index, end: cursor, query: match[2] ?? '' };
}

type MentionMember = { id: string; displayName: string };
export type MemberMentionBindings = { version: 1; tokens: Record<string, string> };
export const emptyMemberMentionBindings = (): MemberMentionBindings => ({ version: 1, tokens: {} });
export type MemberMentionIndex = {
  tokenById: ReadonlyMap<string, string>;
  fallbackById: ReadonlyMap<string, string>;
  aliases: ReadonlyMap<string, string>;
  ambiguous: ReadonlySet<string>;
};

function shortMemberCode(id: string): string {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/** Visible names stay readable. Identity lives only in per-draft bindings, never in the body. */
export function buildMemberMentionIndex<T extends MentionMember>(
  members: readonly T[], runtimeLabelOf: (member: T) => string,
): MemberMentionIndex {
  const tokenById = new Map<string, string>(), fallbackById = new Map<string, string>();
  const owners = new Map<string, Set<string>>();
  const addAlias = (alias: string, id: string) => {
    const ids = owners.get(alias) ?? new Set<string>();
    ids.add(id); owners.set(alias, ids);
  };
  for (const member of members) {
    addAlias(member.displayName, member.id);
    addAlias(`${member.displayName}（${runtimeLabelOf(member).replace(/\s+/g, '')}）`, member.id);
  }
  const reserved = new Set(owners.keys());
  // A hash collision (or a real name identical to a generated label) gets a short
  // local suffix. Persisted bindings, rather than this ordering, preserve old selections.
  for (const member of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
    const name = member.displayName.replace(/[\r\n@]/g, ' ').trim() || '成员';
    const qualifier = runtimeLabelOf(member).replace(/\s+/g, '').slice(0, 24);
    const base = `${name}（${qualifier}·#${shortMemberCode(member.id)}`;
    let token = `${base}）`, collision = 1;
    while (reserved.has(token)) token = `${base}-${++collision}）`;
    reserved.add(token); fallbackById.set(member.id, token);
    const canonical = owners.get(member.displayName)!.size === 1 && member.displayName !== '全体' ? member.displayName : token;
    tokenById.set(member.id, canonical);
    addAlias(token, member.id);
  }
  return {
    tokenById, fallbackById,
    aliases: new Map([...owners].filter(([alias, ids]) => ids.size === 1 && alias !== '全体').map(([alias, ids]) => [alias, [...ids][0]!])),
    ambiguous: new Set([...owners].filter(([alias, ids]) => ids.size > 1 && alias !== '全体').map(([alias]) => alias)),
  };
}

/** A newly clicked member must never overwrite another visible token's old binding. */
export function bindMemberMention(index: MemberMentionIndex, id: string, bindings: MemberMentionBindings): { token: string; bindings: MemberMentionBindings } {
  let token = index.tokenById.get(id);
  if (token == null) throw Error('提及成员已不在当前名单，请重新选择');
  if (Object.hasOwn(bindings.tokens, token) && bindings.tokens[token] !== id) token = index.fallbackById.get(id)!;
  const base = token;
  let collision = 1;
  while (Object.hasOwn(bindings.tokens, token) && bindings.tokens[token] !== id) token = `${base}#${++collision}`;
  return { token, bindings: { version: 1, tokens: { ...bindings.tokens, [token]: id } } };
}

export function resolveMemberMentions(text: string, index: MemberMentionIndex, bindings: MemberMentionBindings = emptyMemberMentionBindings()): { ids: string[]; unresolved: string[]; bindings: MemberMentionBindings } {
  const masked = codeMaskedText(text);
  const matches: Array<{ token: string; start: number; end: number }> = [];
  const tokens = new Set([...index.aliases.keys(), ...index.ambiguous, ...Object.keys(bindings.tokens)]);
  for (const token of tokens) {
    const pattern = new RegExp(`(^|[\\s，。！？、：；])@${escapeRegExp(token)}(?=$|[\\s，。！？、：；,.!?;:])`, 'gu');
    for (let match = pattern.exec(masked); match != null; match = pattern.exec(masked)) {
      matches.push({ token, start: match.index + match[1]!.length, end: pattern.lastIndex });
    }
  }
  matches.sort((a, b) => a.start - b.start || Number(Object.hasOwn(bindings.tokens, b.token)) - Number(Object.hasOwn(bindings.tokens, a.token)) || b.end - a.end);
  const found: Array<{ id: string; start: number }> = [];
  const unresolved: string[] = [];
  // Quoting a previously selected token stops dispatch, while retaining its identity
  // if the user later removes the quote/code delimiters. Deleting its text retires it.
  const kept: Array<[string, string]> = Object.entries(bindings.tokens).filter(([token]) =>
    new RegExp(`(^|[\\s，。！？、：；])@${escapeRegExp(token)}(?=$|[\\s，。！？、：；,.!?;:])`, 'u').test(text));
  let end = -1;
  for (const match of matches) {
    if (match.start < end) continue;
    end = match.end;
    const bound = Object.hasOwn(bindings.tokens, match.token) ? bindings.tokens[match.token] : undefined;
    const id = bound ?? index.aliases.get(match.token);
    if (id != null) kept.push([match.token, id]);
    if (id != null && index.tokenById.has(id)) found.push({ id, start: match.start });
    else unresolved.push(`@${match.token}`);
  }
  // Keep broadcast recognition unchanged; this helper only binds member identities.
  const all = /(^|[\s，。！？、：；])@全体(?=$|[\s，。！？、：；,.!?;:])/u.exec(masked);
  if (all != null) found.push({ id: 'all', start: all.index + all[1]!.length });
  const nextTokens = Object.fromEntries(kept);
  const unchanged = Object.keys(bindings.tokens).length === Object.keys(nextTokens).length
    && Object.entries(nextTokens).every(([token, id]) => bindings.tokens[token] === id);
  return { ids: [...new Set(found.sort((a, b) => a.start - b.start).map(item => item.id))], unresolved,
    bindings: unchanged ? bindings : { version: 1, tokens: nextTokens } };
}

/** Only exact visible member tokens at real word boundaries participate. Fenced/inline code
 * is masked, and email-like prefixes do not qualify because '@' must start or follow punctuation. */
export function resolveMentionIds(text: string, tokenToId: ReadonlyMap<string, string>): string[] {
  const masked = codeMaskedText(text);
  const found: Array<{ id: string; index: number }> = [];
  if (/(^|[\s，。！？、：；])@全体(?=$|[\s，。！？、：；,.!?;:])/u.test(masked)) found.push({ id: 'all', index: masked.indexOf('@全体') });
  for (const [token, id] of tokenToId) {
    const pattern = new RegExp(`(^|[\\s，。！？、：；])@${escapeRegExp(token)}(?=$|[\\s，。！？、：；,.!?;:])`, 'u');
    const match = pattern.exec(masked);
    if (match != null) found.push({ id, index: match.index + match[1]!.length });
  }
  return [...new Map(found.sort((a, b) => a.index - b.index).map((item) => [item.id, item])).keys()];
}
