import { describe, expect, it } from 'vitest';
import { parseKeys, type KeyFormat } from '../../src/server/configs/keys.js';
import { renderMerged, threeWayMerge } from '../../src/server/configs/merge.js';

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('threeWayMerge', () => {
  it('decides each key', () => {
    const r = threeWayMerge(m({ a: '1', b: '1', c: '1', d: '1', e: '1' }), m({ a: '1', b: '2', c: '1', d: '2', f: 'n' }), m({ a: '1', b: '1', c: '9', d: '3', e: '1' }));
    const by = Object.fromEntries(r.decisions.map((d) => [d.key, d.decision]));
    expect(by).toEqual({ a: 'equal', b: 'base', c: 'mine', d: 'conflict', e: 'base', f: 'base' });
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual([{ key: 'd', reason: 'both-changed' }]);
    expect(r.merged.get('c')).toBe('9');
    expect(r.merged.get('b')).toBe('2');
    // The new base removed "e" and mine left it untouched: the removal wins.
    expect(r.merged.has('e')).toBe(false);
  });

  it('is equal when both sides made the same change', () => {
    const r = threeWayMerge(m({ a: '1' }), m({ a: '2' }), m({ a: '2' }));
    expect(r.decisions[0]!.decision).toBe('equal');
    expect(r.clean).toBe(true);
  });
});

describe('renderMerged', () => {
  const run = (format: KeyFormat, then: string, now: string, mine: string) => {
    const k = (t: string) => {
      const p = parseKeys(t, format);
      if (!p.ok) throw new Error(p.reason);
      return p.keys;
    };
    const result = threeWayMerge(k(then), k(now), k(mine));
    return { result, out: renderMerged(format, now, mine, result) };
  };

  it('edits the new base minimally in TOML and keeps its comments', () => {
    const then = '# header\n[a]\nx = 1\ny = 2 # note\n';
    const now = '# header v2\n[a]\nx = 1\ny = 5 # note\nz = [1, 2]\n';
    const mine = '# header\n[a]\nx = 7\ny = 2 # note\n';
    const { out } = run('toml', then, now, mine);
    expect(out.text).toBe('# header v2\n[a]\nx = 7\ny = 5 # note\nz = [1, 2]\n');
    expect(out.clean).toBe(true);
  });

  it('adds keys of mine in the right TOML table and a missing table', () => {
    const then = 'top = 1\n[a]\nx = 1\n';
    const now = 'top = 1\n[a]\nx = 1\n[b]\nq = 1\n';
    const mine = 'top = 1\nmore = 2\n[a]\nx = 1\ny = 3\n[c]\nw = 4\n';
    const { out } = run('toml', then, now, mine);
    const p = parseKeys(out.text, 'toml');
    expect(p.ok && Object.fromEntries(p.keys)).toEqual({ top: '1', more: '2', 'a.x': '1', 'a.y': '3', 'b.q': '1', 'c.w': '4' });
    expect(out.clean).toBe(true);
    expect(out.text.indexOf('more')).toBeLessThan(out.text.indexOf('[a]'));
  });

  it('removes a key that mine removed, in properties', () => {
    const { out } = run('properties', 'a=1\nb=2\n', 'a=1\nb=2\nc=3\n', 'a=1\n');
    // b: removed by mine (mine wins); c: added by the new base, mine never had it (new base wins).
    expect(out.text).toBe('a=1\nc=3\n');
    expect(out.clean).toBe(true);
  });

  it('keeps the new base value and reports a conflict', () => {
    const { result, out } = run('properties', 'a=1\n', 'a=2\n', 'a=3\n');
    expect(result.clean).toBe(false);
    expect(out.text).toBe('a=2\n');
    expect(out.clean).toBe(false);
  });

  it('replaces values in JSON but reports adds and removals it cannot express', () => {
    const then = '{ "a": 1, "b": 2 }';
    const now = '{\n  // keep\n  "a": 1, "b": 2, "c": 3\n}';
    const mine = '{ "a": 5, "d": 4 }';
    const { out } = run('json', then, now, mine);
    expect(out.text).toContain('"a": 5');
    expect(out.text).toContain('// keep');
    expect(out.conflicts.map((c) => `${c.key}:${c.reason}`).sort()).toEqual(['b:unrenderable', 'd:unrenderable']);
    expect(out.clean).toBe(false);
  });

  it('reports unparsable input as a conflict instead of throwing', () => {
    const r = threeWayMerge(m({}), m({}), m({}));
    const out = renderMerged('toml', 'a = ', 'b = 1', r);
    expect(out.clean).toBe(false);
    expect(out.text).toBe('a = ');
  });
});

