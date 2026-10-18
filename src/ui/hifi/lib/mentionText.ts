export type MentionTriggerRange = { index: number; end: number; query: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function codeMaskedText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
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
  if (match == null || index < 0 || insideCode(text, index)) return null;
  return { index, end: cursor, query: match[2] ?? '' };
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
