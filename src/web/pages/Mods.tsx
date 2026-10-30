import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow, type ModDiff, type ModEntry } from '../api.js';
import {
  clearModPlan,
  copyText,
  exportDownloadUrl,
  getExport,
  getExportJob,
  getModDebug,
  getPlan,
  putPlan,
  startExport,
  type ExportResult,
  type ModDebug,
  type PlanItem,
  type PlanState,
} from '../api-plan.js';
import { ClaudeActions } from '../components/ClaudeActions.js';
import { CurseForgeUpdates } from '../components/CurseForgeUpdates.js';
import { ErrorNotice, QueryGate } from '../components/ErrorNotice.js';
import { getPackNames, t, tf, type MessageKey } from '../i18n/index.js';

type Status = 'anomaly' | 'removed' | 'added' | 'older' | 'newer' | 'different' | 'rebuilt';
type Row = { modId: string; status: Status; ref?: ModEntry; cmp?: ModEntry };
type PlanAction = 'update' | 'restore';

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
const GRID = 'grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.7fr)_16rem]';
const VIRTUALIZE_ABOVE = 200;
const PUT_CHUNK = 1000;

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700';
const planBtn = 'rounded-md border border-violet-600/70 bg-violet-950/60 px-2 py-0.5 text-xs font-medium text-violet-100 hover:bg-violet-900/70';
const plannedBtn = 'rounded-md border border-emerald-600/70 bg-emerald-950/60 px-2 py-0.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/60';
const smallBadge = 'inline-flex items-center rounded-full border border-slate-600 bg-slate-800/70 px-1.5 py-px text-[11px] text-slate-300 cursor-help';
const linkBtn = 'text-[11px] text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline';

/** Rows where taking the reference jar makes sense; newer and added mods are the user's own choices. */
const planActionOf = (st: Status): PlanAction | null =>
  st === 'older' || st === 'different' || st === 'rebuilt' ? 'update' : st === 'anomaly' || st === 'removed' ? 'restore' : null;

