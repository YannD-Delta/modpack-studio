import { useMutation, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow, type ModDiff } from '../api.js';
import { t, type MessageKey } from '../i18n/index.js';

type Status = 'added' | 'removed' | 'updated' | 'rebuilt' | 'anomaly';
type Row = { modId: string; status: Status; versions: string; detail?: string };

const BADGE: Record<Status, string> = {
  added: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  removed: 'border-slate-600 bg-slate-800/60 text-slate-300',
  updated: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  rebuilt: 'border-violet-700/60 bg-violet-950/50 text-violet-300',
  anomaly: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
};
const ICON: Record<Status, string> = { added: '＋', removed: '－', updated: '↑', rebuilt: '↻', anomaly: '⚠' };
const VIRTUALIZE_ABOVE = 200;

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700';

export function Mods() {
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const profiles = useMemo(() => flattenProfiles(matrix.data ?? []), [matrix.data]);
  const [baseId, setBaseId] = useState('');
  const [otherId, setOtherId] = useState('');
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [done, setDone] = useState<Set<string>>(new Set());

  const diff = useQuery({
    queryKey: ['diff', baseId, otherId],
    queryFn: () => api<ModDiff>(`/mods/diff?base=${baseId}&other=${otherId}`),
    enabled: !!baseId && !!otherId,
  });

  const base = profiles.find((p) => String(p.id) === baseId);
  const other = profiles.find((p) => String(p.id) === otherId);
  // Against an ATM10 reference, a mod LMP no longer has is an anomaly (Yann does not remove mods).
  const removedIsAnomaly = base?.pack === 'ATM10' && other?.pack === 'LMP';

  const rows: Row[] = useMemo(() => {
    const d = diff.data;
    if (!d) return [];
    return [
      ...d.removed.map((e): Row => ({ modId: e.modId, status: removedIsAnomaly ? 'anomaly' : 'removed', versions: e.version })),
      ...d.added.map((e): Row => ({ modId: e.modId, status: 'added', versions: e.version })),
      ...d.updated.map((u): Row => ({ modId: u.modId, status: 'updated', versions: `${u.from.version} → ${u.to.version}`, detail: t(`mods.direction.${u.direction}` as MessageKey) })),
      ...d.rebuilt.map((e): Row => ({ modId: e.modId, status: 'rebuilt', versions: e.version })),
    ].filter((r) => filter === 'all' || r.status === filter).sort((a, b) => a.modId.localeCompare(b.modId));
  }, [diff.data, filter, removedIsAnomaly]);

  const decide = useMutation({
    mutationFn: (v: { modId: string; body: object }) => api(`/mods/${encodeURIComponent(v.modId)}/decision`, { method: 'PUT', body: v.body }),
    onSuccess: (_d, v) => setDone((s) => new Set(s).add(v.modId)),
  });

  const actions = (r: Row) => {
    if (done.has(r.modId)) return <span className="text-xs text-emerald-400">✓</span>;
    if (r.status === 'anomaly') return <button className={action} aria-label={`${t('mods.acceptRemoval')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'ignore', reason: 'retrait accepté' } })}>{t('mods.acceptRemoval')}</button>;
    if (r.status === 'updated') return <button className={action} aria-label={`${t('mods.pin')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'pin', reason: 'version épinglée' } })}>{t('mods.pin')}</button>;
    if (r.status === 'added') return <button className={action} aria-label={`${t('mods.clientOnly')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'side', side: 'client', reason: 'client uniquement' } })}>{t('mods.clientOnly')}</button>;
    return null;
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 44, overscan: 12 });

  const renderRow = (r: Row, style?: React.CSSProperties) => (
    <div key={r.modId} style={style} className="grid grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.5fr)_12rem] items-center gap-3 border-b border-slate-800 px-4 py-2.5 text-sm hover:bg-slate-900/60">
      <span className="truncate font-mono text-slate-100">{r.modId}</span>
      <span><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${BADGE[r.status]}`}><span aria-hidden>{ICON[r.status]}</span>{t(`mods.status.${r.status}` as MessageKey)}</span></span>
      <span className="truncate text-slate-300">{r.versions}{r.detail && <span className="ml-2 text-xs text-slate-500">{r.detail}</span>}</span>
      <span className="text-right">{actions(r)}</span>
    </div>
  );

  if (!matrix.data) return <p className="text-slate-400">{t('common.loading')}</p>;

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('mods.title')}</h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-300">{t('mods.base')}
          <select value={baseId} onChange={(e) => setBaseId(e.target.value)} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('mods.choose')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300">{t('mods.other')}
          <select value={otherId} onChange={(e) => setOtherId(e.target.value)} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('mods.choose')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300">{t('mods.filter')}
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | Status)} className={`${field} mt-1 block`}>
            <option value="all">{t('mods.filter.all')}</option>
            <option value="added">{t('mods.filter.added')}</option>
            <option value="removed">{t('mods.filter.removed')}</option>
            <option value="updated">{t('mods.filter.updated')}</option>
            <option value="rebuilt">{t('mods.filter.rebuilt')}</option>
            <option value="anomaly">{t('mods.filter.anomaly')}</option>
          </select>
        </label>
        {diff.data && <span className="pb-2 text-sm text-slate-400">{diff.data.unchanged} {t('mods.unchanged')}</span>}
      </div>

      {diff.isLoading && <p className="text-slate-400">{t('common.loading')}</p>}
      {diff.data && (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <div className="grid grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.5fr)_12rem] gap-3 bg-slate-900 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
            <span>{t('mods.col.mod')}</span><span>{t('mods.col.status')}</span><span>{t('mods.col.versions')}</span><span className="text-right">{t('mods.col.action')}</span>
          </div>
          {virtual ? (
            <div ref={parentRef} className="max-h-[70vh] overflow-auto">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((v) => renderRow(rows[v.index]!, { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }))}
              </div>
            </div>
          ) : (
            rows.map((r) => renderRow(r))
          )}
        </div>
      )}
    </section>
  );
}
