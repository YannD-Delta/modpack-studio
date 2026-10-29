import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diffInventories, type InventoryFiles } from '../../src/server/configs/diff.js';
import { buildHunks, diffLines, splitLines } from '../../src/server/configs/line-diff.js';
import { normalizeForCompare, parseTolerantJson } from '../../src/server/configs/normalize.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('normalizeForCompare', () => {
  const same = (p: string, a: string, b: string) => normalizeForCompare(p, Buffer.from(a)) === normalizeForCompare(p, Buffer.from(b));

  it('ignores BOM, CRLF and trailing whitespace for text', () => {
    expect(same('kubejs/a.js', '﻿a();  \r\nb();\r\n', 'a();\nb();')).toBe(true);
    expect(same('kubejs/a.js', 'a();\nb();', 'a();\nc();')).toBe(false);
  });

  it('compares JSON canonically (key order, spacing, comments, trailing commas)', () => {
    expect(same('config/a.json', '{"b":1,"a":[1,2]}', '{\n  "a": [1, 2],\n  "b": 1\n}\n')).toBe(true);
    expect(same('config/a.json5', '{ // c\n "a": 1, /* x */ "b": [1,2,],\n}', '{"b":[1,2],"a":1}')).toBe(true);
    expect(same('config/a.json', '{"a":[1,2]}', '{"a":[2,1]}')).toBe(false);
    expect(same('data/pack.mcmeta', '{"pack":{"pack_format":48,"description":"x"}}', '{"pack":{"description":"x","pack_format":48}}')).toBe(true);
  });

  it('falls back to text for broken JSON', () => {
    expect(same('config/a.json', '{broken', '{broken  ')).toBe(true);
    expect(same('config/a.json', '{broken', '{other')).toBe(false);
  });

  it('ignores TOML comments, blank lines, indentation and spacing around =', () => {
    const a = '# Server settings\n[general]\n\t#Enable it\n\tenabled = true\n\n\tname = "a # not a comment"\n';
    const b = '[general]\nenabled=true # inline\nname = "a # not a comment"\n';
    expect(same('config/x.toml', a, b)).toBe(true);
    expect(same('config/x.toml', a, b.replace('true', 'false'))).toBe(false);
    expect(same('config/x.toml', 'name = "a # b"\n', 'name = "a"\n')).toBe(false);
  });

  it('parses tolerant JSON with comment markers inside strings', () => {
    expect(parseTolerantJson('{"url":"http://x/*y*/", // c\n}')).toEqual({ url: 'http://x/*y*/' });
  });
});

const e = (content: string, kind: 'text' | 'binary' = 'text', tooLarge = false) => ({ size: content.length, sha256: sha(content), kind, ...(tooLarge ? { tooLarge: true as const } : {}) });

describe('diffInventories', () => {
  const contents: Record<string, Record<string, string>> = {
    base: { 'config/a.json': '{"a":1,"b":2}', 'config/m.toml': 'x = 1\n', 'config/crlf.txt': 'a\r\nb\r\n' },
    other: { 'config/a.json': '{"b":2,"a":1}', 'config/m.toml': 'x = 2\n', 'config/crlf.txt': 'a\nb\n' },
  };
  const base: InventoryFiles = {
    'config/same.toml': e('s'),
    'config/a.json': e(contents.base!['config/a.json']!),
    'config/m.toml': e(contents.base!['config/m.toml']!),
    'config/crlf.txt': e(contents.base!['config/crlf.txt']!),
    'config/onlyBase.toml': e('ob'),
    'kubejs/assets/i.png': e('png1', 'binary'),
    'config/huge.dat': e('h1', 'binary', true),
    'config/Case.toml': e('c'),
  };
  const other: InventoryFiles = {
    'config/same.toml': e('s'),
    'config/a.json': e(contents.other!['config/a.json']!),
    'config/m.toml': e(contents.other!['config/m.toml']!),
    'config/crlf.txt': e(contents.other!['config/crlf.txt']!),
    'kubejs/new.js': e('n'),
    'kubejs/assets/i.png': e('png2', 'binary'),
    'config/huge.dat': e('h2', 'binary', true),
    'config/case.toml': e('c'),
  };
  const load = async (side: 'base' | 'other', p: string) => Buffer.from(contents[side]![p]!);

  it('classifies every file and sorts by severity then path', async () => {
    const d = await diffInventories(base, other, { load });
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({
      'config/same.toml': 'identical',
      'config/a.json': 'cosmetic',
      'config/m.toml': 'modified',
      'config/crlf.txt': 'cosmetic',
      'config/onlyBase.toml': 'onlyInBase',
      'kubejs/new.js': 'onlyInOther',
      'kubejs/assets/i.png': 'binaryDiffers',
      'config/huge.dat': 'tooLarge',
      'config/Case.toml': 'identical',
    });
    expect(d.files.map((f) => f.status)).toEqual(['onlyInBase', 'modified', 'binaryDiffers', 'tooLarge', 'onlyInOther', 'cosmetic', 'cosmetic', 'identical', 'identical']);
    expect(d.summary.perStatus).toMatchObject({ identical: 2, cosmetic: 2, modified: 1, onlyInBase: 1, onlyInOther: 1, binaryDiffers: 1, tooLarge: 1 });
    expect(d.summary.perRoot.kubejs).toMatchObject({ onlyInOther: 1, binaryDiffers: 1 });
    const ob = d.files.find((f) => f.path === 'config/onlyBase.toml')!;
    expect(ob).toMatchObject({ root: 'config', kind: 'text', baseSize: 2, otherSize: null });
  });

  it('without a loader every differing text file is modified', async () => {
    const d = await diffInventories(base, other, {});
    expect(d.files.find((f) => f.path === 'config/a.json')!.status).toBe('modified');
  });

  it('treats an unreadable side as modified and caps the file list', async () => {
    const d = await diffInventories(base, other, { load: async () => { throw new Error('gone'); }, maxFiles: 3 });
    expect(d.files).toHaveLength(3);
    expect(d.truncated).toBe(true);
    expect(d.total).toBe(9);
  });
});

