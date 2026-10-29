import { afterEach, describe, expect, it } from 'vitest';
import { getPackNames, setPackNames, t, tf } from '../../src/web/i18n/index.js';

afterEach(() => setPackNames({ upstream: 'ATM10', own: 'LMP' }));

describe('pack names in the interface', () => {
  it('shows ATM10 and LMP until Settings says otherwise', () => {
    expect(t('oldpack.title')).toBe('Ancien pack contre ATM10');
    expect(getPackNames()).toEqual({ upstream: 'ATM10', own: 'LMP' });
  });

  it('fills the names chosen in Settings into every text, with or without other variables', () => {
    setPackNames({ upstream: 'All the Mods', own: 'MonPack' });
    expect(t('oldpack.title')).toBe('Ancien pack contre All the Mods');
    expect(t('oldpack.intro')).toContain('ton ancien MonPack avec All the Mods');
    expect(tf('decisions.atmDerived', { n: '7' })).toBe('7 mods exclus automatiquement depuis All the Mods (gérés sur la page Liste noire)');
  });

  it('leaves no placeholder behind in any French text', async () => {
    const files = await Promise.all([import('../../src/web/i18n/fr.json'), import('../../src/web/i18n/fr.decisions.json'), import('../../src/web/i18n/fr.assistant.json'), import('../../src/web/i18n/fr.configs.json')]);
    setPackNames({ upstream: 'AAA', own: 'BBB' });
    const text = files.flatMap((f) => Object.values(f.default as Record<string, string>)).join('\n');
    expect(text).not.toMatch(/ATM10|\bLMP\b/); // nothing is hardcoded: the names come from Settings
  });
});
