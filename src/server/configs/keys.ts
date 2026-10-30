import { defineLimit, getNumberLimit } from '../settings/limits.js';

/**
 * Key-level view of a config file: TOML, JSON (with comments) and .properties/.cfg are flattened to "section.key" -> value.
 * Scalars are compared as normalised text; arrays and inline tables as canonical JSON. Every entry also remembers where its
 * value sits in the source text so `merge.ts` can edit a file minimally. Nothing here throws on bad input.
 */
export type KeyFormat = 'toml' | 'json' | 'properties';

export type KeyEntry = {
  key: string;
  /** Normalised value used for every comparison. */
  value: string;
  /** Span of the raw value in the source text. */
  start: number;
  end: number;
  /** Whole source line(s) holding the entry, newline included (TOML and properties only). */
  lineStart: number;
  lineEnd: number;
  /** Table header the entry sits under (TOML), or enclosing category (.cfg). */
  table: string[];
};

export type ParsedKeys =
  | { ok: true; format: KeyFormat; keys: Map<string, string>; entries: Map<string, KeyEntry> }
  | { ok: false; format: KeyFormat | null; reason: string };

export type KeyMap = ReadonlyMap<string, string>;

/** Past this many keys a file is compared as a whole file instead. */
defineLimit({ key: 'configs.maxKeys', kind: 'number', default: 20000, min: 100, max: 1000000, unit: 'count', group: 'configs', label: 'Most keys compared in one config file' });
const maxKeys = (): number => getNumberLimit('configs.maxKeys');

const MAX_DEPTH = 64;

export function formatOf(relPath: string): KeyFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(relPath)?.[1]?.toLowerCase();
  if (ext === 'toml') return 'toml';
  if (ext === 'json' || ext === 'json5' || ext === 'jsonc' || ext === 'mcmeta') return 'json';
  if (ext === 'properties' || ext === 'cfg' || ext === 'conf') return 'properties';
  return null;
}

class ParseError extends Error {}
const fail = (msg: string, at: number): never => {
  throw new ParseError(`${msg} at offset ${at}`);
};

/** Canonical JSON: object keys sorted, so two spellings of the same data compare equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const normNumber = (n: number): string => String(n);

/** Normalised text of a parsed value. */
function canon(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return normNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null) return 'null';
  return canonicalJson(v);
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r';

// ---------------------------------------------------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------------------------------------------------

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

