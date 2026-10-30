import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow } from '../api.js';
import { settingsApi } from '../api-settings.js';
import { FINAL_STATES, testbenchApi, type RunState, type StopOutcome } from '../api-testbench.js';
import { ClaudeActions } from '../components/ClaudeActions.js';
import { ClientLogs } from '../components/ClientLogs.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = 'rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50';

const STATE_STYLE: Record<RunState, string> = {
  queued: 'border-slate-600 bg-slate-800/60 text-slate-300',
  copying: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  starting: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  ready: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  stopping: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  done: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  failed: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  timeout: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
  crashed: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  interrupted: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
};

const isFinal = (s: RunState) => FINAL_STATES.includes(s);
const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('fr-FR');
  } catch {
    return iso;
  }
};

function StatePill({ status }: { status: RunState }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${STATE_STYLE[status] ?? STATE_STYLE.queued}`}>{t(`testbench.status.${status}` as MessageKey)}</span>;
}

const STOP_STYLE: Record<StopOutcome, string> = { clean: 'text-slate-400', forced: 'text-amber-300', 'exited-early': 'text-amber-300' };

function QueryError(props: { text: string; onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-rose-300">
      {props.text}
      <button className={action} onClick={props.onRetry}>{t('testbench.error.retry')}</button>
    </p>
  );
}

function RunDetailPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const run = useQuery({ queryKey: ['testbench-run', id], queryFn: () => testbenchApi.run(id), refetchInterval: (q) => (q.state.status === 'error' || (q.state.data && isFinal(q.state.data.status)) ? false : 2000) });
  const running = !!run.data && !isFinal(run.data.status);
  const log = useQuery({ queryKey: ['testbench-log', id], queryFn: () => testbenchApi.log(id), refetchInterval: running ? 2000 : false });
  const cancel = useMutation({ mutationFn: () => testbenchApi.cancel(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['testbench-run', id] }) });
  if (run.isError) return <QueryError text={tf('testbench.error.run', { msg: run.error.message })} onRetry={() => void run.refetch()} />;
  if (!run.data) return null;
  const d = run.data;
  const r = d.result;
  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-100">{t('testbench.detail')} · {d.meta.label}</h3>
        <span className="flex items-center gap-2">
          <StatePill status={d.status} />
          <button className={action} title={t('testbench.cancelTip')} disabled={!running || cancel.isPending} onClick={() => cancel.mutate()}>{t('testbench.cancel')}</button>
        </span>
      </div>
      {d.message && <p className="text-sm text-amber-300">{d.message}</p>}
      {cancel.isError && <p role="alert" className="text-sm text-rose-300">{cancel.error.message}</p>}
      {r?.stopOutcome && STOP_STYLE[r.stopOutcome] && <p role={r.stopOutcome === 'clean' ? undefined : 'status'} className={`text-sm ${STOP_STYLE[r.stopOutcome]}`}>{t(`testbench.stop.${r.stopOutcome}` as MessageKey)}</p>}
      {r && (
        <p className="text-sm text-slate-300">
          {r.bootSeconds !== null && `${tf('testbench.boot', { s: String(r.bootSeconds) })} · `}
          {tf('testbench.mods', { n: String(r.modJars) })} · {tf('testbench.errors', { n: String(r.summary.errorLines) })} · {tf('testbench.warns', { n: String(r.summary.warnLines) })}
        </p>
      )}
      {r && r.crashReports.length > 0 && <p className="text-sm text-rose-300">{tf('testbench.crashFiles', { list: r.crashReports.join(', ') })}</p>}
      {r && r.summary.firstErrors.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs uppercase tracking-wide text-slate-400">{t('testbench.firstErrors')}</h4>
          <ul className="space-y-0.5 font-mono text-xs text-rose-200">{r.summary.firstErrors.map((e) => <li key={e} className="break-words">{e}</li>)}</ul>
        </div>
      )}
      <div className="space-y-1">
        <h4 className="text-xs uppercase tracking-wide text-slate-400">{t('testbench.log')}</h4>
        <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-slate-300">{log.data && log.data.lines.length ? log.data.lines.join('\n') : t('testbench.logEmpty')}</pre>
        <p className="text-xs text-slate-500">{tf('testbench.where', { id })}</p>
      </div>
      {r && (
        <>
          <p className="text-xs text-slate-500">{t('testbench.claudeHint')}</p>
          <ClaudeActions base={null} other={null} runId={id} actions={['analyze-test-run']} />
        </>
      )}
    </section>
  );
}

/** Throwaway server tests: start a copy of a server, keep its logs, and ask Claude to read them. */
export function TestBench() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const runs = useQuery({ queryKey: ['testbench-runs'], queryFn: testbenchApi.runs, refetchInterval: (q) => (q.state.status !== 'error' && q.state.data?.some((r) => !isFinal(r.status)) ? 3000 : false) });
  const servers = useMemo(() => flattenProfiles(matrix.data ?? []).filter((p) => p.side === 'server' && (p.locationKind === 'folder' || p.locationKind === 'smb')), [matrix.data]);

  const [profile, setProfile] = useState('');
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const preset = (key: string, fallback: number): number => {
    const v = settings.data?.limits?.find((l) => l.key === key)?.value;
    return typeof v === 'number' ? v : fallback;
  };
  const [memoryEdit, setMemoryMb] = useState<number | null>(null);
  const [portEdit, setPort] = useState<number | null>(null);
  const [timeoutEdit, setTimeoutMin] = useState<number | null>(null);
  const memoryMb = memoryEdit ?? preset('testbench.defaultMemoryMb', 8192);
  const port = portEdit ?? preset('testbench.defaultPort', 25570);
  const timeoutMin = timeoutEdit ?? preset('testbench.defaultTimeoutMinutes', 10);
  const [acceptEula, setAcceptEula] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const start = useMutation({
    mutationFn: () => testbenchApi.start({ profile: Number(profile), acceptEula, memoryMb, port, timeoutMin }),
    onMutate: () => setNote(null),
    onSuccess: (r) => {
      setNote({ kind: 'ok', text: t('testbench.started') });
      setSelected(r.runId);
      void qc.invalidateQueries({ queryKey: ['testbench-runs'] });
    },
    onError: (e: Error) => setNote({ kind: 'err', text: e.message }),
  });

  const num = (set: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(Number(e.target.value));
  const list = runs.data ?? [];
  const current = selected ?? list[0]?.id ?? null;

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('testbench.title')}</h2>
      <p className="max-w-3xl text-sm text-slate-400">{t('testbench.intro')}</p>

      <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        {matrix.isError && <QueryError text={tf('testbench.error.matrix', { msg: matrix.error.message })} onRetry={() => void matrix.refetch()} />}
        {matrix.data && servers.length === 0 && <p className="text-sm text-amber-300">{t('testbench.noServer')}</p>}
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm text-slate-300">{t('testbench.profile')}
            <select value={profile} onChange={(e) => setProfile(e.target.value)} className={`${field} mt-1 block min-w-64`}>
              <option value="">{t('testbench.choose')}</option>
              {servers.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-300" title={t('testbench.memoryTip')}>{t('testbench.memory')}
            <input type="number" min={1024} max={65536} step={1024} value={memoryMb} onChange={num(setMemoryMb)} className={`${field} mt-1 block w-28`} />
          </label>
          <label className="text-sm text-slate-300" title={t('testbench.portTip')}>{t('testbench.port')}
            <input type="number" min={1024} max={65535} value={port} onChange={num(setPort)} className={`${field} mt-1 block w-24`} />
          </label>
          <label className="text-sm text-slate-300" title={t('testbench.timeoutTip')}>{t('testbench.timeout')}
            <input type="number" min={1} max={60} value={timeoutMin} onChange={num(setTimeoutMin)} className={`${field} mt-1 block w-24`} />
          </label>
          <button className={primary} disabled={!profile || start.isPending} title={t('testbench.startTip')} onClick={() => start.mutate()}>{t('testbench.start')}</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={acceptEula} onChange={(e) => setAcceptEula(e.target.checked)} />
          {t('testbench.eula')}
        </label>
        {note && <p role="status" className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{note.text}</p>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-200">{t('testbench.runs')}</h3>
        {runs.isError && <QueryError text={tf('testbench.error.runs', { msg: runs.error.message })} onRetry={() => void runs.refetch()} />}
        {list.length === 0 && !runs.isError && !runs.isLoading && <p className="text-sm text-slate-500">{t('testbench.noRuns')}</p>}
        <ul className="space-y-1.5">
          {list.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSelected(r.id)} aria-current={current === r.id} className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm ${current === r.id ? 'border-violet-600 bg-slate-900' : 'border-slate-800 bg-slate-900/40 hover:bg-slate-900'}`}>
                <span className="min-w-0 truncate text-slate-200">{r.label}<span className="ml-2 text-xs text-slate-500">{fmtDate(r.createdAt)}</span></span>
                <span className="flex items-center gap-3 text-xs text-slate-400">
                  {r.bootSeconds !== null && <span>{tf('testbench.boot', { s: String(r.bootSeconds) })}</span>}
                  {r.errorLines ? <span className="text-rose-300">{tf('testbench.errors', { n: String(r.errorLines) })}</span> : null}
                  {r.crashReports > 0 && <span className="text-rose-300">{tf('testbench.crashes', { n: String(r.crashReports) })}</span>}
                  <StatePill status={r.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {current && <RunDetailPanel key={current} id={current} />}

      <ClientLogs />
    </section>
  );
}
