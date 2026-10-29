import fs from 'node:fs';
import path from 'node:path';

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function isOutside(from: string, to: string): boolean {
  const rel = path.relative(from, to);
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

/**
 * Resolves `rel` inside `root` or throws PathEscapeError.
 * Rejects traversal, drive/UNC paths, alternate data streams, device names, trailing dot/space segments,
 * and symlinks/junctions that leave the root (checked on the deepest existing ancestor).
 */
export function safeResolve(root: string, rel: string): string {
  if (rel.includes('\0')) throw new PathEscapeError('NUL byte in path');
  if (/^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel) || path.isAbsolute(rel)) {
    throw new PathEscapeError(`absolute or UNC path not allowed: ${rel}`);
  }
  for (const segment of rel.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new PathEscapeError('parent traversal not allowed');
    if (segment.includes(':')) throw new PathEscapeError(`alternate data stream not allowed: ${segment}`);
    if (DEVICE_NAME.test(segment)) throw new PathEscapeError(`device name not allowed: ${segment}`);
    if (/[. ]$/.test(segment)) throw new PathEscapeError(`trailing dot or space not allowed: ${segment}`);
  }

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (isOutside(resolvedRoot, target)) throw new PathEscapeError('path leaves the root');

  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (fs.existsSync(existing)) {
    const realTarget = fs.realpathSync.native(existing);
    const realRoot = fs.realpathSync.native(resolvedRoot);
    if (isOutside(realRoot, realTarget)) throw new PathEscapeError('link points outside the root');
  }
  return target;
}