class TomlScanner {
  i: number;
  constructor(readonly s: string) {
    this.i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  /** Skips spaces, tabs, comments and (optionally) newlines. */
  skip(newlines: boolean): void {
    for (;;) {
      const c = this.s[this.i];
      if (isWs(c) || (newlines && c === '\n')) this.i++;
      else if (c === '#') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else return;
    }
  }
  /** After a value or header: only spaces and a comment may remain on the line. */
  endOfLine(): void {
    this.skip(false);
    if (!this.eof() && this.s[this.i] !== '\n') fail('unexpected text after value', this.i);
  }
  lineEndFrom(pos: number): number {
    const nl = this.s.indexOf('\n', pos);
    return nl < 0 ? this.s.length : nl + 1;
  }
  keyPath(): string[] {
    const out: string[] = [];
    for (;;) {
      this.skip(false);
      const c = this.s[this.i];
      if (c === '"' || c === "'") out.push(this.string(false));
      else {
        const from = this.i;
        while (this.i < this.s.length && BARE_KEY.test(this.s[this.i]!)) this.i++;
        if (this.i === from) fail('expected a key', this.i);
        out.push(this.s.slice(from, this.i));
      }
      this.skip(false);
      if (this.s[this.i] === '.') this.i++;
      else return out;
    }
  }
  string(allowMulti: boolean): string {
    const q = this.s[this.i]!;
    const triple = allowMulti && this.s.startsWith(q.repeat(3), this.i);
    const quote = triple ? q.repeat(3) : q;
    this.i += quote.length;
    if (triple && this.s[this.i] === '\r' && this.s[this.i + 1] === '\n') this.i += 2;
    else if (triple && this.s[this.i] === '\n') this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) fail('unterminated string', this.i);
      if (this.s.startsWith(quote, this.i)) {
        // In a multi-line string up to two quotes may sit right before the closing delimiter.
        if (triple) {
          let extra = 0;
          while (this.s[this.i + 3 + extra] === q && extra < 2) extra++;
          out += q.repeat(extra);
          this.i += 3 + extra;
        } else this.i += 1;
        return out;
      }
      const c = this.s[this.i]!;
      if (c === '\n' && !triple) fail('newline in string', this.i);
      if (q === '"' && c === '\\') {
        const e = this.s[this.i + 1];
        if (e !== undefined && ESCAPES[e] !== undefined) {
          out += ESCAPES[e];
          this.i += 2;
        } else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const hex = this.s.slice(this.i + 2, this.i + 2 + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('bad unicode escape', this.i);
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) fail('bad unicode escape', this.i);
          out += String.fromCodePoint(cp);
          this.i += 2 + len;
        } else if (triple && (e === '\n' || e === '\r' || isWs(e))) {
          this.i++;
          while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
        } else fail('bad escape', this.i);
        continue;
      }
      out += c;
      this.i++;
    }
  }
  value(depth: number): unknown {
    if (depth > MAX_DEPTH) fail('too deeply nested', this.i);
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string(true);
    if (c === '[') {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.skip(true);
        if (this.s[this.i] === ']') {
          this.i++;
          return arr;
        }
        arr.push(this.value(depth + 1));
        this.skip(true);
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') fail('expected , or ]', this.i);
      }
    }
    if (c === '{') {
      this.i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skip(true);
        if (this.s[this.i] === '}') {
          this.i++;
          return obj;
        }
        const path = this.keyPath();
        this.skip(false);
        if (this.s[this.i] !== '=') fail('expected =', this.i);
        this.i++;
        this.skip(false);
        setPath(obj, path, this.value(depth + 1));
        this.skip(true);
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') fail('expected , or }', this.i);
      }
    }
    const from = this.i;
    while (this.i < this.s.length && !/[\s,\]}#]/.test(this.s[this.i]!)) this.i++;
    // A date-time may contain one space between date and time.
    if (/^\d{4}-\d\d-\d\d$/.test(this.s.slice(from, this.i)) && /^ \d\d:\d\d/.test(this.s.slice(this.i, this.i + 6))) {
      this.i++;
      while (this.i < this.s.length && !/[\s,\]}#]/.test(this.s[this.i]!)) this.i++;
    }
    const tok = this.s.slice(from, this.i);
    if (tok === '') fail('expected a value', from);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(tok)) return tok;
    if (/^[+-]?(0|[1-9][\d_]*)$/.test(tok) || /^[+-]?(0|[1-9][\d_]*)(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(tok)) return Number(tok.replaceAll('_', ''));
    if (/^0x[0-9a-fA-F_]+$/.test(tok) || /^0o[0-7_]+$/.test(tok) || /^0b[01_]+$/.test(tok)) return Number(tok.replaceAll('_', ''));
    if (/^\d{4}-\d\d-\d\d|^\d\d:\d\d/.test(tok)) return tok;
    return fail(`unknown value "${tok.slice(0, 20)}"`, from);
  }
}

function setPath(obj: Record<string, unknown>, path: string[], v: unknown): void {
  let cur = obj;
  for (const seg of path.slice(0, -1)) {
    const next = cur[seg];
    cur = next && typeof next === 'object' && !Array.isArray(next) ? (next as Record<string, unknown>) : (cur[seg] = {});
  }
  cur[path[path.length - 1]!] = v;
}

