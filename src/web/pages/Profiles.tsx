import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, CELL_KEYS, type MatrixRow, type Profile } from '../api.js';
import { t, getPackNames } from '../i18n/index.js';

const STATE_STYLE: Record<string, string> = {
  clean: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  launched: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  run: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
};

function useJobEvents() {
  const [events, setEvents] = useState<string[]>([]);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/events');
    es.addEventListener('job', (e) => {
      const j = JSON.parse((e as MessageEvent).data) as { type: string; status: string; message?: string };
      setEvents((prev) => [`${j.type} · ${j.status}${j.message ? ` · ${j.message}` : ''}`, ...prev].slice(0, 5));
    });
    return () => es.close();
  }, []);
  return events;
}

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';

export function Profiles() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const events = useJobEvents();
  const [form, setForm] = useState({ pack: getPackNames().upstream, version: '', side: 'server', state: 'clean', locationKind: 'zip', location: '' });
  const [notice, setNotice] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api('/profiles', { method: 'POST', body: form }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matrix'] }),
    onError: (e: Error) => setNotice(e.message),
  });
  const runImport = useMutation({
    mutationFn: (p: Profile) => api(`/profiles/${p.id}/import`, { method: 'POST', body: { source: { kind: p.locationKind === 'zip' ? 'zip' : 'folder', path: p.location } } }),
    onSuccess: () => setNotice(t('profiles.importStarted')),
    onError: (e: Error) => setNotice(e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    create.mutate();
  };

  return (
    <section className="space-y-8">
      <div>
        <h2 className="mb-4 text-lg font-semibold text-slate-100">{t('profiles.title')}</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 text-left">&nbsp;</th>
                {CELL_KEYS.map((k) => (
                  <th key={k} className="px-3 py-3 text-left font-medium">{k.replace('-', ' · ')}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {matrix.data?.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-slate-400">{t('profiles.empty')}</td></tr>
              )}
              {matrix.data?.map((row) => (
                <tr key={`${row.pack}-${row.version}`} className="hover:bg-slate-900/60">
                  <th scope="row" className="whitespace-nowrap px-4 py-3 text-left font-semibold text-slate-100">{row.pack} {row.version}</th>
                  {CELL_KEYS.map((k) => {
                    const p = row.cells[k];
                    return p ? (
                      <td key={k} data-testid="cell-filled" className="px-3 py-2">
                        <div className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-xs ${STATE_STYLE[p.state] ?? ''}`}>
                          <span>✓ {p.locationKind}</span>
                          <button aria-label={`${t('profiles.import')} ${p.id}`} onClick={() => runImport.mutate(p)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">
                            {t('profiles.import')}
                          </button>
                        </div>
                      </td>
                    ) : (
                      <td key={k} data-testid="cell-empty" className="px-3 py-2 text-slate-600">—</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {notice && <p className="mt-3 text-sm text-violet-300">{notice}</p>}
        {events.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-slate-400">
            {events.map((e, i) => (<li key={i} className="font-mono">{e}</li>))}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <select aria-label="Pack" value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} className={field}>
          <option>{getPackNames().upstream}</option><option>{getPackNames().own}</option>
        </select>
        <input aria-label={t('profiles.version')} placeholder={t('profiles.version')} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} className={`${field} w-28`} />
        <select aria-label="Côté" value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })} className={field}>
          <option value="server">server</option><option value="client">client</option>
        </select>
        <select aria-label="État" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={field}>
          <option>clean</option><option>launched</option><option>run</option>
        </select>
        <select aria-label="Type" value={form.locationKind} onChange={(e) => setForm({ ...form, locationKind: e.target.value })} className={field}>
          <option>zip</option><option>folder</option><option>smb</option><option>agent</option>
        </select>
        <input aria-label={t('profiles.location')} placeholder={t('profiles.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={`${field} min-w-72 flex-1`} />
        <button type="submit" className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500">{t('profiles.create')}</button>
      </form>
    </section>
  );
}
