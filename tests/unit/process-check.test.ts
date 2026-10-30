import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessRunningFrom } from '../../src/server/profiles/process-check.js';

describe('isProcessRunningFrom', () => {
  it('is true for a directory a running process was started from (this test run)', () => {
    expect(isProcessRunningFrom(process.cwd())).toBe(true);
  });

  it('is false for a directory nothing runs from', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-process-here-'));
    expect(isProcessRunningFrom(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a path with an ASCII apostrophe without breaking the check', () => {
    expect(isProcessRunningFrom("C:/weird'dir/x")).toBe(false);
  });

  describe('treats the location as data, never as PowerShell code', () => {
    const create = (m: string) => `New-Item -ItemType File -Path ${m} | Out-Null`;
    // Each payload would create the marker file if the location were pasted into the script text.
    const payloads: [string, (m: string) => string][] = [
      ['U+2019 right quote', (m) => `C:/x\u2019; ${create(m)}; \u2019`],
      ['U+2018 left quote', (m) => `C:/x\u2018; ${create(m)}; \u2018`],
      ['U+201A low quote', (m) => `C:/x\u201A; ${create(m)}; \u201A`],
      ['U+201B reversed quote', (m) => `C:/x\u201B; ${create(m)}; \u201B`],
      ['subexpression', (m) => `C:/x$(${create(m)})`],
      ['backtick and semicolon', (m) => `C:/x\`'; ${create(m)}; #`],
      ['double quote', (m) => `C:/x"; ${create(m)}; "`],
      ['accents', () => 'C:/Caf\u00e9 \u00e0 la cr\u00e8me/\u00e9t\u00e9'],
    ];
    for (const [name, make] of payloads) {
      it(`ignores ${name}`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-'));
        const marker = path.join(dir, 'pwned.txt').replace(/\\/g, '/');
        try {
          expect(isProcessRunningFrom(make(marker))).toBe(false);
          expect(fs.existsSync(marker)).toBe(false);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
});