function parseToml(s: string): Map<string, KeyEntry> {
  const sc = new TomlScanner(s);
  const out = new Map<string, KeyEntry>();
  const tableCounts = new Map<string, number>();
  let table: string[] = [];
  while (!sc.eof()) {
    sc.skip(true);
    if (sc.eof()) break;
    const lineStart = s.lastIndexOf('\n', sc.i - 1) + 1;
    if (s[sc.i] === '[') {
      const array = s[sc.i + 1] === '[';
      sc.i += array ? 2 : 1;
      const path = sc.keyPath();
      sc.skip(false);
      if (!s.startsWith(array ? ']]' : ']', sc.i)) fail('unterminated table header', sc.i);
      sc.i += array ? 2 : 1;
      sc.endOfLine();
      if (array) {
        const id = path.join('.');
        const n = tableCounts.get(id) ?? 0;
        tableCounts.set(id, n + 1);
        table = [...path.slice(0, -1), `${path[path.length - 1]}[${n}]`];
      } else table = path;
      continue;
    }
    const path = sc.keyPath();
    sc.skip(false);
    if (s[sc.i] !== '=') fail('expected =', sc.i);
    sc.i++;
    sc.skip(false);
    const start = sc.i;
    const v = sc.value(0);
    const end = sc.i;
    sc.endOfLine();
    const key = [...table, ...path].join('.');
    out.set(key, { key, value: canon(v), start, end, lineStart, lineEnd: sc.lineEndFrom(end), table });
    if (out.size > maxKeys()) fail('too many keys', sc.i);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON with comments, trailing commas tolerated
// ---------------------------------------------------------------------------------------------------------------------

class JsonScanner {
  i: number;
  readonly out = new Map<string, KeyEntry>();
  constructor(readonly s: string) {
    this.i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  }
  skip(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.i++;
      else if (c === '/' && this.s[this.i + 1] === '/') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      } else if (c === '/' && this.s[this.i + 1] === '*') {
        const e = this.s.indexOf('*/', this.i + 2);
        if (e < 0) fail('unterminated comment', this.i);
        this.i = e + 2;
      } else return;
    }
  }
  string(): string {
    const from = this.i;
    this.i++;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined || c === '\n') fail('unterminated string', from);
      if (c === '\\') this.i += 2;
      else if (c === '"') {
        this.i++;
        break;
      } else this.i++;
    }
    try {
      return JSON.parse(this.s.slice(from, this.i)) as string;
    } catch {
      return fail('bad string', from);
    }
  }
  /** Parses a value; `path` is its flat key. Objects are flattened, anything else is recorded as one entry. */
  value(path: string[], depth: number): unknown {
    if (depth > MAX_DEPTH) fail('too deeply nested', this.i);
    this.skip();
    const start = this.i;
    const c = this.s[this.i];
    const record = (v: unknown) => {
      const key = path.join('.');
      this.out.set(key, { key, value: canon(v), start, end: this.i, lineStart: start, lineEnd: this.i, table: path.slice(0, -1) });
      if (this.out.size > maxKeys()) fail('too many keys', this.i);
    };
    if (c === '{') {
      this.i++;
      const obj: Record<string, unknown> = {};
      let count = 0;
      for (;;) {
        this.skip();
        if (this.s[this.i] === '}') {
          this.i++;
          break;
        }
        if (this.s[this.i] !== '"') fail('expected a key', this.i);
        const k = this.string();
        this.skip();
        if (this.s[this.i] !== ':') fail('expected :', this.i);
        this.i++;
        obj[k] = this.value([...path, k], depth + 1);
        count++;
        this.skip();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') fail('expected , or }', this.i);
      }
      if (count === 0) record({});
      return obj;
    }
    let v: unknown;
    if (c === '[') {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.skip();
        if (this.s[this.i] === ']') {
          this.i++;
          break;
        }
        arr.push(this.plain(depth + 1));
        this.skip();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') fail('expected , or ]', this.i);
      }
      v = arr;
    } else v = this.scalar();
    record(v);
    return v;
  }
  /** A value inside an array: no entries are recorded for it, the array is one key. */
  plain(depth: number): unknown {
    if (depth > MAX_DEPTH) fail('too deeply nested', this.i);
    this.skip();
    const c = this.s[this.i];
    if (c === '{') {
      this.i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skip();
        if (this.s[this.i] === '}') {
          this.i++;
          return obj;
        }
        if (this.s[this.i] !== '"') fail('expected a key', this.i);
        const k = this.string();
        this.skip();
        if (this.s[this.i] !== ':') fail('expected :', this.i);
        this.i++;
        obj[k] = this.plain(depth + 1);
        this.skip();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') fail('expected , or }', this.i);
      }
    }
    if (c === '[') {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.skip();
        if (this.s[this.i] === ']') {
          this.i++;
          return arr;
        }
        arr.push(this.plain(depth + 1));
        this.skip();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') fail('expected , or ]', this.i);
      }
    }
    return this.scalar();
  }
  scalar(): unknown {
    const c = this.s[this.i];
    if (c === '"') return this.string();
    const from = this.i;
    while (this.i < this.s.length && !/[\s,\]}]/.test(this.s[this.i]!)) this.i++;
    const tok = this.s.slice(from, this.i);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    return fail(`unknown value "${tok.slice(0, 20)}"`, from);
  }
}

