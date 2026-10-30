import { parseKeys, type KeyEntry, type KeyFormat, type KeyMap, type ParsedKeys } from './keys.js';

/**
 * Three-way merge of config files on parsed keys: `baseThen` is the base version your retouches were made on, `baseNow` the
 * new base version and `mine` your file. Pure data in, pure data out; `renderMerged` turns the decisions back into file text.
 */
export type Decision = 'equal' | 'mine' | 'base' | 'conflict';

export type KeyDecision = {
  key: string;
  decision: Decision;
  /** Value in the merge (`undefined`: the key is absent). A conflict keeps the new base value. */
  value: string | undefined;
  then: string | undefined;
  now: string | undefined;
  mine: string | undefined;
};

export type MergeConflict = { key: string; reason: 'both-changed' | 'unrenderable' | 'render-check'; detail?: string };

export type MergeResult = {
  merged: Map<string, string>;
  decisions: KeyDecision[];
  conflicts: MergeConflict[];
  clean: boolean;
};

/** Decides every key of the three versions. Both sides changing the same key to different values is the only conflict. */
export function threeWayMerge(baseThen: KeyMap, baseNow: KeyMap, mine: KeyMap): MergeResult {
  const keys = new Set<string>([...baseThen.keys(), ...baseNow.keys(), ...mine.keys()]);
  const decisions: KeyDecision[] = [];
  const merged = new Map<string, string>();
  const conflicts: MergeConflict[] = [];
  for (const key of keys) {
    const then = baseThen.get(key);
    const now = baseNow.get(key);
    const m = mine.get(key);
    let decision: Decision;
    let value: string | undefined;
    if (m === now) {
      decision = 'equal';
      value = now;
    } else if (m === then) {
      decision = 'base';
      value = now;
    } else if (now === then) {
      decision = 'mine';
      value = m;
    } else {
      decision = 'conflict';
      value = now;
      conflicts.push({ key, reason: 'both-changed' });
    }
    decisions.push({ key, decision, value, then, now, mine: m });
    if (value !== undefined) merged.set(key, value);
  }
  return { merged, decisions, conflicts, clean: conflicts.length === 0 };
}

export type RenderResult = { text: string; conflicts: MergeConflict[]; clean: boolean };

type Edit = { pos: number; end: number; text: string; order: number };

/**
 * Applies the `mine` decisions to the text of the NEW base: values are replaced in place, comments and order are kept. What the
 * format cannot express (adding or removing a JSON key, a key in a TOML array table...) is reported as a conflict, never invented.
 * The result is parsed again and checked against the merge: a mismatch is reported too.
 */
export function renderMerged(format: KeyFormat, newBaseText: string, mineText: string, result: MergeResult): RenderResult {
  const base = parseKeys(newBaseText, format);
  const mine = parseKeys(mineText, format);
  if (!base.ok || !mine.ok) {
    const why = !base.ok ? `new base: ${base.reason}` : `mine: ${(mine as { reason: string }).reason}`;
    return { text: newBaseText, conflicts: [{ key: '*', reason: 'unrenderable', detail: why }], clean: false };
  }
  const conflicts: MergeConflict[] = [...result.conflicts];
  const unrenderable = new Set<string>();
  const eol = newBaseText.includes('\r\n') ? '\r\n' : '\n';
  const edits: Edit[] = [];
  const push = (pos: number, end: number, text: string) => edits.push({ pos, end, text, order: edits.length });
  const skip = (key: string, detail: string) => {
    unrenderable.add(key);
    conflicts.push({ key, reason: 'unrenderable', detail });
  };
  const insertAfter = (pos: number, line: string) => push(pos, pos, (pos > 0 && newBaseText[pos - 1] !== '\n' ? eol : '') + line);
  const lineOf = (e: KeyEntry): string => {
    const l = mineText.slice(e.lineStart, e.lineEnd);
    return l.endsWith('\n') ? l : l + eol;
  };

  for (const d of result.decisions) {
    if (d.decision !== 'mine') continue;
    const b = base.entries.get(d.key);
    const m = mine.entries.get(d.key);
    if (b && m) {
      push(b.start, b.end, mineText.slice(m.start, m.end));
    } else if (b && !m) {
      if (format === 'json') skip(d.key, 'a JSON key cannot be removed without rewriting the file');
      else push(b.lineStart, b.lineEnd, '');
    } else if (!b && m) {
      if (format === 'json') skip(d.key, 'a JSON key cannot be added without rewriting the file');
      else if (format === 'properties') {
        if (m.table.length > 0) {
          const sibling = [...base.entries.values()].filter((e) => e.table.join('.') === m.table.join('.')).pop();
          if (sibling) insertAfter(sibling.lineEnd, lineOf(m));
          else skip(d.key, 'its category does not exist in the new base');
        } else insertAfter(newBaseText.length, lineOf(m));
      } else {
        const tableName = m.table.join('.');
        if (m.table.some((s) => /\[\d+\]$/.test(s))) skip(d.key, 'a key of a TOML array table cannot be placed safely');
        else {
          const siblings = [...base.entries.values()].filter((e) => e.table.join('.') === tableName);
          const last = siblings[siblings.length - 1];
          if (last) insertAfter(last.lineEnd, lineOf(m));
          else if (m.table.length === 0) insertAfter(newBaseText.charCodeAt(0) === 0xfeff ? 1 : 0, lineOf(m));
          else if (!/["']/.test(tableName) && new RegExp(`^[ \\t]*\\[[ \\t]*${tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\.', '[ \\t]*\\.[ \\t]*')}[ \\t]*\\]`, 'm').test(newBaseText)) {
            skip(d.key, 'its table exists but is empty in the new base');
          } else insertAfter(newBaseText.length, `${eol}[${tableName}]${eol}${lineOf(m)}`);
        }
      }
    }
  }

  // Apply from the end so earlier offsets stay valid; at the same position later-created edits go first, keeping creation order.
  edits.sort((a, c) => c.pos - a.pos || c.order - a.order);
  let text = newBaseText;
  for (const e of edits) text = text.slice(0, e.pos) + e.text + text.slice(e.end);

  const check: ParsedKeys = parseKeys(text, format);
  if (!check.ok) {
    return { text: newBaseText, conflicts: [...conflicts, { key: '*', reason: 'render-check', detail: check.reason }], clean: false };
  }
  for (const d of result.decisions) {
    if (d.decision === 'conflict' || unrenderable.has(d.key)) continue;
    if (check.keys.get(d.key) !== d.value) conflicts.push({ key: d.key, reason: 'render-check', detail: 'the rendered file does not hold the merged value' });
  }
  return { text, conflicts, clean: conflicts.length === 0 };
}
