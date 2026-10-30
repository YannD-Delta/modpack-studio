import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  getAudit,
  getDebugInfo,
  getJobs,
  getMemory,
  JOB_STATUSES,
  removeBlacklistEntry,
  setBlacklistReason,
  setDecisionReason,
  unsetDecision,
  type AuditEntry,
  type DebugInfo,
  type DecisionKind,
  type JobRow,
  type JobStatus,
} from '../api-decisions.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

export const JOBS_REFRESH_MS = 5000;
const AUDIT_PAGE = 100;

type Section = DecisionKind | 'blacklist';
const SECTIONS: Section[] = ['pin', 'ignore', 'side', 'blacklist'];
// Caches of other pages that read decisions or the blacklist: refreshed so an undo shows up there at once.
const AFFECTED_QUERIES = ['decisions', 'debug', 'blacklist', 'diff', 'anomalies', 'blockers'];

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40';
const badge = 'inline-flex cursor-help items-center rounded-full border px-2 py-0.5 text-xs';
const card = 'overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40';

const SIDE_BADGE = { client: 'border-sky-700/60 bg-sky-950/50 text-sky-300', server: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300', both: 'border-slate-600 bg-slate-800/60 text-slate-300' };
const JOB_BADGE: Record<JobStatus, string> = {
  queued: 'border-slate-600 bg-slate-800/60 text-slate-300',
  running: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  done: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  failed: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  cancelled: 'border-slate-600 bg-slate-800/60 text-slate-400',
  interrupted: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
};

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
};
const oneDecimal = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${oneDecimal(n / 1024)} Kio`;
  if (n < 1024 ** 3) return `${oneDecimal(n / 1024 ** 2)} Mio`;
  return `${oneDecimal(n / 1024 ** 3)} Gio`;
}

export function formatUptime(total: number): string {
  const parts: [number, string][] = [
    [Math.floor(total / 86400), 'j'],
    [Math.floor((total % 86400) / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'min'],
    [total % 60, 's'],
  ];
  const shown = parts.filter(([v]) => v > 0).map(([v, u]) => `${v} ${u}`);
  return shown.length ? shown.join(' ') : '0 s';
}

const errorText = (err: unknown) => tf('decisions.error', { message: err instanceof Error ? err.message : String(err) });

/** One remembered item: id, optional badge, editable reason, date, and an undo guarded by an inline confirmation. */
function MemoryRow(props: { modId: string; reason: string; createdAt: string | null; badge?: ReactNode; undoTip: string; onUndo: () => Promise<unknown>; onSaveReason: (reason: string) => Promise<unknown> }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.reason);
  const refresh = () => Promise.all(AFFECTED_QUERIES.map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const undo = useMutation({ mutationFn: props.onUndo, onSuccess: refresh, onSettled: () => setConfirming(false) });
  const save = useMutation({
    mutationFn: props.onSaveReason,
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });

  return (
    <li className="space-y-1 px-4 py-2.5 text-sm hover:bg-slate-900/60">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-mono text-slate-100">{props.modId}</span>
        {props.badge}
        {props.createdAt ? (
          <span className="ml-auto text-xs text-slate-500" title={t('decisions.dateTip')}>{tf('decisions.date', { date: fmtDate(props.createdAt) })}</span>
        ) : (
          <span className="ml-auto text-xs italic text-slate-500" title={t('decisions.dateUnknownTip')}>{t('decisions.dateUnknown')}</span>
        )}
        <span className="flex items-center gap-2">
          {confirming ? (
            <>
              <button type="button" disabled={undo.isPending} onClick={() => undo.mutate()} title={t('decisions.confirmTip')} className="rounded-md border border-rose-700/70 bg-rose-900/60 px-2 py-0.5 text-xs font-medium text-rose-100 hover:bg-rose-800 disabled:opacity-40">
                {t('decisions.confirm')}
              </button>
              <button type="button" onClick={() => setConfirming(false)} title={t('decisions.keepTip')} className={action}>{t('decisions.keep')}</button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                undo.reset();
                setConfirming(true);
              }}
              title={props.undoTip}
              aria-label={`${t('decisions.undo')} ${props.modId}`}
              className={action}
            >
              {t('decisions.undo')}
            </button>
          )}
        </span>
      </div>
      <div className="min-w-0">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            <input aria-label={t('decisions.reasonLabel')} value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} className={`${field} min-w-0 flex-1 py-1`} autoFocus />
            <button type="submit" disabled={save.isPending} className={action} title={t('decisions.reasonSaveTip')}>{t('decisions.reasonSave')}</button>
            <button
              type="button"
              className={action}
              title={t('decisions.reasonCloseTip')}
              onClick={() => {
                setDraft(props.reason);
                setEditing(false);
                save.reset();
              }}
            >
              {t('decisions.reasonClose')}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(props.reason);
              setEditing(true);
            }}
            title={t('decisions.reasonTip')}
            className={`max-w-full truncate rounded px-1 text-left hover:bg-slate-800 ${props.reason ? 'text-slate-300' : 'italic text-slate-500'}`}
          >
            {props.reason || t('decisions.noReason')}
          </button>
        )}
      </div>
      {(undo.isError || save.isError) && <p className="text-xs text-rose-300">{errorText(undo.error ?? save.error)}</p>}
    </li>
  );
}

function MemorySection({ kind, count, children, footer }: { kind: Section; count: number; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={card}>
      <h3 className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-100" title={t(`decisions.sectionTip.${kind}` as MessageKey)}>
        {t(`decisions.section.${kind}` as MessageKey)}
        <span data-badge className={`${badge} border-slate-700 text-slate-400`} title={t('decisions.countTip')}>{count}</span>
      </h3>
      {count === 0 ? <p className="px-4 py-3 text-sm text-slate-500">{t(`decisions.empty.${kind}` as MessageKey)}</p> : <ul className="divide-y divide-slate-800">{children}</ul>}
      {footer}
    </div>
  );
}

function Memory() {
  const memory = useQuery({ queryKey: ['decisions'], queryFn: getMemory });
  if (memory.isError) return <p className="text-sm text-rose-300">{errorText(memory.error)}</p>;
  if (!memory.data) return <p className="text-slate-400">{t('common.loading')}</p>;
  const { decisions, blacklist, upstreamDerivedCount } = memory.data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {SECTIONS.map((kind) => {
        if (kind === 'blacklist') {
          return (
            <MemorySection
              key={kind}
              kind={kind}
              count={blacklist.length}
              footer={
                upstreamDerivedCount > 0 && (
                  <p data-badge className="cursor-help border-t border-slate-800 px-4 py-2 text-xs text-slate-500" title={t('decisions.upstreamDerivedTip')}>
                    {tf('decisions.upstreamDerived', { n: String(upstreamDerivedCount) })}
                  </p>
                )
              }
            >
              {blacklist.map((b) => (
                <MemoryRow
                  key={b.modId}
                  modId={b.modId}
                  reason={b.reason}
                  createdAt={b.createdAt}
                  undoTip={t('decisions.undoTip.blacklist')}
                  onUndo={() => removeBlacklistEntry(b.modId)}
                  onSaveReason={(r) => setBlacklistReason(b.modId, r)}
                />
              ))}
            </MemorySection>
          );
        }
        const rows = decisions.filter((d) => d.kind === kind);
        return (
          <MemorySection key={kind} kind={kind} count={rows.length}>
            {rows.map((d) => (
              <MemoryRow
                key={d.modId}
                modId={d.modId}
                reason={d.reason}
                createdAt={d.createdAt}
                badge={
                  d.side && (
                    <span data-badge className={`${badge} ${SIDE_BADGE[d.side]}`} title={t(`decisions.sideTip.${d.side}` as MessageKey)}>
                      {t(`decisions.side.${d.side}` as MessageKey)}
                    </span>
                  )
                }
                undoTip={t(`decisions.undoTip.${kind}` as MessageKey)}
                onUndo={() => unsetDecision(d.modId, kind)}
                onSaveReason={(r) => setDecisionReason(d.modId, kind, r)}
              />
            ))}
          </MemorySection>
        );
      })}
    </div>
  );
}

function InfoPanel() {
  const info = useQuery({ queryKey: ['debug', 'info'], queryFn: getDebugInfo });
  const [copy, setCopy] = useState<'idle' | 'ok' | 'failed'>('idle');
  if (info.isError) return <p className="text-sm text-rose-300">{errorText(info.error)}</p>;
  if (!info.data) return <p className="text-slate-400">{t('common.loading')}</p>;
  const d: DebugInfo = info.data;
  const c = d.counts;
  const items: [MessageKey, string][] = [
    ['debug.info.studioVersion', d.studioVersion],
    ['debug.info.node', d.node],
    ['debug.info.platform', d.platform],
    ['debug.info.uptime', formatUptime(d.uptimeSeconds)],
    ['debug.info.dataDir', d.dataDir],
    ['debug.info.dbFile', d.db.file ?? t('debug.info.memoryDb')],
    ['debug.info.dbSize', d.db.sizeBytes === null ? '—' : formatBytes(d.db.sizeBytes)],
    ['debug.info.migrations', String(d.db.migrations)],
    ['debug.info.profiles', String(c.profiles)],
    ['debug.info.jars', String(c.jars)],
    ['debug.info.modRows', String(c.modRows)],
    ['debug.info.decisions', tf('debug.info.decisionsValue', { pin: String(c.decisions.pin), ignore: String(c.decisions.ignore), side: String(c.decisions.side) })],
    ['debug.info.blacklist', tf('debug.info.blacklistValue', { user: String(c.blacklist.user), derived: String(c.blacklist.upstreamDerived) })],
    ['debug.info.jobs', JOB_STATUSES.filter((s) => c.jobs[s] > 0).map((s) => `${c.jobs[s]} ${t(`debug.job.status.${s}` as MessageKey)}`).join(' · ') || '0'],
    ['debug.info.auditEntries', String(c.auditEntries)],
  ];

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
      setCopy('ok');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button type="button" onClick={doCopy} title={t('debug.copyTip')} className={action}>{t('debug.copy')}</button>
        {copy === 'ok' && <span className="text-xs text-emerald-400">{t('debug.copied')}</span>}
        {copy === 'failed' && <span className="text-xs text-rose-300">{t('debug.copyFailed')}</span>}
      </div>
      <dl className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-400">{t(k)}</dt>
            <dd className="break-all font-mono text-slate-100">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AuditRow({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const text = e.payloadValid ? JSON.stringify(e.payload, null, 2) : String(e.payload);
  return (
    <li className="px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-slate-500" title={t('debug.timeTip')}>{fmtDate(e.at)}</span>
        <span data-badge className={`${badge} border-violet-700/60 bg-violet-950/50 font-mono text-violet-300`} title={t('debug.actionTip')}>{e.action}</span>
        <span className="font-mono text-slate-100" title={t('debug.targetTip')}>{e.target ?? t('debug.noTarget')}</span>
        <span className="text-xs text-slate-500" title={t('debug.actorTip')}>{e.actor}</span>
        {!e.payloadValid && <span data-badge className={`${badge} border-amber-700/60 bg-amber-950/50 text-amber-300`} title={t('debug.payloadInvalidTip')}>{t('debug.payloadInvalid')}</span>}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={t('debug.payloadTip')} className={`${action} ml-auto`}>
          {open ? t('debug.payloadHide') : t('debug.payload')}
        </button>
      </div>
      {open && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-300">{text}</pre>}
    </li>
  );
}

function AuditPanel() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const audit = useInfiniteQuery({
    queryKey: ['debug', 'audit', q],
    queryFn: ({ pageParam }) => getAudit({ limit: AUDIT_PAGE, before: pageParam, q: q || undefined }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = audit.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input aria-label={t('debug.search')} placeholder={t('debug.searchPlaceholder')} title={t('debug.searchTip')} value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} className={`${field} w-72`} />
        <button type="submit" className={action} title={t('debug.searchTip')}>{t('debug.searchGo')}</button>
      </form>
      {audit.isError && <p className="text-sm text-rose-300">{errorText(audit.error)}</p>}
      {audit.isLoading && <p className="text-slate-400">{t('common.loading')}</p>}
      {audit.data && entries.length === 0 && <p className="text-sm text-slate-500">{t('debug.auditEmpty')}</p>}
      {entries.length > 0 && <ul className={`${card} divide-y divide-slate-800`}>{entries.map((e) => <AuditRow key={e.id} e={e} />)}</ul>}
      {audit.hasNextPage && (
        <button type="button" disabled={audit.isFetchingNextPage} onClick={() => audit.fetchNextPage()} title={t('debug.loadMoreTip')} className={action}>
          {t('debug.loadMore')}
        </button>
      )}
    </div>
  );
}

function JobItem({ j }: { j: JobRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-1.5 px-4 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span data-badge className={`${badge} ${JOB_BADGE[j.status]}`} title={t(`debug.job.statusTip.${j.status}` as MessageKey)}>{t(`debug.job.status.${j.status}` as MessageKey)}</span>
        <span className="font-mono text-slate-100">{j.type}</span>
        <span className="font-mono text-xs text-slate-500">{j.id}</span>
        {j.lockKey && <span data-badge className={`${badge} border-slate-700 font-mono text-slate-400`} title={t('debug.job.lockTip')}>{j.lockKey}</span>}
        <span className="ml-auto text-xs text-slate-500" title={t('debug.job.datesTip')}>
          {tf('debug.job.created', { date: fmtDate(j.createdAt) })} · {tf('debug.job.updated', { date: fmtDate(j.updatedAt) })}
        </span>
      </div>
      {j.progress !== null && (
        <div className="flex items-center gap-2" title={t('debug.job.progressTip')}>
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-800">
            <div className={`h-full ${j.status === 'failed' ? 'bg-rose-500' : 'bg-violet-500'}`} style={{ width: `${Math.max(0, Math.min(100, j.progress))}%` }} />
          </div>
          <span className="text-xs text-slate-400">{Math.round(j.progress)} %</span>
        </div>
      )}
      {j.message && <p className={`whitespace-pre-wrap break-words ${j.status === 'failed' ? 'font-medium text-rose-300' : 'text-slate-300'}`}>{j.message}</p>}
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={t('debug.job.paramsTip')} className={action}>
        {t('debug.job.params')}
      </button>
      {open && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-300">
          {j.params}
          {j.paramsTruncated && `\n${t('debug.job.paramsTruncated')}`}
        </pre>
      )}
    </li>
  );
}

function JobsPanel({ jobs, error, status, setStatus }: { jobs: JobRow[] | undefined; error: unknown; status: JobStatus | ''; setStatus: (s: JobStatus | '') => void }) {
  return (
    <div className="space-y-3">
      <label className="text-sm text-slate-300" title={t('debug.jobsFilterTip')}>{t('debug.jobsFilter')}
        <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | '')} className={`${field} ml-2`}>
          <option value="">{t('debug.jobsAll')}</option>
          {JOB_STATUSES.map((s) => <option key={s} value={s}>{t(`debug.job.status.${s}` as MessageKey)}</option>)}
        </select>
      </label>
      {error ? <p className="text-sm text-rose-300">{errorText(error)}</p> : null}
      {!jobs && !error && <p className="text-slate-400">{t('common.loading')}</p>}
      {jobs?.length === 0 && <p className="text-sm text-slate-500">{t('debug.jobsEmpty')}</p>}
      {jobs && jobs.length > 0 && <ul data-testid="jobs" className={`${card} divide-y divide-slate-800`}>{jobs.map((j) => <JobItem key={j.id} j={j} />)}</ul>}
    </div>
  );
}

type DebugTab = 'info' | 'audit' | 'jobs';
const DEBUG_TABS: DebugTab[] = ['info', 'audit', 'jobs'];

function Debug() {
  const [tab, setTab] = useState<DebugTab>('info');
  const [status, setStatus] = useState<JobStatus | ''>('');
  // Polled at page level, whichever tab is shown, so the failed count on the tab stays current.
  const jobs = useQuery({ queryKey: ['debug', 'jobs', status], queryFn: () => getJobs(status || undefined), refetchInterval: JOBS_REFRESH_MS });
  const failed = jobs.data?.jobs.filter((j) => j.status === 'failed').length ?? 0;

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-slate-100">{t('debug.title')}</h3>
        <p className="text-sm text-slate-400">{t('debug.intro')}</p>
      </div>
      <nav className="flex w-fit gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
        {DEBUG_TABS.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            aria-current={tab === x}
            title={t(`debug.tabTip.${x}` as MessageKey)}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm transition ${tab === x ? 'bg-violet-600 text-white shadow' : 'text-slate-400 hover:text-slate-100'}`}
          >
            {t(`debug.tab.${x}` as MessageKey)}
            {x === 'jobs' && failed > 0 && (
              <span data-badge className={`${badge} border-rose-700/60 bg-rose-950/70 text-rose-200`} title={t('debug.failedCountTip')}>
                {tf('debug.failedCount', { n: String(failed) })}
              </span>
            )}
          </button>
        ))}
      </nav>
      {tab === 'info' && <InfoPanel />}
      {tab === 'audit' && <AuditPanel />}
      {tab === 'jobs' && <JobsPanel jobs={jobs.data?.jobs} error={jobs.error} status={status} setStatus={setStatus} />}
    </section>
  );
}

export function Decisions() {
  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-100">{t('decisions.title')}</h2>
        <p className="max-w-3xl text-sm text-slate-400">{t('decisions.intro')}</p>
      </div>
      <Memory />
      <Debug />
    </section>
  );
}