const EMPTY_DECISIONS = { pins: [] as string[], ignored: [] as string[], clientOnly: [] as string[] };
const shortSha = (s: string | null | undefined) => (s ? `${s.slice(0, 12)}…` : '—');
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function Mods() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const profiles = useMemo(() => flattenProfiles(matrix.data ?? []), [matrix.data]);
  const [baseId, setBaseId] = useState('');
  const [otherId, setOtherId] = useState('');
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [openDebug, setOpenDebug] = useState<Set<string>>(new Set());
  const [planError, setPlanError] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  const ready = !!baseId && !!otherId;
  const diff = useQuery({
    queryKey: ['diff', baseId, otherId],
    queryFn: () => api<ModDiff>(`/mods/diff?base=${baseId}&other=${otherId}`),
    enabled: ready,
  });
  const plan = useQuery({ queryKey: ['plan', baseId, otherId], queryFn: () => getPlan(baseId, otherId), enabled: ready });
  // The comparison currently on screen: answers of requests started under another selection are ignored.
  const pairRef = useRef('');
  pairRef.current = `${baseId}:${otherId}`;
  const isCurrent = (v: { pair: string }) => v.pair === pairRef.current;
  const pairOf = () => `${baseId}:${otherId}`;
  const resetComparison = () => {
    setFilter('all');
    setOpenDebug(new Set());
    setPlanError('');
    setJobId(null);
  };
  const pickBase = (v: string) => { setBaseId(v); resetComparison(); };
  const pickOther = (v: string) => { setOtherId(v); resetComparison(); };

  const base = profiles.find((p) => String(p.id) === baseId);
  const other = profiles.find((p) => String(p.id) === otherId);
  // Against the followed pack, a mod the player's pack no longer has is an anomaly (the player does not remove mods).
  const removedIsAnomaly = base?.pack === getPackNames().upstream && other?.pack === getPackNames().own;

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

  const items: PlanItem[] = plan.data?.items ?? [];
  const planned = useMemo(() => new Set(items.filter((i) => i.kind === 'mod').map((i) => i.key)), [items]);
  const fileCount = items.filter((i) => i.kind === 'file').length;
  const decisions = plan.data?.decisions ?? EMPTY_DECISIONS;
  const pins = new Set(decisions.pins);
  const ignored = new Set(decisions.ignored);
  const clientOnly = new Set(decisions.clientOnly);
  const plannedUpdates = all.filter((r) => planned.has(r.modId) && planActionOf(r.status) === 'update').length;
  const plannedRestores = all.filter((r) => planned.has(r.modId) && planActionOf(r.status) === 'restore').length;

  const a = base ? `${base.pack} ${base.version}` : '';
  const b = other ? `${other.pack} ${other.version}` : '';
  const tip = (st: Status) => tf(`mods.tip.${st}` as MessageKey, { a, b });
  const why = (r: Row) =>
    tf(`mods.why.${r.status}` as MessageKey, { a, b, from: r.ref?.version ?? '', to: r.cmp?.version ?? '', v: r.cmp?.version ?? '' });

  const decide = useMutation({
    mutationFn: (v: { modId: string; body: object; pair: string }) => api(`/mods/${encodeURIComponent(v.modId)}/decision`, { method: 'PUT', body: v.body }),
    onSuccess: (_d, v) => {
      // A decision changes the diff itself (a pinned older mod stops being "older"), the plan and the lists built from decisions.
      for (const key of ['diff', 'plan', 'decisions', 'blacklist', 'debug']) void qc.invalidateQueries({ queryKey: [key] });
      if (isCurrent(v)) setPlanError('');
    },
    onError: (err, v) => {
      if (isCurrent(v)) setPlanError(tf('plan.error', { msg: errMsg(err) }));
    },
  });

  // Every plan mutation carries the pair it was started for: the cache key and the error line come from it, not from the current selection.
  const keyOf = (pair: string) => ['plan', ...pair.split(':')];
  const applyPlanItems = (res: { items?: PlanItem[] } | undefined, v: { pair: string }) => {
    if (isCurrent(v)) setPlanError('');
    if (res?.items) qc.setQueryData<PlanState>(keyOf(v.pair), (old) => ({ decisions: old?.decisions ?? EMPTY_DECISIONS, items: res.items! }));
    else void qc.invalidateQueries({ queryKey: keyOf(v.pair) });
  };
  const onPlanError = (err: unknown, v: { pair: string }) => {
    if (isCurrent(v)) setPlanError(tf('plan.error', { msg: errMsg(err) }));
  };

  const toggle = useMutation({
    mutationFn: (v: { modId: string; selected: boolean; pair: string }) => {
      const [b, o] = v.pair.split(':');
      return putPlan({ base: Number(b), other: Number(o), kind: 'mod', keys: [v.modId], selected: v.selected });
    },
    onSuccess: applyPlanItems,
    onError: onPlanError,
  });
  const selectMany = useMutation({
    mutationFn: async (v: { keys: string[]; pair: string }) => {
      const [b, o] = v.pair.split(':');
      let last: { items?: PlanItem[] } | undefined;
      for (let i = 0; i < v.keys.length; i += PUT_CHUNK) last = await putPlan({ base: Number(b), other: Number(o), kind: 'mod', keys: v.keys.slice(i, i + PUT_CHUNK), selected: true });
      return last;
    },
    onSuccess: applyPlanItems,
    onError: onPlanError,
  });
  const clear = useMutation({
    mutationFn: (v: { pair: string }) => {
      const [b, o] = v.pair.split(':');
      return clearModPlan(b!, o!);
    },
    onSuccess: (_r, v) => applyPlanItems(undefined, v),
    onError: onPlanError,
  });

  const exportStart = useMutation({
    mutationFn: (v: { pair: string }) => {
      const [b, o] = v.pair.split(':');
      return startExport(Number(b), Number(o));
    },
    onSuccess: (r, v) => {
      if (isCurrent(v)) setJobId(r.jobId);
    },
    onError: onPlanError,
  });
  const job = useQuery({
    queryKey: ['export-job', jobId],
    queryFn: () => getExportJob(jobId!),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false; // 401, 404 (unknown job) or a network failure: polling again cannot help
      const s = q.state.data?.status;
      return !s || s === 'queued' || s === 'running' ? 1000 : false;
    },
  });
  const exportName = job.data?.status === 'done' ? job.data.name : null;
  const exported = useQuery({ queryKey: ['export', exportName], queryFn: () => getExport(exportName!), enabled: !!exportName });
  const exporting = exportStart.isPending || (!!jobId && !job.isError && (!job.data || job.data.status === 'queued' || job.data.status === 'running'));
  const exportFailed = job.isError ? errMsg(job.error) : job.data && ['failed', 'cancelled', 'interrupted'].includes(job.data.status) ? job.data.message ?? job.data.status : null;

  const selectableKeys = rows.filter((r) => planActionOf(r.status) && !planned.has(r.modId)).map((r) => r.modId);

  const decisionButton = (r: Row) => {
    // The check mark comes from the server's decisions, so it is right for every comparison.
    if ((r.status === 'anomaly' && ignored.has(r.modId)) || (r.status === 'older' && pins.has(r.modId)) || (r.status === 'added' && clientOnly.has(r.modId))) return <span className="text-xs text-emerald-400">✓</span>;
    const send = (body: object) => decide.mutate({ modId: r.modId, body, pair: pairOf() });
    if (r.status === 'anomaly') return <button className={action} title={t('mods.tip.acceptRemoval')} aria-label={`${t('mods.acceptRemoval')} ${r.modId}`} onClick={() => send({ kind: 'ignore', reason: 'retrait accepté' })}>{t('mods.acceptRemoval')}</button>;
    if (r.status === 'older') return <button className={action} title={t('mods.tip.pin')} aria-label={`${t('mods.pin')} ${r.modId}`} onClick={() => send({ kind: 'pin', reason: 'version épinglée' })}>{t('mods.pin')}</button>;
    if (r.status === 'added') return <button className={action} title={t('mods.tip.clientOnly')} aria-label={`${t('mods.clientOnly')} ${r.modId}`} onClick={() => send({ kind: 'side', side: 'client', reason: 'client uniquement' })}>{t('mods.clientOnly')}</button>;
    return null;
  };

  const planButton = (r: Row) => {
    const kind = planActionOf(r.status);
    if (!kind || pins.has(r.modId)) return null; // the server refuses to plan a pinned mod
    const on = planned.has(r.modId);
    const label = on ? t('plan.planned') : kind === 'update' ? t('plan.update') : t('plan.restore');
    const title = on ? t('plan.tip.planned') : tf(kind === 'update' ? 'plan.tip.update' : 'plan.tip.restore', { a, b });
    return (
      <button className={on ? plannedBtn : planBtn} aria-pressed={on} aria-label={`${label} ${r.modId}`} title={title} disabled={toggle.isPending} onClick={() => toggle.mutate({ modId: r.modId, selected: !on, pair: pairOf() })}>
        {label}
      </button>
    );
  };

  const badges = (r: Row) => (
    <>
      {pins.has(r.modId) && <span className={smallBadge} title={t('plan.tip.badge.pinned')}>{t('plan.badge.pinned')}</span>}
      {ignored.has(r.modId) && <span className={smallBadge} title={t('plan.tip.badge.ignored')}>{t('plan.badge.ignored')}</span>}
      {clientOnly.has(r.modId) && <span className={smallBadge} title={t('plan.tip.badge.clientOnly')}>{t('plan.badge.clientOnly')}</span>}
    </>
  );

  const toggleDebug = (modId: string) =>
    setOpenDebug((s) => {
      const n = new Set(s);
      if (n.has(modId)) n.delete(modId);
      else n.add(modId);
      return n;
    });

  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 52, overscan: 12 });

  const versionCell = (e: ModEntry | undefined, missing: boolean) =>
    e ? (
      <span className="block min-w-0">
        <span className="block truncate font-mono text-slate-100">{e.version}</span>
        <span className="block truncate text-xs text-slate-500" title={e.file}>{e.file}</span>
      </span>
    ) : (
      <span className={`text-xs ${missing ? 'font-medium text-rose-400' : 'text-slate-500'}`}>— {t('mods.absent')}</span>
    );

  const renderRow = (r: Row, v?: { index: number; start: number }) => {
    const debugOpen = openDebug.has(r.modId);
    return (
      <div
        key={r.modId}
        data-index={v?.index}
        ref={v ? virtualizer.measureElement : undefined}
        style={v ? { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` } : undefined}
        className={`border-b border-slate-800 ${planned.has(r.modId) ? 'bg-emerald-950/15' : ''}`}
      >
        <div className={`${GRID} items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-900/60`}>
          <span className="min-w-0">
            <span className="block truncate font-mono text-slate-100">{r.modId}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              <span title={tip(r.status)} className={`inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${BADGE[r.status]}`}><span aria-hidden>{ICON[r.status]}</span>{t(`mods.status.${r.status}` as MessageKey)}</span>
              {badges(r)}
              <button className={linkBtn} aria-expanded={debugOpen} aria-label={`${t('plan.debug')} ${r.modId}`} title={t('plan.tip.debug')} onClick={() => toggleDebug(r.modId)}>{t('plan.debug')}</button>
            </span>
          </span>
          {versionCell(r.ref, false)}
          {versionCell(r.cmp, r.status === 'anomaly' || r.status === 'removed')}
          <span className="text-slate-300">{why(r)}</span>
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            {planButton(r)}
            {decisionButton(r)}
          </span>
        </div>
        {debugOpen && <DebugPanel modId={r.modId} baseId={baseId} otherId={otherId} />}
      </div>
    );
  };

  if (!matrix.data) return <QueryGate query={matrix} />;

  const barVisible = ready && (items.length > 0 || !!jobId);

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('mods.title')}</h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-300">{t('mods.base')}
          <select value={baseId} onChange={(e) => pickBase(e.target.value)} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('mods.choose')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300">{t('mods.other')}
          <select value={otherId} onChange={(e) => pickOther(e.target.value)} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('mods.choose')}</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        {diff.data && <span className="pb-2 text-sm text-slate-400">{diff.data.unchanged} {t('mods.unchanged')}</span>}
      </div>

      {diff.isLoading && <p className="text-slate-400">{t('common.loading')}</p>}
      {diff.isError && <ErrorNotice error={diff.error} />}
      {plan.isError && <ErrorNotice error={plan.error} />}
      {diff.data && (
        <>
          <p className="text-sm text-slate-400">{tf('mods.legend', { a, b })}</p>
          <ClaudeActions key={`${baseId}:${otherId}`} base={Number(baseId) || null} other={Number(otherId) || null} actions={['review-updates', 'review-added', 'review-missing']} />
          <CurseForgeUpdates key={otherId} profileId={Number(otherId) || null} />
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setFilter('all')} aria-pressed={filter === 'all'} className={`rounded-full border px-3 py-1 text-xs ${filter === 'all' ? 'border-violet-500 bg-violet-950/60 text-violet-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>{t('mods.filter.all')} · {all.length}</button>
            {STATUSES.filter((st) => counts[st] > 0).map((st) => (
              <button key={st} title={tip(st)} onClick={() => setFilter(st)} aria-pressed={filter === st} className={`rounded-full border px-3 py-1 text-xs ${BADGE[st]} ${filter === st ? 'ring-2 ring-violet-500' : 'opacity-80 hover:opacity-100'}`}>
                {ICON[st]} {t(`mods.filter.${st}` as MessageKey)} · {counts[st]}
              </button>
            ))}
            <span className="ml-auto flex gap-2">
              <button className={action} title={t('plan.tip.selectAll')} disabled={selectableKeys.length === 0 || selectMany.isPending} onClick={() => selectMany.mutate({ keys: selectableKeys, pair: pairOf() })}>{t('plan.selectAll')}</button>
              <button className={action} title={t('plan.tip.clear')} disabled={planned.size === 0 || clear.isPending} onClick={() => clear.mutate({ pair: pairOf() })}>{t('plan.clear')}</button>
            </span>
          </div>
          {planError && <p role="alert" className="text-sm text-rose-400">{planError}</p>}
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <div className={`${GRID} gap-3 bg-slate-900 px-4 py-3 text-xs uppercase tracking-wide text-slate-400`}>
              <span>{t('mods.col.mod')}</span><span className="normal-case" title={`${tf('mods.tip.refCol', { a, b })}${base ? ` (${profileLabel(base)})` : ''}`}>{a}</span><span className="normal-case" title={`${tf('mods.tip.cmpCol', { a, b })}${other ? ` (${profileLabel(other)})` : ''}`}>{b}</span><span>{t('mods.col.why')}</span><span className="text-right">{t('mods.col.action')}</span>
            </div>
            {virtual ? (
              <div ref={parentRef} className="max-h-[70vh] overflow-auto">
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((v) => renderRow(rows[v.index]!, { index: v.index, start: v.start }))}
                </div>
              </div>
            ) : (
              rows.map((r) => renderRow(r))
            )}
          </div>
        </>
      )}

      {barVisible && (
        <div role="region" aria-label={t('plan.bar.label')} className="sticky bottom-0 z-10 -mx-1 space-y-3 rounded-xl border border-violet-800/60 bg-slate-950/95 px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur">
          {exported.data && (
            <ExportCard result={exported.data.result} folder={exported.data.folder} onClose={() => setJobId(null)} />
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="font-medium text-slate-100">{t('plan.bar.label')}</span>
            <span className="text-slate-300">{tf('plan.bar.updates', { n: String(plannedUpdates) })}</span>
            <span className="text-slate-300">{tf('plan.bar.restores', { n: String(plannedRestores) })}</span>
            <span className="text-slate-300">{tf('plan.bar.files', { n: String(fileCount) })}</span>
            {exporting && <span className="text-violet-300">{tf('plan.exporting', { p: String(job.data?.progress ?? 0) })}</span>}
            {exportFailed && <span role="alert" className="text-rose-400">{tf('plan.exportFailed', { msg: exportFailed })}</span>}
            <button
              className="ml-auto rounded-lg border border-violet-500 bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              title={t('plan.tip.export')}
              disabled={exporting || items.length === 0}
              onClick={() => exportStart.mutate({ pair: pairOf() })}
            >
              {t('plan.export')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ExportCard({ result, folder, onClose }: { result: ExportResult; folder: string; onClose: () => void }) {
  const c = result.counts;
  const dry = `.\\apply.ps1 -InstanceDir "<dossier de l’instance>"`;
  return (
    <div className="max-h-[45vh] space-y-2 overflow-auto rounded-lg border border-emerald-700/60 bg-emerald-950/30 p-3 text-sm text-slate-200">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-emerald-300">{t('plan.result.title')}</span>
        <span className="font-mono text-xs text-slate-400">{result.name}</span>
        <button className={`${action} ml-auto`} title={t('plan.tip.close')} onClick={onClose}>{t('plan.result.close')}</button>
      </div>
      <p>
        {t('plan.result.folder')} <code className="select-all break-all rounded bg-slate-900 px-1 font-mono text-xs">{folder}</code>
      </p>
      <p>{tf('plan.result.counts', { u: String(c.modsUpdated), r: String(c.modsRestored), f: String(c.files), x: String(c.jarsToRemove) })}</p>
      {result.failures.length > 0 && (
        <div>
          <p className="font-medium text-rose-300">{tf('plan.result.failures', { n: String(result.failures.length) })}</p>
          <ul className="ml-4 list-disc text-xs text-rose-200">
            {result.failures.map((f) => <li key={`${f.kind}:${f.key}`}><span className="font-mono">{f.key}</span> — {f.reason}</li>)}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div>
          <p className="font-medium text-amber-300">{t('plan.result.warnings')}</p>
          <ul className="ml-4 list-disc text-xs text-amber-200">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <a className="inline-block rounded-md border border-emerald-600 bg-emerald-700/40 px-2.5 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-700/60" href={exportDownloadUrl(result.name)} download title={t('plan.tip.download')}>
        {t('plan.result.download')}
      </a>
      <div className="space-y-1 text-xs text-slate-300">
        <p>{t('plan.result.how')}</p>
        <p>{t('plan.result.howDry')} <code className="select-all rounded bg-slate-900 px-1 font-mono">{dry}</code></p>
        <p>{t('plan.result.howApply')} <code className="select-all rounded bg-slate-900 px-1 font-mono">{`${dry} -Apply`}</code></p>
        <p className="text-slate-400">{t('plan.result.safe')}</p>
      </div>
    </div>
  );
}

function Sha({ value }: { value: string | null | undefined }) {
  return <span className="font-mono" title={value ?? undefined}>{shortSha(value)}</span>;
}

function DebugPanel({ modId, baseId, otherId }: { modId: string; baseId: string; otherId: string }) {
  const q = useQuery({ queryKey: ['debug', modId, baseId, otherId], queryFn: () => getModDebug(modId, baseId, otherId) });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const box = 'mx-4 mb-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-xs text-slate-300';
  if (q.isLoading) return <div className={box}>{t('plan.debug.loading')}</div>;
  if (q.error || !q.data) return <div className={`${box} text-rose-400`}>{errMsg(q.error)}</div>;
  const d: ModDebug = q.data;

  const side = (s: ModDebug['base']) =>
    s.entry ? (
      <span>
        <span className="text-slate-400">{s.profile.label}</span> · <span className="font-mono text-slate-100">{s.entry.version}</span> · <span className="font-mono">{s.entry.file}</span> · <Sha value={s.entry.sha256} />
      </span>
    ) : (
      <span><span className="text-slate-400">{s.profile.label}</span> · <span className="text-rose-300">{t('plan.debug.absent')}</span></span>
    );

  const dec = d.decisions;
  const decisionList = [
    dec.pin && t('plan.badge.pinned'),
    dec.ignore && t('plan.badge.ignored'),
    dec.side && tf('plan.debug.side', { s: dec.side.side ?? '?' }),
    dec.blacklisted && tf('plan.debug.blacklisted', { o: dec.blacklisted.origin }),
  ].filter(Boolean) as string[];

  const src = d.sourceJar;
  const srcStatus = !src ? t('plan.debug.sourceNone') : !src.exists ? t('plan.debug.sourceMissing') : src.matches ? t('plan.debug.sourceOk') : t('plan.debug.sourceChanged');
  const shown = (tok: string | null) => (tok === null ? '∅' : tok === '' ? 'release' : tok);

  const copy = async () => setCopied((await copyText(JSON.stringify(d, null, 2))) ? 'ok' : 'fail');

  return (
    <div className={box}>
      <dl className="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <dt className="text-slate-500">{t('plan.debug.ref')}</dt>
        <dd>{side(d.base)}</dd>
        <dt className="text-slate-500">{t('plan.debug.cmp')}</dt>
        <dd>{side(d.other)}</dd>
        {d.comparison && (
          <>
            <dt className="text-slate-500">{t('plan.debug.comparison')}</dt>
            <dd className="space-y-0.5">
              <span className="block text-slate-100">{t(`plan.debug.result.${d.comparison.result}` as MessageKey)}</span>
              {d.comparison.deciding && <span className="block">{tf('plan.debug.decisive', { i: String(d.comparison.deciding.index), a: shown(d.comparison.deciding.tokenA), b: shown(d.comparison.deciding.tokenB) })}</span>}
              <span className="block font-mono text-slate-400">{tf('plan.debug.tokens', { a: `[${d.comparison.a.tokens.join(', ')}]`, b: `[${d.comparison.b.tokens.join(', ')}]` })}</span>
              <span className="block text-slate-500">{d.comparison.note}</span>
            </dd>
          </>
        )}
        <dt className="text-slate-500">{t('plan.debug.decisions')}</dt>
        <dd>{decisionList.length ? decisionList.join(' · ') : t('plan.debug.none')}</dd>
        <dt className="text-slate-500">{t('plan.debug.plan')}</dt>
        <dd>
          {!d.plan.actionable ? t('plan.debug.notActionable') : `${d.plan.planned ? t('plan.debug.planned') : t('plan.debug.notPlanned')} (${t(`plan.debug.action.${d.plan.action}` as MessageKey)})`}
        </dd>
        <dt className="text-slate-500">{t('plan.debug.duplicates')}</dt>
        <dd className="font-mono">
          {!d.duplicates.base && !d.duplicates.other ? <span className="font-sans">{t('plan.debug.noDup')}</span> : [d.duplicates.base?.join(', '), d.duplicates.other?.join(', ')].filter(Boolean).join(' | ')}
        </dd>
        <dt className="text-slate-500">{t('plan.debug.source')}</dt>
        <dd className="space-y-0.5">
          <span className={`block font-medium ${src && src.exists && src.matches ? 'text-emerald-300' : src ? 'text-rose-300' : 'text-slate-400'}`}>{srcStatus}</span>
          {src?.path && <span className="block break-all font-mono text-slate-400">{src.path}</span>}
          {src?.size != null && <span className="block">{tf('plan.debug.size', { n: String(src.size) })}</span>}
          {src && (
            <span className="block">
              {t('plan.debug.recorded')} <Sha value={src.sha256Recorded} /> · {t('plan.debug.actual')} <Sha value={src.sha256Actual} />
            </span>
          )}
          {src?.error && <span className="block text-rose-300">{src.error}</span>}
        </dd>
      </dl>
      <div className="mt-2 flex items-center gap-2">
        <button className={action} title={t('plan.tip.copy')} onClick={() => void copy()}>{t('plan.debug.copy')}</button>
        {copied === 'ok' && <span className="text-emerald-400">{t('plan.debug.copied')}</span>}
        {copied === 'fail' && <span className="text-rose-400">{t('plan.debug.copyFailed')}</span>}
      </div>
    </div>
  );
}
