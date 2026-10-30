export type VersionOrder = 'newer' | 'older' | 'equal' | 'incomparable';

// A numeric segment is kept as a digit string without leading zeros: no precision loss above 2^53, no Infinity.
type Item = { kind: 'num'; value: string } | { kind: 'str'; value: string };

// Maven ComparableVersion qualifier order. Any other word (pre, dev, nightly, hotfix, forge...) is an unknown qualifier.
const QUALIFIER_ORDER = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
// A Map, so words such as "constructor" cannot resolve to Object.prototype members.
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['a', 'alpha'],
  ['b', 'beta'],
  ['m', 'milestone'],
  ['cr', 'rc'],
  ['ga', ''],
  ['final', ''],
  ['release', ''],
]);

// A token made only of hex digits, at least 7 long, with both letters and digits, is a commit hash: it has no order.
// An optional leading "g" is the marker `git describe` puts in front of the hash (1.2.3-4-g1a2b3c4).
const HASH_LIKE = /(?<![0-9a-z])g?(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}(?![0-9a-z])/;

// Maven turns the lone letters a/b/m into alpha/beta/milestone only when a number follows them directly (1.0b1).
// A trailing letter on its own is a patch letter (2.5.4b), so it stays a plain qualifier that sorts after the release.
const GLUED_ALIASES = new Set(['a', 'b', 'm']);

// A "v" glued to a digit is a version prefix (v1.2.3), not a qualifier. "ver" or "version" are left alone.
const normalise = (version: string): string => version.trim().toLowerCase().replace(/^v(?=\d)/, '');

function parse(version: string): Item[] | null {
  const v = normalise(version);
  if (!v || v.includes('${') || !/\d/.test(v) || HASH_LIKE.test(v)) return null;
  const items: Item[] = [];
  for (const m of v.matchAll(/\d+|[a-z]+/g)) {
    const t = m[0];
    if (/^\d/.test(t)) items.push({ kind: 'num', value: t.replace(/^0+(?=\d)/, '') });
    else if (GLUED_ALIASES.has(t)) items.push({ kind: 'str', value: /\d/.test(v[m.index + t.length] ?? '') ? (ALIASES.get(t) ?? t) : t });
    else items.push({ kind: 'str', value: ALIASES.get(t) ?? t });
  }
  return items;
}

function rank(q: string): number {
  const i = QUALIFIER_ORDER.indexOf(q);
  return i >= 0 ? i : QUALIFIER_ORDER.length;
}

// NaN means "no defined order". An unknown word of 2+ letters can be a pre-release, a patch or a platform tag, so it has no order
// against a release, a known qualifier or a different word; only the identical word equals itself. A lone letter is a patch letter
// (2.5.4b) and keeps Maven's place after the release and after the known qualifiers.
function cmpQualifier(a: string, b: string): number {
  if (a === b) return 0;
  const ra = rank(a);
  const rb = rank(b);
  const unknown = QUALIFIER_ORDER.length;
  if (ra === unknown && rb === unknown && a.length === 1 && b.length === 1) return a < b ? -1 : 1; // 2.5.4b comes after 2.5.4a
  if ((ra === unknown && a.length > 1) || (rb === unknown && b.length > 1)) return Number.NaN;
  return ra - rb;
}