// Seeded property test: edits touching different keys never conflict, never lose a key, and the rendered file reads back as expected.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keys are "table|leaf"; the table groups the TOML output. */
type Flat = Map<string, string>;
const TABLES = ['', 'alpha', 'beta.inner', 'gamma'];

function randomBase(r: () => number): Flat {
  const f: Flat = new Map();
  for (let i = 0; i < 14; i++) f.set(`${TABLES[Math.floor(r() * TABLES.length)]!}|k${i}`, String(Math.floor(r() * 100)));
  return f;
}

function toToml(f: Flat): string {
  const byTable = new Map<string, [string, string][]>();
  for (const [k, v] of f) {
    const [t, leaf] = k.split('|') as [string, string];
    byTable.set(t, [...(byTable.get(t) ?? []), [leaf, v]]);
  }
  let out = (byTable.get('') ?? []).map(([l, v]) => `${l} = ${v} # c\n`).join('');
  for (const [t, rows] of byTable) if (t !== '') out += `\n[${t}]\n${rows.map(([l, v]) => `${l} = ${v}\n`).join('')}`;
  return out;
}
const toProps = (f: Flat): string => [...f].map(([k, v]) => `${k.split('|')[1]!}.${k.split('|')[0]!}=${v}\n`).join('');
const flatKey = (k: string, format: KeyFormat): string => {
  const [t, leaf] = k.split('|') as [string, string];
  return format === 'toml' ? (t ? `${t}.${leaf}` : leaf) : `${leaf}.${t}`;
};

describe('threeWayMerge property test', () => {
  for (const format of ['toml', 'properties'] as const) {
    it(`never loses a key nor invents a conflict when edits touch different keys (${format})`, () => {
      for (let seed = 1; seed <= 120; seed++) {
        const r = rng(seed);
        const then = randomBase(r);
        const now: Flat = new Map(then);
        const mine: Flat = new Map(then);
        const expected: Flat = new Map(then);
        let n = 0;
        for (const key of [...then.keys()]) {
          const roll = r();
          if (roll < 0.25) {
            now.set(key, `${1000 + n++}`);
            expected.set(key, now.get(key)!);
          } else if (roll < 0.4) {
            now.delete(key);
            expected.delete(key);
          } else if (roll < 0.65) {
            mine.set(key, `${2000 + n++}`);
            expected.set(key, mine.get(key)!);
          } else if (roll < 0.75) {
            mine.delete(key);
            expected.delete(key);
          }
        }
        // New keys on each side, in distinct places.
        const nt = TABLES[Math.floor(r() * TABLES.length)]!;
        now.set(`${nt}|newBase`, '11');
        expected.set(`${nt}|newBase`, '11');
        const mt = TABLES[Math.floor(r() * TABLES.length)]!;
        mine.set(`${mt}|newMine`, '22');
        expected.set(`${mt}|newMine`, '22');
        mine.set('freshTable|only', '33');
        expected.set('freshTable|only', '33');

        const text = format === 'toml' ? toToml : toProps;
        const parse = (f: Flat) => {
          const p = parseKeys(text(f), format);
          if (!p.ok) throw new Error(`seed ${seed}: ${p.reason}\n${text(f)}`);
          return p.keys;
        };
        const result = threeWayMerge(parse(then), parse(now), parse(mine));
        expect(result.clean, `seed ${seed}`).toBe(true);
        const out = renderMerged(format, text(now), text(mine), result);
        expect(out.conflicts, `seed ${seed}\n${text(now)}\n---\n${text(mine)}\n---\n${out.text}`).toEqual([]);
        const back = parseKeys(out.text, format);
        expect(back.ok).toBe(true);
        const want = Object.fromEntries([...expected].map(([k, v]) => [flatKey(k, format), v]));
        expect(back.ok && Object.fromEntries(back.keys), `seed ${seed}`).toEqual(want);
        expect(Object.fromEntries(result.merged)).toEqual(want);
      }
    });
  }
});
