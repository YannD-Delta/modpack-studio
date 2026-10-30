import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPackNames, setPackNames, t, tf, type MessageKey } from '../../src/web/i18n/index.js';

afterEach(() => setPackNames({ upstream: 'Base', own: 'Own' }));

const I18N_DIR = join(__dirname, '../../src/web/i18n');
/** Every French message file, found by glob so a new work stream file is scanned without editing this test. */
const files = readdirSync(I18N_DIR).filter((f) => /^fr.*\.json$/.test(f));
const messages = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(join(I18N_DIR, f), 'utf8')))) as Record<string, string>;
// Real pack names that must never be hardcoded in a UI string (written in pieces so this file stays free of them).
const REAL = [['A', 'TM10'], ['A', 'TM'], ['L', 'MP'], ['All the ', 'Mods']].map((p) => p.join(''));
const REAL_RE = new RegExp(`(^|[^A-Za-z0-9])(${REAL.join('|')})([^A-Za-z0-9]|$)`);

describe('pack names in the interface', () => {
  it('shows Base and Own until Settings says otherwise', () => {
    expect(t('oldpack.title')).toBe('Ancien pack contre Base');
    expect(getPackNames()).toEqual({ upstream: 'Base', own: 'Own' });
  });

  it('fills the names chosen in Settings into every text, with or without other variables', () => {
    setPackNames({ upstream: 'Alpha Pack', own: 'MonPack' });
    expect(t('oldpack.title')).toBe('Ancien pack contre Alpha Pack');
    expect(t('oldpack.intro')).toContain('ton ancien MonPack avec Alpha Pack');
    expect(tf('decisions.atmDerived', { n: '7' })).toBe('7 mods exclus automatiquement depuis Alpha Pack (gérés sur la page Liste noire)');
  });

  it('scans all French message files', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(messages).length).toBeGreaterThan(100);
  });

  it('hardcodes no real pack name or default name in any French text', () => {
    for (const [key, text] of Object.entries(messages)) {
      expect(text, key).not.toMatch(REAL_RE);
      expect(text, key).not.toMatch(/\bBase\b/);
    }
  });

  it('renders every text with the chosen names and leaves no placeholder behind', () => {
    setPackNames({ upstream: 'AAA', own: 'BBB' });
    for (const key of Object.keys(messages)) {
      const text = t(key as MessageKey);
      expect(text, key).not.toMatch(/\{(upstream|own)\}/);
    }
    expect(t('blacklist.originUpstream')).toBe('AAA');
  });
});
