import { useMutation, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow, type ModDiff, type ModEntry } from '../api.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

type Status = 'anomaly' | 'removed' | 'added' | 'older' | 'newer' | 'different' | 'rebuilt';
type Row = { modId: string; status: Status; ref?: ModEntry; cmp?: ModEntry };

// Most serious first: this order drives both the chips and the sort of the table.
const STATUSES: Status[] = ['anomaly', 'removed', 'older', 'different', 'rebuilt', 'newer', 'added'];
const BADGE: Record<Status, string> = {
  anomaly: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  removed: 'border-slate-600 bg-slate-800/60 text-slate-300',
  added: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  older: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
  newer: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  different: 'border-orange-700/60 bg-orange-950/50 text-orange-300',
  rebuilt: 'border-violet-700/60 bg-violet-950/50 text-violet-300',
};
const ICON: Record<Status, string> = { anomaly: '⚠', removed: '－', added: '＋', older: '↓', newer: '↑', different: '≠', rebuilt: '↻' };
const GRID = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.4fr)_11rem]';
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

  const all: Row[] = useMemo(() => {
    const d = diff.data;
    if (!d) return [];
    return [
      ...d.removed.map((e): Row => ({ modId: e.modId, status: removedIsAnomaly ? 'anomaly' : 'removed', ref: e })),
      ...d.added.map((e): Row => ({ modId: e.modId, status: 'added', cmp: e })),
      ...d.updated.map((u): Row => ({ modId: u.modId, status: u.direction, ref: u.from, cmp: u.to })),
      ...d.rebuilt.map((e): Row => ({ modId: e.modId, status: 'rebuilt', ref: e, cmp: e })),
    ].sort((x, y) => STATUSES.indexOf(x.status) - STATUSES.indexOf(y.status) || x.modId.localeCompare(y.modId));
  }, [diff.data, removedIsAnomaly]);
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((st) => [st, all.filter((r) => r.status === st).length])) as Record<Status, number>, [all]);
  const rows = useMemo(() => all.filter((r) => filter === 'all' || r.status === filter), [all, filter]);

  const a = base ? `${base.pack} ${base.version}` : '';
  const b = other ? `${other.pack} ${other.version}` : '';
  const why = (r: Row) =>
    tf(`mods.why.${r.status}` as MessageKey, { a, b, from: r.ref?.version ?? '', to: r.cmp?.version ?? '', v: r.cmp?.version ?? '' });

  const decide = useMutation({
    mutationFn: (v: { modId: string; body: object }) => api(`/mods/${encodeURIComponent(v.modId)}/decision`, { method: 'PUT', body: v.body }),
    onSuccess: (_d, v) => setDone((s) => new Set(s).add(v.modId)),
  });

  const actions = (r: Row) => {
    if (done.has(r.modId)) return <span className="text-xs text-emerald-400">✓</span>;
    if (r.status === 'anomaly') return <button className={action} aria-label={`${t('mods.acceptRemoval')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'ignore', reason: 'retrait accepté' } })}>{t('mods.acceptRemoval')}</button>;
    if (r.status === 'older' || r.status === 'newer' || r.status === 'different') return <button className={action} aria-label={`${t('mods.pin')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'pin', reason: 'version épinglée' } })}>{t('mods.pin')}</button>;
    if (r.status === 'added') return <button className={action} aria-label={`${t('mods.clientOnly')} ${r.modId}`} onClick={() => decide.mutate({ modId: r.modId, body: { kind: 'side', side: 'client', reason: 'client uniquement' } })}>{t('mods.clientOnly')}</button>;
    return null;
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 44, overscan: 12 });

  const versionCell = (e: ModEntry | undefined, missing: boolean) =>
    e ? (
      <span className="block min-w-0">
        <span className="block truncate font-mono text-slate-100">{e.version}</span>
        <span className="block truncate text-xs text-slate-500" title={e.file}>{e.file}</span>
      </span>
    ) : (
      <span className={`text-xs ${missing ? 'font-medium text-rose-400' : 'text-slate-500'}`}>— {t('mods.absent')}</span>
    );

  const renderRow = (r: Row, style?: React.CSSProperties) => (
    <div key={r.modId} style={style} className={`${GRID} items-center gap-3 border-b border-slate-800 px-4 py-2.5 text-sm hover:bg-slate-900/60`}>
      <span className="min-w-0">
        <span className="block truncate font-mono text-slate-100">{r.modId}</span>
        <span className={`mt-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${BADGE[r.status]}`}><span aria-hidden>{ICON[r.status]}</span>{t(`mods.status.${r.status}` as MessageKey)}</span>
      </span>
      {versionCell(r.ref, false)}
      {versionCell(r.cmp, r.status === 'anomaly' || r.status === 'removed')}
      <span className="text-slate-300">{why(r)}</span>
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
        {diff.data && <span className="pb-2 text-sm text-slate-400">{diff.data.unchanged} {t('mods.unchanged')}</span>}
      </div>

      {diff.isLoading && <p className="text-slate-400">{t('common.loading')}</p>}
      {diff.data && (
        <>
          <p className="text-sm text-slate-400">{tf('mods.legend', { a, b })}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFilter('all')} aria-pressed={filter === 'all'} className={`rounded-full border px-3 py-1 text-xs ${filter === 'all' ? 'border-violet-500 bg-violet-950/60 text-violet-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>{t('mods.filter.all')} · {all.length}</button>
            {STATUSES.filter((st) => counts[st] > 0).map((st) => (
              <button key={st} onClick={() => setFilter(st)} aria-pressed={filter === st} className={`rounded-full border px-3 py-1 text-xs ${BADGE[st]} ${filter === st ? 'ring-2 ring-violet-500' : 'opacity-80 hover:opacity-100'}`}>
                {ICON[st]} {t(`mods.filter.${st}` as MessageKey)} · {counts[st]}
              </button>
            ))}
          </div>
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <div className={`${GRID} gap-3 bg-slate-900 px-4 py-3 text-xs uppercase tracking-wide text-slate-400`}>
            <span>{t('mods.col.mod')}</span><span className="normal-case" title={a && base ? profileLabel(base) : ''}>{a}</span><span className="normal-case" title={b && other ? profileLabel(other) : ''}>{b}</span><span>{t('mods.col.why')}</span><span className="text-right">{t('mods.col.action')}</span>
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
        </>
      )}
    </section>
  );
}
