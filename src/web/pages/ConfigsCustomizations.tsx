import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, flattenProfiles, type MatrixRow } from '../api.js';
import { exportDownloadUrl, getExport, getExportJob, startExport } from '../api-plan.js';
import { configsApi, CUSTOM_STATUSES, customizationsApi, type CustomFile, type CustomStatus } from '../api-configs.js';
import { t, tf, type MessageKey } from '../i18n/index.js';
import { FileDiffView, fmtSize, ProfileCard } from './Configs.js';

const action = 'rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = 'rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50';
const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? 'border-violet-500 bg-violet-950/60 text-violet-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`;
const input = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';

const BADGE: Record<CustomStatus, string> = {
  modifiedGenerated: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  modifiedShipped: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
  added: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  removed: 'border-slate-600 bg-slate-800/60 text-slate-300',
  untouched: 'border-slate-700 bg-slate-900 text-slate-400',
};
const SHOWN: CustomStatus[] = ['modifiedGenerated', 'modifiedShipped', 'added', 'removed'];

/** Exports the plan (files taken from the played instance), then waits for the pack and links its zip. */
function ExportBar(props: { played: number; launched: number; count: number }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useMutation({ mutationFn: () => startExport(props.played, props.launched), onSuccess: (r) => setJobId(r.jobId) });
  const job = useQuery({
    queryKey: ['export-job', jobId],
    queryFn: () => getExportJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && !['queued', 'running'].includes(q.state.data.status) ? false : 1000),
  });
  const done = job.data?.status === 'done' && job.data.name ? job.data.name : null;
  const result = useQuery({ queryKey: ['export-result', done], queryFn: () => getExport(done!), enabled: !!done });
  const busy = start.isPending || (!!jobId && (!job.data || ['queued', 'running'].includes(job.data.status)));
  if (props.count === 0 && !jobId) return null;
  return (
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-violet-800/60 bg-slate-950/95 px-4 py-3 shadow-lg backdrop-blur">
      <span className="text-sm text-slate-200">{tf('custom.planCount', { n: String(props.count) })}</span>
      <button className={primary} disabled={busy || props.count === 0} title={t('custom.exportTip')} onClick={() => start.mutate()}>{busy ? t('custom.exporting') : t('custom.export')}</button>
      {job.data?.status === 'failed' && <span role="status" className="text-xs text-rose-300">{tf('custom.exportFailed', { msg: job.data.message ?? '' })}</span>}
      {done && (
        <span role="status" className="flex flex-wrap items-center gap-2 text-xs text-emerald-400">
          {tf('custom.exportDone', { name: done })}
          <a className="underline" href={exportDownloadUrl(done)}>{t('custom.download')}</a>
          {result.data && <span className="font-mono text-slate-400">{result.data.folder}</span>}
        </span>
      )}
    </div>
  );
}

