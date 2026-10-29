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
