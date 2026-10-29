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

  it('survives a path with quotes without breaking the check', () => {
    expect(isProcessRunningFrom("C:\\weird'dir\\x")).toBe(false);
  });
});
