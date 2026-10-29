import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ApiError, api, flattenProfiles, profileLabel, type MatrixRow, type Profile } from '../api.js';
import {
  configsApi,
  FILE_STATUSES,
  PLANNABLE_STATUSES,
  TRACKED_ROOTS,
  type ConfigDiffFile,
  type ConfigInventory,
  type DiffLine,
  type FileStatus,
  type ScanJob,
} from '../api-configs.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

const BADGE: Record<FileStatus, string> = {
  onlyInBase: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  modified: 'border-orange-700/60 bg-orange-950/50 text-orange-300',
  binaryDiffers: 'border-violet-700/60 bg-violet-950/50 text-violet-300',
  tooLarge: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
  onlyInOther: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  cosmetic: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  identical: 'border-slate-600 bg-slate-800/60 text-slate-300',
};
const ICON: Record<FileStatus, string> = { onlyInBase: '⚠', modified: '≠', binaryDiffers: '◧', tooLarge: '▣', onlyInOther: '＋', cosmetic: '≈', identical: '=' };
const STATE_STYLE: Record<string, string> = {
  clean: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  launched: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  run: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
};
const GRID = 'grid grid-cols-[minmax(0,2.2fr)_minmax(0,2.2fr)_7.5rem_18rem]';
const VIRTUALIZE_ABOVE = 200;
const CONTEXT = 3;

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? 'border-violet-500 bg-violet-950/60 text-violet-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`;

const stateLabel = (s: string) => (['clean', 'launched', 'run'].includes(s) ? t(`configs.state.${s}` as MessageKey) : s);
const stateTip = (s: string) => (['clean', 'launched', 'run'].includes(s) ? t(`configs.stateTip.${s}` as MessageKey) : s);
const shortName = (p: Profile | undefined) => (p ? `${p.pack} ${p.version}` : '');
const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function fmtSize(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

/** Follows one scan job through the SSE stream, with polling as a safety net (missed event, no EventSource). */
function useScanJob(jobId: string | null, onEnd: (job: ScanJob) => void): ScanJob | null {
  const [job, setJob] = useState<ScanJob | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => {
    setJob(null);
    if (!jobId) return;
    let stopped = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      stopped = true;
      if (timer) clearInterval(timer);
      es?.close();
    };
    let last: ScanJob | null = null;
    const update = (j: ScanJob) => {
      if (stopped) return;
      const next: ScanJob = { status: j.status, progress: j.progress ?? last?.progress ?? null, message: j.message ?? last?.message ?? null };
      last = next;
      setJob(next);
      if (!['queued', 'running'].includes(j.status)) {
        stop();
        endRef.current(next);
      }
    };
    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/v1/events');
      es.addEventListener('job', (e) => {
        const j = JSON.parse((e as MessageEvent).data) as { id: string; status: ScanJob['status']; progress?: number; message?: string };
        if (j.id === jobId) update({ status: j.status, progress: j.progress ?? null, message: j.message ?? null });
      });
    }
    const poll = async () => {
      try {
        update(await configsApi.job(jobId));
      } catch (err) {
        // 401: the server restarted or the session expired; 404: the job is gone. Neither will recover by retrying.
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
          update({ status: 'failed', progress: null, message: err.status === 401 ? 'Session expirée : reconnecte-toi puis relance l’analyse.' : 'Analyse introuvable : relance-la.' });
        }
        // otherwise transient: the next tick retries
      }
    };
    void poll();
    timer = setInterval(() => void poll(), es ? 2000 : 500);
    return stop;
  }, [jobId]);
  return job;
}

