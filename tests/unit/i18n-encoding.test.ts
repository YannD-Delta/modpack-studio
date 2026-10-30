import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../src/web/i18n');

describe('translation files', () => {
  // The web bundler refuses a JSON file that is not valid UTF-8, and nothing else in the test suite would notice.
  it.each(readdirSync(DIR).filter((f) => f.endsWith('.json')))('%s is valid UTF-8 JSON without replacement characters', (file) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(DIR, file)));
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain('�');
  });
});