describe('diffLines', () => {
  const apply = (ops: ReturnType<typeof diffLines>['ops']) => ({
    a: ops.filter((o) => o.type !== 'add').map((o) => o.text),
    b: ops.filter((o) => o.type !== 'del').map((o) => o.text),
  });

  it('produces a minimal edit script that rebuilds both sides', () => {
    const a = ['a', 'b', 'c', 'a', 'b', 'b', 'a'];
    const b = ['c', 'b', 'a', 'b', 'a', 'c'];
    const { ops, coarse } = diffLines(a, b);
    expect(coarse).toBe(false);
    expect(apply(ops)).toEqual({ a, b });
    expect(ops.filter((o) => o.type !== 'equal')).toHaveLength(5); // the classic Myers example: D = 5
  });

  it('numbers lines on each side', () => {
    const { ops } = diffLines(['x', 'y', 'z'], ['x', 'Y', 'z', 'w']);
    expect(ops).toEqual([
      { type: 'equal', text: 'x', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'y', oldNo: 2, newNo: null },
      { type: 'add', text: 'Y', oldNo: null, newNo: 2 },
      { type: 'equal', text: 'z', oldNo: 3, newNo: 3 },
      { type: 'add', text: 'w', oldNo: null, newNo: 4 },
    ]);
  });

  it('rebuilds both sides on random inputs, with an edit count no larger than an LCS bound', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const lcs = (a: string[], b: string[]) => {
      const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
      return t[a.length]![b.length]!;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(rnd() * 15) }, () => 'abcd'[Math.floor(rnd() * 4)]!);
      const b = Array.from({ length: Math.floor(rnd() * 15) }, () => 'abcd'[Math.floor(rnd() * 4)]!);
      const { ops } = diffLines(a, b);
      expect(apply(ops)).toEqual({ a, b });
      expect(ops.filter((o) => o.type !== 'equal').length).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });

  it('handles empty sides and identical inputs', () => {
    expect(diffLines([], ['a', 'b']).ops.map((o) => o.type)).toEqual(['add', 'add']);
    expect(diffLines(['a'], []).ops.map((o) => o.type)).toEqual(['del']);
    expect(diffLines(['a', 'b'], ['a', 'b']).ops.every((o) => o.type === 'equal')).toBe(true);
  });

  it('falls back to a coarse replace when the edit distance exceeds the budget', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const r = diffLines(['same', ...a, 'end'], ['same', ...b, 'end'], { maxEdit: 10 });
    expect(r.coarse).toBe(true);
    expect(apply(r.ops)).toEqual({ a: ['same', ...a, 'end'], b: ['same', ...b, 'end'] });
  });

  it('splits text into lines (CRLF, BOM, final newline)', () => {
    expect(splitLines('﻿a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('groups changes into hunks with context', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const b = [...a];
    b[2] = 'X';
    b[15] = 'Y';
    const { ops } = diffLines(a, b);
    const hunks = buildHunks(ops, 3);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, from: 0 });
    expect(hunks[1]).toMatchObject({ oldStart: 13, oldLines: 7, newStart: 13, newLines: 7 });
  });
});
