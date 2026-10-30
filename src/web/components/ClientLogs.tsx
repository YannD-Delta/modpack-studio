import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow } from '../api.js';
import { buildApi } from '../api-build.js';
import { t, tf } from '../i18n/index.js';
import { ErrorNotice } from './ErrorNotice.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';

/** Card that summarises the logs of a client instance run by hand (candidate or run profile), errors first. */
export function ClientLogs() {
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const clients = useMemo(
    () => flattenProfiles(matrix.data ?? []).filter((p) => p.side === 'client' && (p.state === 'candidate' || p.state === 'run') && (p.locationKind === 'folder' || p.locationKind === 'smb')),
    [matrix.data],
  );
  const [profile, setProfile] = useState('');
  const read = useMutation({ mutationFn: () => buildApi.clientLogs(Number(profile)) });
  const [copied, setCopied] = useState(false);
  const copy = useMutation({
    mutationFn: async () => {
      const { prompt } = await buildApi.clientPrompt(Number(profile));
      await navigator.clipboard.writeText(prompt);
    },
    onSuccess: () => setCopied(true),
  });
  const d = read.data;
  const found = d?.log.markers.filter((m) => m.line !== null).length ?? 0;

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <h3 className="text-sm font-semibold text-slate-200">{t('build.clientLogs.title')}</h3>
      <p className="max-w-3xl text-xs text-slate-400">{t('build.clientLogs.intro')}</p>
      {matrix.data && clients.length === 0 && <p className="text-sm text-amber-300">{t('build.clientLogs.noClient')}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-300">{t('build.clientLogs.profile')}
          <select value={profile} onChange={(e) => { setProfile(e.target.value); setCopied(false); }} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('build.clientLogs.choose')}</option>
            {clients.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        <button className={action} disabled={!profile || read.isPending} onClick={() => { setCopied(false); read.mutate(); }}>{t('build.clientLogs.read')}</button>
      </div>
      {read.isError && <ErrorNotice error={read.error} />}
      {d && (
        <div className="space-y-3 text-sm text-slate-300">
          {!d.log.present ? (
            <p className="text-amber-300">{t('build.clientLogs.noLog')}</p>
          ) : (
            <p>{tf('build.clientLogs.counts', { lines: String(d.log.lines), cut: d.log.truncated ? t('build.clientLogs.cut') : '', errors: String(d.log.errorLines), warns: String(d.log.warnLines) })}</p>
          )}
          <div className="space-y-1">
            <h4 className="text-xs uppercase tracking-wide text-slate-400">{t('build.clientLogs.crashes')}</h4>
            {d.crashReports.length === 0 && <p className="text-xs text-slate-500">{t('build.clientLogs.noCrash')}</p>}
            <ul className="space-y-0.5 text-xs text-rose-200">{d.crashReports.map((c) => <li key={c.name} className="break-words"><span className="font-mono">{c.name}</span> : {c.headline ?? '?'}</li>)}</ul>
          </div>
          {d.log.firstErrors.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs uppercase tracking-wide text-slate-400">{t('build.clientLogs.firstErrors')}</h4>
              <ul className="space-y-0.5 font-mono text-xs text-rose-200">{d.log.firstErrors.map((e) => <li key={e} className="break-words">{e}</li>)}</ul>
            </div>
          )}
          {d.log.present && (
            <div className="space-y-1">
              <p className={`text-xs ${d.log.reachedAllMarkers ? 'text-emerald-300' : 'text-amber-300'}`}>{d.log.reachedAllMarkers ? t('build.clientLogs.loaded') : t('build.clientLogs.notLoaded')}</p>
              <p className="text-xs text-slate-400">{tf('build.clientLogs.markers', { found: String(found), total: String(d.log.markers.length) })}</p>
              <ul className="space-y-0.5 font-mono text-xs text-slate-500">
                {d.log.markers.map((m) => <li key={m.pattern}>{m.pattern} : {m.line === null ? t('build.clientLogs.markerMissing') : tf('build.clientLogs.markerFound', { n: String(m.line) })}</li>)}
              </ul>
            </div>
          )}
          <div className="space-y-1 text-xs text-slate-400">
            <p>{tf('build.clientLogs.mods', { n: String(d.mods.count) })}</p>
            {!d.mods.imported && <p className="text-amber-300">{t('build.clientLogs.notImported')}</p>}
            {d.mods.onlyInInstance.length > 0 && <p className="break-words text-amber-300">{tf('build.clientLogs.onlyInstance', { list: d.mods.onlyInInstance.join(', ') })}</p>}
            {d.mods.onlyInImport.length > 0 && <p className="break-words text-amber-300">{tf('build.clientLogs.onlyImport', { list: d.mods.onlyInImport.join(', ') })}</p>}
          </div>
          <div className="flex items-center gap-3">
            <button className={action} disabled={copy.isPending} onClick={() => copy.mutate()}>{t('build.clientLogs.claude')}</button>
            {copied && <span role="status" className="text-xs text-emerald-400">{t('build.clientLogs.copied')}</span>}
            {copy.isError && <ErrorNotice error={copy.error} />}
          </div>
        </div>
      )}
    </div>
  );
}
