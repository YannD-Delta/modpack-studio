import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow } from '../api.js';
import { ClaudeActions } from '../components/ClaudeActions.js';
import { getPackNames, t, tf } from '../i18n/index.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';

/** First version of the new pack: the old pack against the followed one, analysed by Claude (missing mods, equivalents, NeoForge on the right Minecraft). */
export function OldPack() {
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const profiles = useMemo(() => flattenProfiles(matrix.data ?? []), [matrix.data]);
  const [atmId, setAtmId] = useState('');
  const [oldId, setOldId] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = useMutation({
    mutationFn: async () => {
      const counts = await Promise.all([atmId, oldId].map((id) => api<{ count: number }>(`/profiles/${id}/sources`, { method: 'POST' })));
      return counts.reduce((n, c) => n + c.count, 0);
    },
    onSuccess: (n) => setNote(tf('oldpack.refreshed', { n: String(n) })),
    onError: (e: Error) => setNote(e.message),
  });

  if (!matrix.data) return <p className="text-slate-400">{t('common.loading')}</p>;
  const select = (value: string, onChange: (v: string) => void, label: string, filter: (p: (typeof profiles)[number]) => boolean) => (
    <label className="text-sm text-slate-300">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} mt-1 block min-w-64`}>
        <option value="">{t('oldpack.choose')}</option>
        {profiles.filter(filter).map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
      </select>
    </label>
  );

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('oldpack.title')}</h2>
      <p className="max-w-3xl text-sm text-slate-400">{t('oldpack.intro')}</p>
      <div className="flex flex-wrap items-end gap-4">
        {select(atmId, setAtmId, t('oldpack.reference'), (p) => p.pack === getPackNames().upstream)}
        {select(oldId, setOldId, t('oldpack.old'), (p) => p.pack === getPackNames().own)}
        <button className={action} disabled={!atmId || !oldId || refresh.isPending} title={t('oldpack.refreshTip')} onClick={() => refresh.mutate()}>{t('oldpack.refresh')}</button>
        {note && <span role="status" className="pb-1.5 text-xs text-slate-400">{note}</span>}
      </div>
      <p className="text-xs text-slate-500">{t('oldpack.hint')}</p>
      <ClaudeActions base={Number(atmId) || null} other={Number(oldId) || null} actions={['migrate-old-pack']} />
    </section>
  );
}
