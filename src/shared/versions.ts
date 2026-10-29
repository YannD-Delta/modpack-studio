export type VersionOrder = 'newer' | 'older' | 'equal' | 'incomparable';

type Item = { kind: 'num'; value: number } | { kind: 'str'; value: string };

// Maven ComparableVersion qualifier order; unknown qualifiers sort after "sp", lexically.
const QUALIFIER_ORDER = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES: Record<string, string> = { a: 'alpha', b: 'beta', m: 'milestone', cr: 'rc', ga: '', final: '', release: '' };

// A token made only of hex digits, at least 7 long, with both letters and digits, is a commit hash: it has no order.
const HASH_LIKE = /(?<![0-9a-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}(?![0-9a-z])/;

function parse(version: string): Item[] | null {
  const v = version.trim().toLowerCase();
  if (!v || v.includes('${') || !/\d/.test(v) || HASH_LIKE.test(v)) return null;
  const tokens = v.match(/\d+|[a-z]+/g) ?? [];
  return tokens.map((t) => (/^\d/.test(t) ? { kind: 'num', value: Number(t) } : { kind: 'str', value: ALIASES[t] ?? t }));
}

function rank(q: string): number {
  const i = QUALIFIER_ORDER.indexOf(q);
  return i >= 0 ? i : QUALIFIER_ORDER.length;
}

// NaN means "no defined order": two different qualifiers that Maven does not know.
function cmpQualifier(a: string, b: string): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === QUALIFIER_ORDER.length) return a === b ? 0 : Number.NaN;
  return 0;
}

// Compares one item with "nothing" (the other version already ended): 0 and the release qualifier equal nothing.
function cmpWithNothing(item: Item): number {
  return item.kind === 'num' ? Math.sign(item.value) : cmpQualifier(item.value, '');
}

function cmpItems(a: Item | undefined, b: Item | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -cmpWithNothing(b!);
  if (!b) return cmpWithNothing(a);
  if (a.kind === 'num' && b.kind === 'num') return Math.sign(a.value - b.value);
  if (a.kind === 'num') return 1;
  if (b.kind === 'num') return -1;
  return cmpQualifier(a.value, b.value);
}

/** Maven ComparableVersion-style ordering. `newer` means `a` is newer than `b`; strings that cannot be ordered are `incomparable`. */
export function compareVersions(a: string, b: string): VersionOrder {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 'incomparable';
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const c = cmpItems(pa[i], pb[i]);
    if (Number.isNaN(c)) return 'incomparable';
    if (c !== 0) return c > 0 ? 'newer' : 'older';
  }
  return 'equal';
}

export type VersionSideExplanation = { raw: string; tokens: string[]; hashLike: boolean; unparsable: boolean };
export type CompareExplanation = {
  a: VersionSideExplanation;
  b: VersionSideExplanation;
  result: VersionOrder;
  deciding: { index: number; tokenA: string | null; tokenB: string | null } | null;
  note: string;
};

const tokenText = (item: Item | undefined): string | null => (item ? String(item.value) : null);

function side(raw: string, items: Item[] | null): VersionSideExplanation {
  const v = raw.trim().toLowerCase();
  return { raw, tokens: items ? items.map((i) => String(i.value)) : (v.match(/\d+|[a-z]+/g) ?? []), hashLike: HASH_LIKE.test(v), unparsable: items === null };
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
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const c = cmpItems(pa[i], pb[i]);
    if (c === 0) continue;
    const deciding = { index: i, tokenA: tokenText(pa[i]), tokenB: tokenText(pb[i]) };
    const shown = (t: string | null) => (t === null ? '(nothing)' : t === '' ? '(release)' : `"${t}"`);
    if (Number.isNaN(c)) {
      return { a: sa, b: sb, result: 'incomparable', deciding, note: `Token ${i}: unknown qualifiers ${shown(deciding.tokenA)} and ${shown(deciding.tokenB)} have no defined order.` };
    }
    const result: VersionOrder = c > 0 ? 'newer' : 'older';
    return { a: sa, b: sb, result, deciding, note: `Token ${i} decides: ${shown(deciding.tokenA)} ${c > 0 ? '>' : '<'} ${shown(deciding.tokenB)}, so a is ${result} than b.` };
  }
  return { a: sa, b: sb, result: 'equal', deciding: null, note: 'Every token is equal (trailing zeros and release qualifiers are ignored).' };
}
