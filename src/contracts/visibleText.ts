/** Only used to decide emptiness. Preserve ZWJ/variation selectors in real emoji. */
export function hasVisibleText(value:string):boolean {
  // eslint-disable-next-line no-misleading-character-class -- intentionally matching invisible/control code points
  return value.replace(/[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]/gu,'').length>0;
}
