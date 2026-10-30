import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { t, tf, tOr } from '../i18n/index.js';

type Updates = {
  gameVersion: string | null;
  loader: string | null;
  checked: number;
  upToDate: number;
  noSources: boolean;
  updates: { projectId: number; name: string; url: string; installed: { fileId: number; fileName: string }; latest: { id: number; displayName: string; fileName: string; fileDate: string; releaseType: number } }[];
  failed: { projectId: number; name: string; code: string }[];
};

const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'no_key') return t('curseforge.noKey');
  if (e instanceof ApiError && e.code) return tOr(`curseforge.error.${e.code}`, e.message);
  return e instanceof Error ? e.message : t('common.error');
}

/** Newer CurseForge releases for the mods of one profile (the instance file says which project and file each jar is). */
export function CurseForgeUpdates(props: { profileId: number | null }) {
  const [preRelease, setPreRelease] = useState(false);
  const check = useMutation({
    mutationFn: () => api<Updates>(`/curseforge/updates?profile=${props.profileId}${preRelease ? '&preRelease=1' : ''}`),
  });
  const r = check.data;
  return (
    <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <h3 className="font-semibold text-slate-100">{t('curseforge.title')}</h3>
      <p className="text-sm text-slate-400">{t('curseforge.help')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button className={action} disabled={!props.profileId || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? t('curseforge.checking') : t('curseforge.check')}
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input type="checkbox" checked={preRelease} onChange={(e) => setPreRelease(e.target.checked)} />
          {t('curseforge.preRelease')}
        </label>
      </div>
      {check.isError && <p role="alert" className="text-sm text-rose-300">{errorText(check.error)}</p>}
      {r?.noSources && <p className="text-sm text-slate-400">{t('curseforge.none')}</p>}
      {r && !r.noSources && (
        <>
          <p className="text-sm text-slate-300" data-testid="curseforge-summary">
            {tf('curseforge.summary', { checked: String(r.checked), updates: String(r.updates.length), upToDate: String(r.upToDate), failed: r.failed.length ? tf('curseforge.failedPart', { n: String(r.failed.length) }) : '' })}
          </p>
          {r.updates.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-900 uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('curseforge.col.mod')}</th>
                    <th className="px-3 py-2 text-left">{t('curseforge.col.installed')}</th>
                    <th className="px-3 py-2 text-left">{t('curseforge.col.latest')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {r.updates.map((u) => (
                    <tr key={`${u.projectId}-${u.installed.fileId}`}>
                      <td className="px-3 py-1.5"><a href={u.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">{u.name}</a></td>
                      <td className="px-3 py-1.5 font-mono">{u.installed.fileName}</td>
                      <td className="px-3 py-1.5"><span className="font-mono">{u.latest.fileName}</span> <span className="text-slate-500">· {u.latest.fileDate.slice(0, 10)}{u.latest.releaseType !== 1 ? ` · ${t('curseforge.preReleaseTag')}` : ''}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