// Digit strings without leading zeros: the longer one is bigger, same length compares lexically.
function cmpNum(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const isZero = (item: Item | undefined): boolean => item?.kind === 'num' && item.value === '0';

// Compares one item with "nothing" (the other version already ended): 0 and the release qualifier equal nothing.
function cmpWithNothing(item: Item): number {
  return item.kind === 'num' ? (item.value === '0' ? 0 : 1) : cmpQualifier(item.value, '');
}

function cmpItems(a: Item | undefined, b: Item | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -cmpWithNothing(b!);
  if (!b) return cmpWithNothing(a);
  if (a.kind === 'num' && b.kind === 'num') return cmpNum(a.value, b.value);
  if (a.kind === 'num') return 1;
  if (b.kind === 'num') return -1;
  return cmpQualifier(a.value, b.value);
}

// A zero is inert when only zeros follow it up to a qualifier or the end: 1.0-beta1 == 1.0.0-beta1, 1.0-final == 1.0.0.
function inertZero(items: Item[], from: number): boolean {
  for (let j = from; j < items.length; j++) {
    const it = items[j]!;
    if (it.kind === 'str') return true;
    if (it.value !== '0') return false;
  }
  return true;
}

// Walks both versions; an inert zero facing a qualifier is skipped so that the same zero is never "nothing" in one comparison and
// "greater than any qualifier" in another (that made the order non transitive). i and j are the positions that decided.
function walk(pa: Item[], pb: Item[]): { c: number; i: number; j: number } {
  let i = 0;
  let j = 0;
  while (i < pa.length || j < pb.length) {
    const x = pa[i];
    const y = pb[j];
    if (isZero(x) && y?.kind === 'str' && inertZero(pa, i)) {
      i++;
      continue;
    }
    if (isZero(y) && x?.kind === 'str' && inertZero(pb, j)) {
      j++;
      continue;
    }
    const c = cmpItems(x, y);
    if (c !== 0) return { c, i, j };
    i++;
    j++;
  }
  return { c: 0, i, j };
}

/** Maven ComparableVersion-style ordering. `newer` means `a` is newer than `b`; strings that cannot be ordered are `incomparable`. */
export function compareVersions(a: string, b: string): VersionOrder {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 'incomparable';
  const { c } = walk(pa, pb);
  if (Number.isNaN(c)) return 'incomparable';
  return c === 0 ? 'equal' : c > 0 ? 'newer' : 'older';
}

export type VersionSideExplanation = { raw: string; tokens: string[]; hashLike: boolean; unparsable: boolean };
export type CompareExplanation = {
  a: VersionSideExplanation;
  b: VersionSideExplanation;
  result: VersionOrder;
  deciding: { index: number; tokenA: string | null; tokenB: string | null } | null;
  note: string;
};

const tokenText = (item: Item | undefined): string | null => (item ? item.value : null);

function side(raw: string, items: Item[] | null): VersionSideExplanation {
  const v = normalise(raw);
  return { raw, tokens: items ? items.map((i) => i.value) : (v.match(/\d+|[a-z]+/g) ?? []), hashLike: HASH_LIKE.test(v), unparsable: items === null };
}

/** Same ordering as compareVersions (`result` is always identical), plus the tokens and the one that decided, for debugging a row. */
export function explainCompare(a: string, b: string): CompareExplanation {
  const pa = parse(a);
  const pb = parse(b);
  const sa = side(a, pa);
  const sb = side(b, pb);
  if (!pa || !pb) {
    const why = (s: VersionSideExplanation, name: string) =>
      !s.unparsable ? '' : s.hashLike ? `${name} contains a commit hash` : !s.raw.trim() ? `${name} is empty` : s.raw.includes('${') ? `${name} is an unexpanded placeholder` : `${name} has no digit`;
    const reasons = [why(sa, 'a'), why(sb, 'b')].filter(Boolean).join('; ');
    return { a: sa, b: sb, result: 'incomparable', deciding: null, note: `Cannot be ordered: ${reasons}.` };
  }
  const { c, i, j } = walk(pa, pb);
  if (c !== 0) {
    const deciding = { index: i, tokenA: tokenText(pa[i]), tokenB: tokenText(pb[j]) };
    const shown = (t: string | null) => (t === null ? '(nothing)' : t === '' ? '(release)' : `"${t}"`);
    if (Number.isNaN(c)) {
      return {
        a: sa,
        b: sb,
        result: 'incomparable',
        deciding,
        note: `Token ${i}: ${shown(deciding.tokenA)} and ${shown(deciding.tokenB)} have no defined order (an unknown qualifier may be a pre-release, a patch or a platform tag).`,
      };
    }
    const result: VersionOrder = c > 0 ? 'newer' : 'older';
    return { a: sa, b: sb, result, deciding, note: `Token ${i} decides: ${shown(deciding.tokenA)} ${c > 0 ? '>' : '<'} ${shown(deciding.tokenB)}, so a is ${result} than b.` };
  }
  return { a: sa, b: sb, result: 'equal', deciding: null, note: 'Every token is equal (trailing zeros and release qualifiers are ignored).' };
}
