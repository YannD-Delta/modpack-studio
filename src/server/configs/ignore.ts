import { defineLimit, getListLimit } from '../settings/limits.js';

defineLimit({
  key: 'configs.ignoredPaths',
  kind: 'list',
  default: [],
  maxItems: 200,
  group: 'configs',
  label: 'Paths left out of the config scan (next scan)',
});

const regexCache = new Map<string, RegExp>();

/** `kubejs/exported` matches that folder and everything below it; `*` stays inside one name, `**` crosses folders. Case and slash style do not matter. */
function compile(pattern: string): RegExp {
  const hit = regexCache.get(pattern);
  if (hit) return hit;
  const clean = pattern.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  let body = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (c === '*' && clean[i + 1] === '*') {
      body += '.*';
      i++;
    } else if (c === '*') body += '[^/]*';
    else body += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp(`^${body}(?:/.*)?$`);
  regexCache.set(pattern, rx);
  return rx;
}

export function matchesPattern(pattern: string, rel: string): boolean {
  if (!pattern.trim()) return false;
  return compile(pattern).test(rel.replace(/\\/g, '/').toLowerCase());
}

/** True when a path relative to the instance root (forward slashes) is banned in Settings. */
export function isIgnoredByUser(rel: string): boolean {
  const patterns = getListLimit('configs.ignoredPaths');
  return patterns.length > 0 && patterns.some((p) => matchesPattern(p, rel));
}