export function ProfileCard(props: {
  label: string;
  profiles: Profile[];
  value: string;
  onChange: (v: string) => void;
  inv: UseQueryResult<ConfigInventory>;
}) {
  const { label, profiles, value, onChange, inv } = props;
  const qc = useQueryClient();
  const profile = profiles.find((p) => String(p.id) === value);
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const notScanned = inv.error instanceof ApiError && inv.error.status === 409;
  const refresh = () => qc.invalidateQueries({ queryKey: ['configs-inventory', value] });

  useEffect(() => {
    setJobId(null);
    setFailure(null);
  }, [value]);

  const job = useScanJob(jobId, (j) => {
    setJobId(null);
    if (j.status === 'done') void refresh();
    else setFailure(j.message ?? j.status);
  });
  const scan = useMutation({
    mutationFn: (v: { force: boolean; deep?: boolean }) => configsApi.scan(Number(value), v.force, v.deep ?? false),
    onMutate: () => setFailure(null),
    onSuccess: (r) => (r.jobId ? setJobId(r.jobId) : void refresh()),
    onError: (e: Error) => setFailure(e.message),
  });
  const busy = !!jobId || scan.isPending;
  const scanned = inv.data;

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <label className="block text-sm text-slate-300">{label}
        <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} mt-1 block w-full`}>
          <option value="">{t('configs.choose')}</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
        </select>
      </label>
      {profile && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span title={stateTip(profile.state)} className={`cursor-help rounded-full border px-2 py-0.5 ${STATE_STYLE[profile.state] ?? ''}`}>{stateLabel(profile.state)}</span>
          <span className="text-slate-400">{scanned ? tf('configs.scannedAt', { date: fmtDate(scanned.scannedAt) }) : notScanned ? t('configs.neverScanned') : ''}</span>
          {scanned && <span className="text-slate-400">· {tf('configs.fileCount', { n: String(scanned.total) })}</span>}
          {scanned && scanned.issueCount > 0 && (
            <span className="cursor-help text-amber-300" title={`${t('configs.issuesTip')}\n${scanned.issues.slice(0, 15).map((i) => `${i.path} : ${i.reason}`).join('\n')}`}>
              · {tf('configs.issues', { n: String(scanned.issueCount) })}
            </span>
          )}
          <button
            className={`${action} ml-auto`}
            disabled={busy}
            title={scanned ? t('configs.rescanTip') : t('configs.scanTip')}
            onClick={() => scan.mutate({ force: !!scanned })}
          >
            {scanned ? t('configs.rescan') : t('configs.scan')}
          </button>
          <button className={action} disabled={busy} title={t('configs.scanDeepTip')} onClick={() => scan.mutate({ force: true, deep: true })}>
            {t('configs.scanDeep')}
          </button>
        </div>
      )}
      {busy && (
        <div className="space-y-1" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-violet-500 transition-all" style={{ width: `${job?.progress ?? 0}%` }} />
          </div>
          <p className="truncate text-xs text-slate-400">
            {job?.status === 'queued' || !job ? t('configs.scanQueued') : t('configs.scanning')} {job?.progress != null ? `${job.progress} %` : ''} {job?.message ? `· ${job.message}` : ''}
          </p>
        </div>
      )}
      {failure && <p className="text-xs text-rose-300">{tf('configs.scanFailed', { msg: failure })}</p>}
      {inv.error && !notScanned && <p className="text-xs text-rose-300">{inv.error.message}</p>}
    </div>
  );
}

type Item = { kind: 'lines'; from: number; to: number } | { kind: 'gap'; from: number; to: number };

/** Splits the op list into visible lines and collapsible runs of unchanged lines (keeping CONTEXT lines around changes). */
export function collapseUnchanged(lines: DiffLine[], ctx = CONTEXT): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== 'equal') {
      let j = i;
      while (j < lines.length && lines[j]!.type !== 'equal') j++;
      items.push({ kind: 'lines', from: i, to: j });
      i = j;
      continue;
    }
    let e = i;
    while (e < lines.length && lines[e]!.type === 'equal') e++;
    const head = i === 0 ? 0 : ctx;
    const tail = e === lines.length ? 0 : ctx;
    if (e - i - head - tail >= 2) {
      if (head) items.push({ kind: 'lines', from: i, to: i + head });
      items.push({ kind: 'gap', from: i + head, to: e - tail });
      if (tail) items.push({ kind: 'lines', from: e - tail, to: e });
    } else items.push({ kind: 'lines', from: i, to: e });
    i = e;
  }
  return items;
}

const LINE_STYLE = { equal: 'text-slate-300', del: 'bg-rose-950/50 text-rose-200', add: 'bg-emerald-950/50 text-emerald-200' } as const;
const SIGN = { equal: ' ', del: '−', add: '+' } as const;

export function FileDiffView(props: { base: string; other: string; path: string; onCount: (path: string, n: number) => void }) {
  const { base, other, path, onCount } = props;
  const q = useQuery({ queryKey: ['configs-filediff', base, other, path], queryFn: () => configsApi.fileDiff(base, other, path), retry: false });
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const items = useMemo(() => collapseUnchanged(q.data?.lines ?? []), [q.data]);

  useEffect(() => {
    if (q.data && !q.data.binary && !q.data.tooLarge) onCount(path, q.data.added + q.data.removed);
  }, [q.data, path, onCount]);

  const box = 'mx-4 mb-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs';
  if (q.isLoading) return <p className={`${box} text-slate-400`}>{t('configs.diff.loading')}</p>;
  if (q.error) return <p className={`${box} text-rose-300`}>{tf('configs.diff.error', { msg: q.error.message })}</p>;
  const d = q.data!;
  if (d.binary) return <p className={`${box} text-slate-400`}>{d.tooLarge ? t('configs.diff.tooLarge') : t('configs.diff.binary')}</p>;
  if (d.tooLarge) return <p className={`${box} text-slate-400`}>{t('configs.diff.tooLarge')}</p>;

  const line = (l: DiffLine, k: number) => (
    <div key={k} className={`flex ${LINE_STYLE[l.type]}`} data-type={l.type}>
      <span className="w-12 shrink-0 select-none pr-2 text-right text-slate-600">{l.oldNo ?? ''}</span>
      <span className="w-12 shrink-0 select-none pr-2 text-right text-slate-600">{l.newNo ?? ''}</span>
      <span className="w-4 shrink-0 select-none" aria-hidden>{SIGN[l.type]}</span>
      <span className="min-w-0 whitespace-pre-wrap break-all">{l.text === '' ? ' ' : l.text}</span>
    </div>
  );

  return (
    <div className="mx-4 mb-3 space-y-1">
      {d.stale && <p className="text-xs text-amber-300">{t('configs.diff.stale')}</p>}
      {d.truncated && <p className="text-xs text-amber-300">{t('configs.diff.truncated')}</p>}
      {d.coarse && <p className="text-xs text-amber-300">{t('configs.diff.coarse')}</p>}
      {d.added + d.removed === 0 && <p className="text-xs text-slate-400">{t('configs.diff.same')}</p>}
      <div className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-950 py-1 font-mono text-xs" data-testid="file-diff">
        {items.map((it) =>
          it.kind === 'gap' && !opened.has(it.from) ? (
            <button
              key={`gap-${it.from}`}
              title={t('configs.diff.hiddenTip')}
              onClick={() => setOpened((s) => new Set(s).add(it.from))}
              className="block w-full bg-slate-900/70 px-3 py-0.5 text-left text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              {tf('configs.diff.hidden', { n: String(it.to - it.from) })}
            </button>
          ) : (
            d.lines.slice(it.from, it.to).map((l, k) => line(l, it.from + k))
          ),
        )}
      </div>
    </div>
  );
}

export function Configs() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const profiles = useMemo(() => flattenProfiles(matrix.data ?? []), [matrix.data]);
  const [baseId, setBaseId] = useState('');
  const [otherId, setOtherId] = useState('');
  const [status, setStatus] = useState<'all' | FileStatus>('all');
  const [root, setRoot] = useState<'all' | string>('all');
  const [search, setSearch] = useState('');
  const [showIdentical, setShowIdentical] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lineCounts, setLineCounts] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const invQuery = (id: string) => ({ queryKey: ['configs-inventory', id], queryFn: () => configsApi.inventory(id), enabled: !!id, retry: false });
  const baseInv = useQuery(invQuery(baseId));
  const otherInv = useQuery(invQuery(otherId));
  const ready = !!baseId && !!otherId && baseId !== otherId && baseInv.isSuccess && otherInv.isSuccess;

  const diff = useQuery({
    queryKey: ['configs-diff', baseId, otherId, baseInv.data?.scannedAt, otherInv.data?.scannedAt],
    queryFn: () => configsApi.diff(baseId, otherId),
    enabled: ready,
    retry: false,
  });
  const plan = useQuery({ queryKey: ['configs-plan', baseId, otherId], queryFn: () => configsApi.plan(baseId, otherId), enabled: ready });
  const planned = useMemo(() => new Set(plan.data?.paths ?? []), [plan.data]);

  useEffect(() => {
    setExpanded(new Set());
    setLineCounts({});
    setNotice(null);
  }, [baseId, otherId, diff.data]);

  const setPlan = useMutation({
    mutationFn: (v: { paths: string[]; selected: boolean }) => configsApi.setPlan(Number(baseId), Number(otherId), v.paths, v.selected),
    onMutate: () => setNotice(null),
    onSuccess: (r) => qc.setQueryData(['configs-plan', baseId, otherId], { paths: r.paths }),
    onError: (e: Error) => setNotice(tf('configs.plan.error', { msg: e.message })),
  });

  const base = profiles.find((p) => String(p.id) === baseId);
  const other = profiles.find((p) => String(p.id) === otherId);
  const a = shortName(base);
  const b = shortName(other);
  const vars = { a, b };
  const statusLabel = (st: FileStatus) => tf(`configs.status.${st}` as MessageKey, vars);
  const statusTip = (st: FileStatus) => tf(`configs.tip.${st}` as MessageKey, vars);
  const why = (f: ConfigDiffFile) =>
    f.status === 'modified' && lineCounts[f.path] !== undefined
      ? tf('configs.why.modifiedCount', { n: String(lineCounts[f.path]) })
      : tf(`configs.why.${f.status}` as MessageKey, vars);

  const onCount = useMemo(() => (path: string, n: number) => setLineCounts((c) => (c[path] === n ? c : { ...c, [path]: n })), []);

  const files = diff.data?.files ?? [];
  const needle = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      files.filter(
        (f) =>
          (status === 'all' ? showIdentical || f.status !== 'identical' : f.status === status) &&
          (root === 'all' || f.root === root) &&
          (!needle || f.path.toLowerCase().includes(needle)),
      ),
    [files, status, root, needle, showIdentical],
  );
  const perStatus = diff.data?.summary.perStatus;
  const rootCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [r, counts] of Object.entries(diff.data?.summary.perRoot ?? {})) {
      out[r] = Object.entries(counts).reduce((s, [st, n]) => s + (showIdentical || st !== 'identical' ? n : 0), 0);
    }
    return out;
  }, [diff.data, showIdentical]);
  const roots = [...TRACKED_ROOTS, ...Object.keys(rootCounts).filter((r) => !(TRACKED_ROOTS as readonly string[]).includes(r))].filter((r) => (rootCounts[r] ?? 0) > 0);
  const differing = perStatus ? FILE_STATUSES.filter((s) => s !== 'identical').reduce((s, st) => s + perStatus[st], 0) : 0;
  const selectable = rows.filter((f) => PLANNABLE_STATUSES.has(f.status) && !planned.has(f.path)).map((f) => f.path);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 52, overscan: 12 });

  const toggle = (path: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const planButton = (f: ConfigDiffFile) => {
    if (!PLANNABLE_STATUSES.has(f.status)) return null;
    const on = planned.has(f.path);
    return (
      <button
        className={on ? 'rounded-md border border-emerald-700/60 bg-emerald-950/50 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-900/50' : action}
        title={on ? tf('configs.plan.plannedTip', vars) : tf('configs.plan.tip', vars)}
        aria-pressed={on}
        aria-label={`${on ? t('configs.plan.planned') : tf('configs.plan.take', vars)} ${f.path}`}
        disabled={setPlan.isPending}
        onClick={() => setPlan.mutate({ paths: [f.path], selected: !on })}
      >
        {on ? t('configs.plan.planned') : tf('configs.plan.take', vars)}
      </button>
    );
  };

  const renderRow = (f: ConfigDiffFile, index: number, style?: CSSProperties) => {
    const slash = f.path.lastIndexOf('/');
    const open = expanded.has(f.path);
    return (
      <div key={f.path} data-index={index} ref={virtual ? virtualizer.measureElement : undefined} style={style} className="border-b border-slate-800" data-testid="config-row">
        <div className={`${GRID} items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-900/60`}>
          <span className="min-w-0 truncate font-mono text-xs" title={f.path}>
            <span className="text-slate-500">{f.path.slice(0, slash + 1)}</span>
            <span className="font-medium text-slate-100">{f.path.slice(slash + 1)}</span>
          </span>
          <span className="min-w-0">
            <span title={statusTip(f.status)} className={`inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${BADGE[f.status]}`}>
              <span aria-hidden>{ICON[f.status]}</span>{statusLabel(f.status)}
            </span>
            <span className="mt-0.5 block text-xs text-slate-300">{why(f)}</span>
          </span>
          <span className="text-xs text-slate-400" title={tf('configs.sizeTip', vars)}>{fmtSize(f.baseSize)} · {fmtSize(f.otherSize)}</span>
          <span className="flex justify-end gap-2 whitespace-nowrap">
            {f.status !== 'identical' && (
              <button className={action} title={tf('configs.detailsTip', vars)} aria-expanded={open} aria-label={`${open ? t('configs.hide') : t('configs.details')} ${f.path}`} onClick={() => toggle(f.path)}>
                {open ? t('configs.hide') : t('configs.details')}
              </button>
            )}
            {planButton(f)}
          </span>
        </div>
        {open && <FileDiffView base={baseId} other={otherId} path={f.path} onCount={onCount} />}
      </div>
    );
  };

  if (!matrix.data) return <p className="text-slate-400">{t('common.loading')}</p>;

  const bothScannedNeeded = !!baseId && !!otherId && baseId !== otherId && !ready && !baseInv.isLoading && !otherInv.isLoading;
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-100">{t('configs.title')}</h2>
        <p className="text-sm text-slate-400">{t('configs.intro')}</p>
      </div>
      {profiles.length === 0 ? (
        <p className="text-slate-400">{t('configs.noProfiles')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <ProfileCard label={t('configs.base')} profiles={profiles} value={baseId} onChange={setBaseId} inv={baseInv} />
          <ProfileCard label={t('configs.other')} profiles={profiles} value={otherId} onChange={setOtherId} inv={otherInv} />
        </div>
      )}

      {profiles.length > 0 && (!baseId || !otherId) && <p className="text-sm text-slate-400">{t('configs.pickBoth')}</p>}
      {baseId && baseId === otherId && <p className="text-sm text-slate-400">{t('configs.sameProfile')}</p>}
      {bothScannedNeeded && <p className="text-sm text-slate-400">{t('configs.scanBoth')}</p>}
      {base && other && base.id !== other.id && base.state !== other.state && (
        <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {tf('configs.stateMismatch', { a, b, sa: stateLabel(base.state), sb: stateLabel(other.state) })}
        </p>
      )}

      {ready && diff.isLoading && <p className="text-slate-400">{t('configs.loadingDiff')}</p>}
      {ready && diff.error && <p className="text-sm text-rose-300">{diff.error.message}</p>}
      {ready && diff.data && perStatus && (
        <>
          <p className="text-sm text-slate-400">{tf('configs.legend', vars)}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setStatus('all')} aria-pressed={status === 'all'} className={chip(status === 'all')}>
              {t('configs.filter.all')} · {showIdentical ? diff.data.total : differing}
            </button>
            {FILE_STATUSES.filter((st) => perStatus[st] > 0).map((st) => (
              <button key={st} title={statusTip(st)} onClick={() => setStatus(status === st ? 'all' : st)} aria-pressed={status === st} className={`rounded-full border px-3 py-1 text-xs ${BADGE[st]} ${status === st ? 'ring-2 ring-violet-500' : 'opacity-80 hover:opacity-100'}`}>
                {ICON[st]} {statusLabel(st)} · {perStatus[st]}
              </button>
            ))}
          </div>
          {roots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setRoot('all')} aria-pressed={root === 'all'} className={chip(root === 'all')}>{t('configs.filter.allRoots')}</button>
              {roots.map((r) => (
                <button key={r} title={tf('configs.filter.rootTip', { root: r })} onClick={() => setRoot(root === r ? 'all' : r)} aria-pressed={root === r} className={`${chip(root === r)} font-mono`}>
                  {r}/ · {rootCounts[r]}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <input aria-label={t('configs.search')} placeholder={t('configs.search')} value={search} onChange={(e) => setSearch(e.target.value)} className={`${field} min-w-64`} />
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={showIdentical} onChange={(e) => setShowIdentical(e.target.checked)} className="accent-violet-500" />
              {t('configs.showIdentical')}
            </label>
            <span className="ml-auto text-sm text-slate-400">{tf('configs.plan.count', { n: String(planned.size) })}</span>
            <button className={action} title={tf('configs.plan.selectAllTip', vars)} disabled={selectable.length === 0 || setPlan.isPending} onClick={() => setPlan.mutate({ paths: selectable, selected: true })}>
              {t('configs.plan.selectAll')}
            </button>
            <button className={action} title={t('configs.plan.clearTip')} disabled={planned.size === 0 || setPlan.isPending} onClick={() => setPlan.mutate({ paths: [...planned], selected: false })}>
              {t('configs.plan.clear')}
            </button>
          </div>
          {notice && <p className="text-sm text-rose-300">{notice}</p>}
          {diff.data.truncated && <p className="text-sm text-amber-300">{tf('configs.truncatedList', { shown: String(diff.data.files.length), total: String(diff.data.total) })}</p>}
          {differing === 0 && !showIdentical && status === 'all' ? (
            <p className="text-slate-400">{t('configs.noDiff')}</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800">
              <div className={`${GRID} gap-3 bg-slate-900 px-4 py-3 text-xs uppercase tracking-wide text-slate-400`}>
                <span>{t('configs.col.file')}</span>
                <span>{t('configs.col.status')}</span>
                <span title={tf('configs.sizeTip', vars)}>{t('configs.col.size')}</span>
                <span className="text-right">{t('configs.col.action')}</span>
              </div>
              {rows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-slate-400">{t('configs.noMatch')}</p>
              ) : virtual ? (
                <div ref={parentRef} className="max-h-[70vh] overflow-auto">
                  <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                    {virtualizer.getVirtualItems().map((v) => renderRow(rows[v.index]!, v.index, { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }))}
                  </div>
                </div>
              ) : (
                rows.map((f, i) => renderRow(f, i))
              )}
            </div>
          )}
          <p className="text-xs text-slate-500">{t('configs.limitation')}</p>
        </>
      )}
    </section>
  );
}
