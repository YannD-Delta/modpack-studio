import { isUtf8 } from 'node:buffer';
import { extOf } from './inventory.js';

/** Files above this size are never normalised: a differing hash then simply means `modified`. */
export const NORMALIZE_MAX_BYTES = 1024 * 1024;

const JSON_EXT = new Set(['json', 'json5', 'jsonc', 'mcmeta']);

/** UTF-8 (invalid bytes become U+FFFD), without a leading BOM. */
export function decodeText(buf: Buffer): string {
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** BOM, line endings, trailing spaces and tabs and trailing blank lines are formatting, not content (other Unicode blanks, such as a no-break space, are content). */
export function normalizeText(text: string): string {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

/** Removes `//` and `/* *\/` comments and trailing commas outside strings, then JSON.parse. Throws on anything else. */
export function parseTolerantJson(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ',') {
      // Drop the comma when only whitespace or comments separate it from a closing bracket.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === '/' && text[j + 1] === '/') while (j < text.length && text[j] !== '\n') j++;
        else if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2);
          j = end < 0 ? text.length : end + 2;
        } else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out, rejectUnsafeInteger);
}

const INT_LITERAL = /^-?\d+$/;
/** An integer literal beyond 2^53 would collapse onto its neighbours once parsed to a double: refuse it so the file is compared as text. */
function rejectUnsafeInteger(_key: string, value: unknown, ctx?: { source?: string }): unknown {
  if (typeof value === 'number' && ctx?.source !== undefined && INT_LITERAL.test(ctx.source) && !Number.isSafeInteger(value)) throw new RangeError('integer beyond 2^53');
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** The delimiter of a multi-line string (`"""` basic, `'''` literal) that a line leaves open, or null. */
type TomlOpen = '"""' | "'''" | null;

/** Index just after the closing delimiter of a multi-line string, looking from `from`; -1 when the line ends inside the string. */
function tomlStringEnd(line: string, from: number, delim: '"""' | "'''"): number {
  const q = delim[0]!;
  for (let i = from; i < line.length; i++) {
    if (q === '"' && line[i] === '\\') i++; // an escape (also `\"` and a line-ending backslash); literal strings have none
    else if (line[i] === q && line.startsWith(delim, i)) {
      let end = i + 3;
      while (end < i + 5 && line[end] === q) end++; // one or two quotes right before the delimiter belong to the string
      return end;
    }
  }
  return -1;
}

/**
 * Reads one line after the multi-line string the previous line left open (if any): the line cut of a `#` comment that is outside
 * every string, whether it started inside a string, and the string it leaves open. Text inside strings is never altered.
 */
function scanTomlLine(line: string, open: TomlOpen): { text: string; startsInString: boolean; open: TomlOpen } {
  const startsInString = open !== null;
  let i = 0;
  if (open) {
    const end = tomlStringEnd(line, 0, open);
    if (end < 0) return { text: line, startsInString, open };
    i = end;
  }
  let quote: string | null = null;
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      const delim = c.repeat(3) as '"""' | "'''";
      if (!line.startsWith(delim, i)) quote = c;
      else {
        const end = tomlStringEnd(line, i + 3, delim);
        if (end < 0) return { text: line, startsInString, open: delim };
        i = end - 1;
      }
    } else if (c === '#') return { text: line.slice(0, i), startsInString, open: null };
  }
  return { text: line, startsInString, open: null };
}

const TOML_KEY_LINE = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/;

/** Spacing around the dots of a dotted key is formatting; a quoted segment is a name and stays as written (`"a . b"` is not `"a.b"`). */
const tidyKey = (key: string): string => key.replace(/("[^"]*"|'[^']*')|\s*\.\s*/g, (_all, quoted?: string) => quoted ?? '.');

/**
 * Comments, blank lines, indentation and spacing around `=` do not change a TOML file's settings; order is kept.
 * What is inside a multi-line string (`"""` or `'''`) is a value: its `#`, blank lines and indentation are compared as written.
 */
function normalizeToml(text: string): string {
  const out: string[] = [];
  let open: TomlOpen = null;
  for (const raw of normalizeText(text).split('\n')) {
    const { text: code, startsInString, open: next } = scanTomlLine(raw, open);
    open = next;
    if (startsInString) {
      out.push(code.trimEnd()); // the line starts inside a string: keep its indentation and keep it even when blank
      continue;
    }
    const l = code.trim();
    if (l === '') continue;
    const m = TOML_KEY_LINE.exec(l);
    out.push(m ? `${tidyKey(m[1]!)} = ${m[2]}` : l);
  }
  return out.join('\n');
}

/** The per-format comparison key of already decoded text. */
function compareKey(rel: string, text: string): string {
  const ext = extOf(rel);
  if (JSON_EXT.has(ext)) {
    try {
      return `json:${JSON.stringify(canonical(parseTolerantJson(text)))}`;
    } catch {
      return `text:${normalizeText(text)}`;
    }
  }
  if (ext === 'toml') return `toml:${normalizeToml(text)}`;
  return `text:${normalizeText(text)}`;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * A string that is equal for two files exactly when they only differ in form (see the per-format rules above).
 * Text that is not valid UTF-8 (a Latin-1 or Windows-1252 file) is decoded byte for byte, in its own key space: decoding it as UTF-8
 * would turn every invalid byte into U+FFFD and make two different files look the same.
 */
export function normalizeForCompare(rel: string, buf: Buffer): string {
  const body = buf.subarray(0, 3).equals(BOM) ? buf.subarray(3) : buf;
  const valid = isUtf8(body);
  const key = compareKey(rel, body.toString(valid ? 'utf8' : 'latin1'));
  return valid ? key : `latin1|${key}`;
}
