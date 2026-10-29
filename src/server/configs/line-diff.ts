export type DiffOp = { type: 'equal' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null };
/** A unified-diff hunk; `from`/`to` index the op list (to exclusive). */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; from: number; to: number };

/** Edit distance budget of the Myers search: memory grows with its square, so above it the middle becomes one replace block. */
export const DEFAULT_MAX_EDIT = 2000;

/** Lines of a text file (BOM dropped, CRLF/CR/LF, no phantom empty line after the final newline). */
export function splitLines(text: string): string[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (s === '') return [];
  const lines = s.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Step = 'equal' | 'add' | 'del';

/** Myers O(ND) shortest edit script between a[lo..] and b[lo..]; null when D exceeds `maxD`. */
function myers(a: string[], b: string[], maxD: number): Step[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const limit = Math.min(max, maxD);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    // Keep only the diagonals reachable at this depth (plus one on each side): O(D^2) memory instead of O(D(N+M)).
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push('equal');
      x--;
      y--;
    }
    if (d > 0) steps.push(x === prevX ? 'add' : 'del');
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

/** Line diff with old/new line numbers. `coarse` is true when the budget was exceeded and the middle is one del+add block. */
export function diffLines(a: string[], b: string[], opts: { maxEdit?: number } = {}): { ops: DiffOp[]; coarse: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let mid = myers(midA, midB, opts.maxEdit ?? DEFAULT_MAX_EDIT);
  const coarse = mid === null;
  mid ??= [...midA.map((): Step => 'del'), ...midB.map((): Step => 'add')];

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const push = (type: Step) => {
    if (type === 'equal') ops.push({ type, text: a[i]!, oldNo: ++i, newNo: ++j });
    else if (type === 'del') ops.push({ type, text: a[i]!, oldNo: ++i, newNo: null });
    else ops.push({ type, text: b[j]!, oldNo: null, newNo: ++j });
  };
  for (let s = 0; s < start; s++) push('equal');
  for (const step of mid) push(step);
  for (let s = endA; s < a.length; s++) push('equal');
  return { ops, coarse };
}

/** Groups changed ops with `context` unchanged lines around them; groups closer than 2*context merge. */
export function buildHunks(ops: DiffOp[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === 'equal') {
      i++;
      continue;
    }
    const from = Math.max(0, i - context);
    let to = i;
    // Extend while the next change is within 2*context equal lines.
    for (;;) {
      while (to < ops.length && ops[to]!.type !== 'equal') to++;
      let gap = to;
      while (gap < ops.length && ops[gap]!.type === 'equal') gap++;
      if (gap < ops.length && gap - to <= 2 * context) to = gap;
      else {
        to = Math.min(ops.length, to + context);
        break;
      }
    }
    const slice = ops.slice(from, to);
    const firstOld = slice.find((o) => o.oldNo !== null)?.oldNo;
    const firstNew = slice.find((o) => o.newNo !== null)?.newNo;
    const oldLines = slice.filter((o) => o.type !== 'add').length;
    const newLines = slice.filter((o) => o.type !== 'del').length;
    hunks.push({
      oldStart: firstOld ?? precedingNo(ops, from, 'oldNo'),
      oldLines,
      newStart: firstNew ?? precedingNo(ops, from, 'newNo'),
      newLines,
      from,
      to,
    });
    i = to;
  }
  return hunks;
}

function precedingNo(ops: DiffOp[], from: number, key: 'oldNo' | 'newNo'): number {
  for (let k = from - 1; k >= 0; k--) {
    const n = ops[k]![key];
    if (n !== null) return n;
  }
  return 0;
}
