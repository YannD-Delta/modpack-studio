import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, flattenProfiles, type BlacklistEntry, type MatrixRow } from '../api.js';
import { ErrorNotice, QueryGate } from '../components/ErrorNotice.js';
import { t, getPackNames } from '../i18n/index.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';

export function Blacklist() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  // Only clean copies: the server refuses to derive the blacklist from a played one (400 profile_not_clean).
  const upstream = useMemo(() => flattenProfiles(matrix.data ?? []).filter((p) => p.pack === getPackNames().upstream && p.state === 'clean'), [matrix.data]);
  const [serverId, setServerId] = useState('');
  const [clientId, setClientId] = useState('');
  const server = upstream.find((p) => String(p.id) === serverId);

  const list = useQuery({
    queryKey: ['blacklist', server?.version],
    queryFn: () => api<BlacklistEntry[]>(`/blacklist?upstreamVersion=${encodeURIComponent(server!.version)}`),
    enabled: !!server,
  });

  const adopt = useMutation({
    mutationFn: () => api('/blacklist', { method: 'PUT', body: { action: 'adopt-upstream', server: Number(serverId), client: Number(clientId) } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blacklist'] }),
  });

  if (!matrix.data) return <QueryGate query={matrix} />;

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('blacklist.title')}</h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-300">{t('blacklist.server')}
          <select value={serverId} onChange={(e) => setServerId(e.target.value)} className={`${field} mt-1 block min-w-56`}>
            <option value="">{t('mods.choose')}</option>
            {upstream.filter((p) => p.side === 'server').map((p) => <option key={p.id} value={p.id}>{p.pack} {p.version} ({p.state})</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300">{t('blacklist.client')}
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={`${field} mt-1 block min-w-56`}>
            <option value="">{t('mods.choose')}</option>
            {upstream.filter((p) => p.side === 'client').map((p) => <option key={p.id} value={p.id}>{p.pack} {p.version} ({p.state})</option>)}
          </select>
        </label>
        <button disabled={!serverId || !clientId || adopt.isPending} onClick={() => adopt.mutate()} className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">
          {t('blacklist.adopt')}
        </button>
        {adopt.isError && <span className="pb-2"><ErrorNotice error={adopt.error} /></span>}
      </div>

      {list.isError && <ErrorNotice error={list.error} />}
      {list.data?.length === 0 && <p className="text-slate-400">{t('blacklist.empty')}</p>}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
          {list.data.map((e) => (
            <li key={e.modId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-slate-900/60">
              <span className="font-mono text-slate-100">{e.modId}</span>
              <span className="flex items-center gap-2">
                <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{e.origin === 'upstream_derived' ? t('blacklist.originUpstream') : t('blacklist.originUser')}</span>
                {e.stale && <span className="rounded-full border border-amber-700/60 bg-amber-950/50 px-2 py-0.5 text-xs text-amber-300">{t('blacklist.stale')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
