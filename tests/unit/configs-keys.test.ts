import { describe, expect, it } from 'vitest';
import { formatOf, keyDiff, parseKeys } from '../../src/server/configs/keys.js';

const keys = (text: string, format: 'toml' | 'json' | 'properties') => {
  const p = parseKeys(text, format);
  if (!p.ok) throw new Error(p.reason);
  return Object.fromEntries(p.keys);
};

describe('formatOf', () => {
  it('maps extensions', () => {
    expect(formatOf('config/a.toml')).toBe('toml');
    expect(formatOf('config/a.JSON')).toBe('json');
    expect(formatOf('config/a.cfg')).toBe('properties');
    expect(formatOf('config/a.png')).toBeNull();
  });
});

describe('toml keys', () => {
  it('flattens tables, dotted and quoted keys, scalars and arrays', () => {
    const text = `# top
name = "x"  # trailing
speed = 1_000
ratio = 1.50
on = true
[general]
list = [ 1, 2,
  3, # c
]
inline = { b = 2, a = "z" }
"quoted.key" = 'lit'
a.b = 0x10
[[mods]]
id = "one"
[[mods]]
id = "two"
[sub.table]
s = """
multi\tline"""
`;
    expect(keys(text, 'toml')).toEqual({
      name: 'x',
      speed: '1000',
      ratio: '1.5',
      on: 'true',
      'general.list': '[1,2,3]',
      'general.inline': '{"a":"z","b":2}',
      'general.quoted.key': 'lit',
      'general.a.b': '16',
      'mods[0].id': 'one',
      'mods[1].id': 'two',
      'sub.table.s': 'multi\tline',
    });
  });

  it('reports unparsable input instead of throwing', () => {
    for (const bad of ['a = ', 'a = [1, 2', '[x', 'a = "open', 'a = 1 junk', '= 3', 'a = @', 'a = ' + '['.repeat(200)]) {
      const p = parseKeys(bad, 'toml');
      expect(p.ok, bad.slice(0, 20)).toBe(false);
    }
  });
});

describe('json keys', () => {
  it('flattens objects, keeps arrays whole, accepts comments and trailing commas', () => {
    const text = `{
  // comment
  "a": { "b": 1, "c": [3, 1,], /* x */ "d": {} },
  "s": "t", "n": null, "f": 1.0,
}`;
    expect(keys(text, 'json')).toEqual({ 'a.b': '1', 'a.c': '[3,1]', 'a.d': '{}', s: 't', n: 'null', f: '1' });
  });

  it('is insensitive to formatting and key order of objects in arrays', () => {
    expect(keys('{"a":[{"y":1,"x":2}]}', 'json')).toEqual(keys('{ "a": [ {"x":2, "y":1} ] }', 'json'));
  });

  it('reports bad json', () => {
    for (const bad of ['{"a":', '{a:1}', '{"a":1} x', '', '{"a":tru}']) expect(parseKeys(bad, 'json').ok, bad).toBe(false);
  });
});

describe('properties keys', () => {
  it('reads key=value, comments and Forge categories and lists', () => {
    const text = `# c
! c
motd=a:b
level : 3
general {
    B:flag=true
    S:names <
        one
        two
     >
}
`;
    expect(keys(text, 'properties')).toEqual({ motd: 'a:b', level: '3','general.B:flag': 'true', 'general.S:names': '["one","two"]' });
  });
});

describe('keyDiff', () => {
  const m = (o: Record<string, string>) => new Map(Object.entries(o));
  it('lists added, removed and changed keys', () => {
    const d = keyDiff(m({ a: '1', b: '2', c: '3' }), m({ a: '1', b: '9', d: '4' }));
    expect(d.changed).toEqual([{ key: 'b', old: '2', new: '9' }]);
    expect(d.removed).toEqual([{ key: 'c', value: '3' }]);
    expect(d.added).toEqual([{ key: 'd', value: '4' }]);
    expect(d.moved).toEqual([]);
  });

  it('reports a moved key once, not as added and removed', () => {
    const d = keyDiff(m({ 'old.speed': '5', 'old.other': '1' }), m({ 'new.speed': '5', 'new.other': '2' }));
    expect(d.moved).toEqual([{ from: 'old.speed', to: 'new.speed', value: '5' }]);
    expect(d.added).toEqual([{ key: 'new.other', value: '2' }]);
    expect(d.removed).toEqual([{ key: 'old.other', value: '1' }]);
  });

  it('does not call it a move when the value differs', () => {
    const d = keyDiff(m({ 'a.x': '1' }), m({ 'b.x': '2' }));
    expect(d.moved).toEqual([]);
    expect(d.added.length + d.removed.length).toBe(2);
  });
});
