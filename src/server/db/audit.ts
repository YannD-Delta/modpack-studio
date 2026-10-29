import type { Db } from './open.js';

export function audit(db: Db, action: string, target: string, detail: unknown, actor = 'user'): void {
  db.sqlite
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, action, target, JSON.stringify(detail));
}
