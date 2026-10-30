import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css']
  .map((file) => readFileSync(new URL(`../../src/ui/hifi/styles/${file}`, import.meta.url), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`));
  return match?.[1] ?? '';
}

describe('R129 soft interaction colors', () => {
  it('keeps the real room and composer controls on the audited classes', () => {
    const room = readFileSync(new URL('../../src/ui/hifi/pages/Room.tsx', import.meta.url), 'utf8');
    const composer = readFileSync(new URL('../../src/ui/hifi/components/Composer.tsx', import.meta.url), 'utf8');

    expect(room).toContain('className="new-msg-pill"');
    expect(room).toContain('有新消息（{pendingNew}）');
    expect(composer).toContain('className="btn primary sm composer-send"');
  });

  it('uses the selected/primary soft family for the new-message pill in both themes', () => {
    const pill = ruleBody('.new-msg-pill');

    expect(pill).toContain('background-color: var(--bg-surface)');
    expect(pill).toContain('background-image: var(--grad-soft)');
    expect(pill).toContain('color: var(--accent-text)');
    expect(pill).toContain('border: 1px solid var(--accent-border)');
    expect(pill).not.toContain('var(--grad)');
    expect(styles).not.toMatch(/:root\[data-theme=['"]dark['"]\]\s+\.new-msg-pill/);
  });

  it('keeps the deep gradient for the non-interactive brand mark only', () => {
    const deepGradientRules: string[] = [];
    for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/background-image:\s*var\(--grad\)\s*;/.test(match[2])) {
        deepGradientRules.push(match[1].trim());
      }
    }

    expect(deepGradientRules).toEqual(['.brand-mark']);
  });

  it('retains warning and danger semantic fills', () => {
    expect(ruleBody('.tag-btn.warning:hover')).toContain('var(--warning-border)');
    expect(ruleBody('.btn.danger')).toContain('background: var(--danger-soft)');
    expect(ruleBody('.btn.danger')).toContain('color: var(--danger)');
  });
});
