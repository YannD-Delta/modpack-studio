import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow } from '../api.js';
import { buildApi, undecidedOf, type PackSide } from '../api-build.js';
import { t, tf } from '../i18n/index.js';
import { ErrorNotice } from './ErrorNotice.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';

/** Card that builds a server pack zip from a server profile folder. */
export function ServerPack() {
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const servers = useMemo(() => flattenProfiles(matrix.data ?? []).filter((p) => p.side === 'server' && (p.locationKind === 'folder' || p.locationKind === 'smb')), [matrix.data]);
  const [profile, setProfile] = useState('');
  const build = useMutation({ mutationFn: (includeUnknown?: boolean) => buildApi.serverPack(Number(profile), includeUnknown) });
  const decide = useMutation({
    mutationFn: (v: { modId: string; side: PackSide }) => buildApi.decideSide(v.modId, v.side, t('build.serverPack.decisionReason')),
    // the side is saved, so ask for the pack again: the list shrinks until nothing is left to decide
    onSuccess: () => build.mutate(undefined),
  });
  const undecided = undecidedOf(build.error);
  const sides: PackSide[] = ['server', 'client', 'both'];
  const r = build.data;

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <h3 className="text-sm font-semibold text-slate-200">{t('build.serverPack.title')}</h3>
      <p className="max-w-3xl text-xs text-slate-400">{t('build.serverPack.intro')}</p>
      {matrix.data && servers.length === 0 && <p className="text-sm text-amber-300">{t('build.serverPack.noServer')}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-300">{t('build.serverPack.profile')}
          <select value={profile} onChange={(e) => setProfile(e.target.value)} className={`${field} mt-1 block min-w-64`}>
            <option value="">{t('build.serverPack.choose')}</option>
            {servers.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
          </select>
        </label>
        <button className="rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50" disabled={!profile || build.isPending} onClick={() => build.mutate(undefined)}>
          {build.isPending ? t('build.serverPack.building') : t('build.serverPack.build')}
        </button>
      </div>
      {build.isError && !undecided && <ErrorNotice error={build.error} />}
      <ErrorNotice error={decide.error} />
      {undecided && (
        <div className="space-y-2 rounded-lg border border-amber-700/60 bg-amber-950/20 p-3" role="alert">
          <p className="text-sm text-amber-300">{tf('build.serverPack.undecided', { n: String(undecided.length) })}</p>
          <ul className="space-y-1.5 text-xs text-slate-300">
            {undecided.map((u) => (
              <li key={`${u.modId}:${u.file}`} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{u.modId}</span>
                <span className="text-slate-500">{u.file}</span>
                {sides.map((side) => (
                  <button key={side} className="rounded-md border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:border-violet-500 disabled:opacity-50" disabled={decide.isPending || build.isPending} aria-label={tf('build.serverPack.decideAria', { side: t(`build.serverPack.side.${side}`), id: u.modId })} onClick={() => decide.mutate({ modId: u.modId, side })}>
                    {t(`build.serverPack.side.${side}`)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-violet-500 disabled:opacity-50" disabled={build.isPending} onClick={() => build.mutate(true)}>{t('build.serverPack.includeAll')}</button>
            <button className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-violet-500 disabled:opacity-50" disabled={build.isPending} onClick={() => build.mutate(false)}>{t('build.serverPack.excludeAll')}</button>
          </div>
        </div>
      )}
      {r && (
        <div className="space-y-1 text-sm text-slate-300" role="status">
          <p className="text-emerald-300">{tf('build.serverPack.done', { mods: String(r.mods), files: String(r.files), left: String(r.leftOut.length) })}</p>
          <p className="break-all font-mono text-xs text-slate-400">{tf('build.serverPack.folder', { path: r.folder })}</p>
          <p className="break-all font-mono text-xs text-slate-400">{tf('build.serverPack.zip', { path: r.zip })}</p>
          {r.undecided.length > 0 && <p className="text-xs text-amber-300">{tf('build.serverPack.undecidedDone', { n: String(r.undecided.length) })}</p>}
          {r.unlisted.length > 0 && <p className="text-xs text-amber-300">{tf('build.serverPack.unlisted', { n: String(r.unlisted.length) })}</p>}
          {r.leftOut.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-slate-400">{t('build.serverPack.leftOut')} ({r.leftOut.length})</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
                {r.leftOut.map((l) => <li key={`${l.kind}:${l.key}`}>{tf(l.kind === 'mod' ? 'build.serverPack.leftOutMod' : 'build.serverPack.leftOutPath', { id: l.key, reason: l.reason })}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
