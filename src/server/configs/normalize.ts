import { extOf } from './inventory.js';

/** Files above this size are never normalised: a differing hash then simply means `modified`. */
export const NORMALIZE_MAX_BYTES = 1024 * 1024;

const JSON_EXT = new Set(['json', 'json5', 'jsonc', 'mcmeta']);

/** UTF-8 (invalid bytes become U+FFFD), without a leading BOM. */
export function decodeText(buf: Buffer): string {
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** BOM, line endings, trailing whitespace and trailing blank lines are formatting, not content. */
export function normalizeText(text: string): string {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/).map((l) => l.trimEnd());
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
  return JSON.parse(out);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** Cuts a `#` comment that is outside a single- or double-quoted string. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const TOML_KEY_LINE = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/;

/** Comments, blank lines, indentation and spacing around `=` do not change a TOML file's settings; order is kept. */
function normalizeToml(text: string): string {
  return normalizeText(text)
    .split('\n')
    .map((l) => stripTomlComment(l).trim())
    .filter((l) => l !== '')
    .map((l) => {
      const m = TOML_KEY_LINE.exec(l);
      return m ? `${m[1]!.replace(/\s*\.\s*/g, '.')} = ${m[2]}` : l;
    })
    .join('\n');
}

/** A string that is equal for two files exactly when they only differ in form (see the per-format rules above). */
export function normalizeForCompare(rel: string, buf: Buffer): string {
  const text = decodeText(buf);
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