/** The player's own changes, from three copies of the pack: clean (shipped), launched (clean started once), played (really used). */
export function CustomizationsView() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const profiles = useMemo(() => flattenProfiles(matrix.data ?? []), [matrix.data]);
  const [cleanId, setCleanId] = useState('');
  const [launchedId, setLaunchedId] = useState('');
  const [playedId, setPlayedId] = useState('');
  const [filter, setFilter] = useState<'all' | CustomStatus>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const inv = (id: string) => ({ queryKey: ['configs-inventory', id], queryFn: () => configsApi.inventory(id), enabled: !!id, retry: false });
  const cleanInv = useQuery(inv(cleanId));
  const launchedInv = useQuery(inv(launchedId));
  const playedInv = useQuery(inv(playedId));
  const distinct = new Set([cleanId, launchedId, playedId]).size === 3 && !!cleanId && !!launchedId && !!playedId;
  const ready = distinct && cleanInv.isSuccess && launchedInv.isSuccess && playedInv.isSuccess;

  const data = useQuery({
    queryKey: ['configs-custom', cleanId, launchedId, playedId, cleanInv.data?.scannedAt, launchedInv.data?.scannedAt, playedInv.data?.scannedAt],
    queryFn: () => customizationsApi.get(cleanId, launchedId, playedId),
    enabled: ready,
    retry: false,
  });
  const plan = useQuery({ queryKey: ['configs-plan', playedId, launchedId], queryFn: () => configsApi.plan(playedId, launchedId), enabled: ready });
  const planned = useMemo(() => new Set(plan.data?.paths ?? []), [plan.data]);
  useEffect(() => setOpen(new Set()), [cleanId, launchedId, playedId]);

  const setPlan = useMutation({
    mutationFn: (v: { paths: string[]; selected: boolean }) => customizationsApi.setPlan(Number(cleanId), Number(launchedId), Number(playedId), v.paths, v.selected),
    onSuccess: (r) => qc.setQueryData(['configs-plan', playedId, launchedId], { paths: r.paths }),
  });

  const name = (id: string) => {
    const p = profiles.find((x) => String(x.id) === id);
    return p ? `${p.pack} ${p.version}` : '';
  };
  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => (data.data?.files ?? []).filter((f) => (filter === 'all' || f.status === filter) && (!needle || f.path.toLowerCase().includes(needle))), [data.data, filter, needle]);
  const counts = data.data?.summary.perStatus;
  const toggle = (f: CustomFile) => setPlan.mutate({ paths: [f.path], selected: !planned.has(f.path) });

  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-100">{t('custom.title')}</h2>
      <div className="max-w-3xl space-y-1.5 rounded-lg border border-teal-700/60 bg-teal-950/30 p-4 text-sm text-slate-200">
        <span className="text-[11px] font-medium uppercase tracking-widest text-teal-400">{t('custom.simple.label')}</span>
        {(['custom.simple.1', 'custom.simple.2', 'custom.simple.3', 'custom.simple.4'] as MessageKey[]).map((k) => <p key={k}>{t(k)}</p>)}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ProfileCard label={t('custom.clean')} profiles={profiles} value={cleanId} onChange={setCleanId} inv={cleanInv} />
        <ProfileCard label={t('custom.launched')} profiles={profiles} value={launchedId} onChange={setLaunchedId} inv={launchedInv} />
        <ProfileCard label={t('custom.played')} profiles={profiles} value={playedId} onChange={setPlayedId} inv={playedInv} />
      </div>

      {!ready && <p className="text-sm text-slate-400">{cleanId && launchedId && playedId && !distinct ? t('custom.distinct') : t('custom.pickAll')}</p>}
      {ready && data.isLoading && <p className="text-slate-400">{t('custom.loading')}</p>}
      {data.isError && <p className="text-sm text-rose-300">{(data.error as Error).message}</p>}

      {data.data && counts && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button className={chip(filter === 'all')} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('configs.filter.all')} · {SHOWN.reduce((n, s) => n + counts[s], 0)}</button>
            {SHOWN.filter((s) => counts[s] > 0).map((s) => (
              <button key={s} title={t(`custom.tip.${s}` as MessageKey)} aria-pressed={filter === s} onClick={() => setFilter(s)} className={`rounded-full border px-3 py-1 text-xs ${BADGE[s]} ${filter === s ? 'ring-2 ring-violet-500' : 'opacity-80 hover:opacity-100'}`}>
                {t(`custom.status.${s}` as MessageKey)} · {counts[s]}
              </button>
            ))}
            <input aria-label={t('custom.search')} placeholder={t('custom.search')} value={search} onChange={(e) => setSearch(e.target.value)} className={`${input} ml-auto w-64`} />
            <button className={action} title={t('custom.selectAllTip')} disabled={setPlan.isPending || !rows.some((r) => r.include)} onClick={() => setPlan.mutate({ paths: rows.filter((r) => r.include).map((r) => r.path), selected: true })}>{t('custom.selectAll')}</button>
            <button className={action} title={t('custom.clearTip')} disabled={setPlan.isPending || planned.size === 0} onClick={() => setPlan.mutate({ paths: [...planned], selected: false })}>{t('custom.clear')}</button>
          </div>
          <p className="text-xs text-slate-500">{tf('custom.untouched', { n: String(counts.untouched) })}</p>

          {rows.length === 0 && <p className="text-sm text-slate-400">{t('custom.none')}</p>}
          <ul className="space-y-1.5">
            {rows.map((f) => {
              const kept = planned.has(f.path);
              return (
                <li key={f.path} className="rounded-lg border border-slate-800 bg-slate-900/40">
                  <div className="grid grid-cols-[minmax(0,2fr)_9.5rem_minmax(0,2.4fr)_11rem] items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate font-mono text-slate-100" title={f.path}>{f.path}</span>
                    <span><span title={t(`custom.tip.${f.status}` as MessageKey)} className={`inline-flex cursor-help rounded-full border px-2 py-0.5 text-xs ${BADGE[f.status]}`}>{t(`custom.status.${f.status}` as MessageKey)}</span></span>
                    <span className="text-slate-300">
                      {t(`custom.why.${f.status}` as MessageKey)}
                      <span className="ml-2 text-xs text-slate-500">{t('custom.launchedSize')} {fmtSize(f.launchedSize)} · {t('custom.playedSize')} {fmtSize(f.playedSize)}</span>
                    </span>
                    <span className="flex justify-end gap-2">
                      <button className={action} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; })}>{t('custom.details')}</button>
                      {f.include && <button className={kept ? `${action} border-emerald-700 text-emerald-300` : action} aria-pressed={kept} title={kept ? t('custom.keptTip') : t('custom.keepTip')} disabled={setPlan.isPending} onClick={() => toggle(f)}>{kept ? t('custom.kept') : t('custom.keep')}</button>}
                    </span>
                  </div>
                  {open.has(f.path) && <div className="border-t border-slate-800 p-3"><FileDiffView base={launchedId} other={playedId} path={f.path} onCount={() => undefined} /></div>}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-slate-500">{name(launchedId)} → {name(playedId)}</p>
          <ExportBar played={Number(playedId)} launched={Number(launchedId)} count={planned.size} />
        </>
      )}
    </section>
  );
}