function parseJson(s: string): Map<string, KeyEntry> {
  const sc = new JsonScanner(s);
  sc.value(['$'], 0);
  sc.skip();
  if (sc.i < s.length) fail('unexpected text after the value', sc.i);
  // A top-level object has no "$" prefix: strip it from the keys.
  const out = new Map<string, KeyEntry>();
  for (const [k, e] of sc.out) {
    const key = k === '$' ? '$' : k.slice(2);
    out.set(key, { ...e, key, table: e.table.slice(1) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// .properties / .cfg
// ---------------------------------------------------------------------------------------------------------------------

function parseProperties(s: string): Map<string, KeyEntry> {
  const out = new Map<string, KeyEntry>();
  const section: string[] = [];
  let pos = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < s.length) {
    const nl = s.indexOf('\n', pos);
    const lineEnd = nl < 0 ? s.length : nl + 1;
    let contentEnd = nl < 0 ? s.length : nl;
    if (s[contentEnd - 1] === '\r') contentEnd--;
    const raw = s.slice(pos, contentEnd);
    const line = raw.trim();
    const lead = raw.length - raw.trimStart().length;
    const lineStart = pos;
    pos = lineEnd;
    if (line === '' || line.startsWith('#') || line.startsWith('!') || line.startsWith('//')) continue;
    // Forge .cfg categories: `name {` ... `}`.
    if (line === '}') {
      section.pop();
      continue;
    }
    if (line.endsWith('{') && !line.includes('=')) {
      section.push(line.slice(0, -1).trim().replace(/^"|"$/g, ''));
      continue;
    }
    let sep = line.indexOf('=');
    // Forge list header `S:name <` has no `=`: the value is the trailing `<`.
    if (sep < 0) {
      const listHead = /^(\S+)\s*<$/.exec(line);
      if (listHead) sep = listHead[1]!.length;
    }
    if (sep < 0) sep = line.indexOf(':');
    if (sep <= 0) fail(`not a key=value line "${line.slice(0, 30)}"`, lineStart);
    const name = line.slice(0, sep).trim();
    let valueText = line.slice(sep + 1).trim();
    const valueLead = line.slice(sep + 1).length - line.slice(sep + 1).trimStart().length;
    const start = lineStart + lead + sep + 1 + valueLead;
    let end = start + valueText.length;
    let entryEnd = lineEnd;
    // Forge list: `S:list <` ... `>` over several lines.
    if (valueText === '<') {
      const items: string[] = [];
      for (;;) {
        if (pos >= s.length) fail('unterminated list', start);
        const n2 = s.indexOf('\n', pos);
        const rowEnd = n2 < 0 ? s.length : n2;
        const item = s.slice(pos, rowEnd).trim();
        const rowStart = pos;
        pos = n2 < 0 ? s.length : n2 + 1;
        if (item === '>') {
          end = rowStart + s.slice(rowStart, rowEnd).indexOf('>') + 1;
          break;
        }
        items.push(item);
      }
      entryEnd = pos;
      valueText = canonicalJson(items);
    }
    const key = [...section, name].join('.');
    out.set(key, { key, value: valueText, start, end, lineStart, lineEnd: entryEnd, table: [...section] });
    if (out.size > maxKeys()) fail('too many keys', start);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/** Parses a config file into flat keys. `format` defaults to the one implied by `relPath` when given as a path. */
export function parseKeys(text: string, format: KeyFormat): ParsedKeys {
  try {
    if (text.includes('\u0000')) return { ok: false, format, reason: 'binary content' };
    const entries = format === 'toml' ? parseToml(text) : format === 'json' ? parseJson(text) : parseProperties(text);
    const keys = new Map<string, string>();
    for (const [k, e] of entries) keys.set(k, e.value);
    return { ok: true, format, keys, entries };
  } catch (err) {
    return { ok: false, format, reason: err instanceof ParseError ? err.message : err instanceof RangeError ? 'too deeply nested' : 'cannot be parsed' };
  }
}

export type KeyChange = { key: string; old: string; new: string };
export type KeyMove = { from: string; to: string; value: string };
export type KeyDiffResult = {
  added: { key: string; value: string }[];
  removed: { key: string; value: string }[];
  changed: KeyChange[];
  moved: KeyMove[];
};

const leafOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

/**
 * Differences between two flat key maps. A key removed in one place and added elsewhere with the same leaf name and the same
 * value is reported once, as moved.
 */
export function keyDiff(base: KeyMap, other: KeyMap): KeyDiffResult {
  const added: KeyDiffResult['added'] = [];
  const removed: KeyDiffResult['removed'] = [];
  const changed: KeyChange[] = [];
  for (const [key, value] of base) {
    const o = other.get(key);
    if (o === undefined) removed.push({ key, value });
    else if (o !== value) changed.push({ key, old: value, new: o });
  }
  for (const [key, value] of other) if (!base.has(key)) added.push({ key, value });

  const moved: KeyMove[] = [];
  const usedAdds = new Set<number>();
  const keptRemoved: KeyDiffResult['removed'] = [];
  for (const r of removed) {
    const idx = added.findIndex((a, i) => !usedAdds.has(i) && leafOf(a.key) === leafOf(r.key) && a.value === r.value);
    if (idx < 0) keptRemoved.push(r);
    else {
      usedAdds.add(idx);
      moved.push({ from: r.key, to: added[idx]!.key, value: r.value });
    }
  }
  return { added: added.filter((_, i) => !usedAdds.has(i)), removed: keptRemoved, changed, moved };
}
