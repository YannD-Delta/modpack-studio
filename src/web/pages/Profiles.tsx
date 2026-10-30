import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, CELL_KEYS, type LoaderCheck, type MatrixRow, type Profile } from '../api.js';
import { ErrorNotice, errorText } from '../components/ErrorNotice.js';
import { t, tf, tOr, getPackNames } from '../i18n/index.js';

const STATE_STYLE: Record<string, string> = {
  clean: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  launched: 'border-sky-700/60 bg-sky-950/50 text-sky-300',
  candidate: 'border-fuchsia-700/60 bg-fuchsia-950/40 text-fuchsia-300',
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

function LoaderResult(props: { result: LoaderCheck | 'loading' | { error: string } | undefined }) {
  const r = props.result;
  if (!r) return null;
  if (r === 'loading') return <p className="mt-1 text-[11px] font-normal text-slate-400">{t('profiles.loaderChecking')}</p>;
  if ('error' in r) return <p className="mt-1 text-[11px] font-normal text-rose-300">{r.error}</p>;
  const fields = [...new Set(r.mismatches.map((m) => m.field))].map((f) => tOr(`profiles.loaderField.${f}`, f)).join(', ');
  return (
    <div className="mt-1 space-y-0.5 text-[11px] font-normal text-slate-300" data-testid="loader-result">
      {r.profiles.map((p) => (
        <p key={p.id}>
          {p.label} : {p.loader ? `${p.loader.loader} ${p.loader.loaderVersion} · Minecraft ${p.loader.mcVersion ?? '?'}` : p.error ?? t('profiles.loaderUnknown')}
        </p>
      ))}
      <p className={r.ok ? 'text-emerald-400' : 'text-amber-300'}>{r.ok ? t('profiles.loaderOk') : tf('profiles.loaderDiff', { fields })}</p>
    </div>
  );
}

export function Profiles() {
  const qc = useQueryClient();
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const events = useJobEvents();
  // The form keeps the role (followed pack or own pack), never a pack name: the name is read from Settings at render and submit time.
  const [form, setForm] = useState({ role: 'upstream' as 'upstream' | 'own', version: '', side: 'server', state: 'clean', locationKind: 'zip', location: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; location: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [loaderChecks, setLoaderChecks] = useState<Record<string, LoaderCheck | 'loading' | { error: string }>>({});
  const checkLoader = (row: MatrixRow) => {
    const key = `${row.pack}-${row.version}`;
    const ids = Object.values(row.cells).filter((c): c is Profile => c !== null).map((c) => c.id);
    setLoaderChecks((prev) => ({ ...prev, [key]: 'loading' }));
    api<LoaderCheck>(`/loader/check?profiles=${ids.join(',')}`)
      .then((res) => setLoaderChecks((prev) => ({ ...prev, [key]: res })))
      .catch((e: Error) => setLoaderChecks((prev) => ({ ...prev, [key]: { error: errorText(e) } })));
  };
  const names = getPackNames();

  const create = useMutation({
    mutationFn: () => {
      const { role, ...rest } = form;
      return api('/profiles', { method: 'POST', body: { ...rest, pack: getPackNames()[role] } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['matrix'] }),
    onError: (e: Error) => setNotice(errorText(e)),
  });
  const saveLocation = useMutation({
    mutationFn: (v: { id: number; location: string }) => api(`/profiles/${v.id}`, { method: 'PATCH', body: { location: v.location } }),
    onSuccess: () => {
      setEditing(null);
      setNotice(t('profiles.locationSaved'));
      void qc.invalidateQueries({ queryKey: ['matrix'] });
    },
    onError: (e: Error) => setNotice(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmingDelete(null);
      setNotice(t('profiles.deleted'));
      void qc.invalidateQueries({ queryKey: ['matrix'] });
    },
    onError: (e: Error) => {
      setConfirmingDelete(null);
      setNotice(errorText(e));
    },
  });
  const runImport = useMutation({
    mutationFn: (p: Profile) => api(`/profiles/${p.id}/import`, { method: 'POST', body: { source: { kind: p.locationKind === 'zip' ? 'zip' : 'folder', path: p.location } } }),
    onSuccess: () => setNotice(t('profiles.importStarted')),
    onError: (e: Error) => setNotice(errorText(e)),
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
              {matrix.isError && <tr><td colSpan={9} className="px-4 py-6"><ErrorNotice error={matrix.error} /></td></tr>}
              {matrix.data?.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-6 text-slate-400">{t('profiles.empty')}</td></tr>
              )}
              {matrix.data?.map((row) => (
                <tr key={`${row.pack}-${row.version}`} className="hover:bg-slate-900/60">
                  <th scope="row" className="px-4 py-3 text-left align-top font-semibold text-slate-100">
                    <div className="whitespace-nowrap">{row.pack} {row.version}</div>
                    <button onClick={() => checkLoader(row)} className="mt-1 rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-normal text-slate-200 hover:bg-slate-700">{t('profiles.checkLoader')}</button>
                    <LoaderResult result={loaderChecks[`${row.pack}-${row.version}`]} />
                  </th>
                  {CELL_KEYS.map((k) => {
                    const p = row.cells[k];
                    return p ? (
                      <td key={k} data-testid="cell-filled" className="px-3 py-2">
                        <div className={`space-y-1 rounded-lg border px-2 py-1 text-xs ${STATE_STYLE[p.state] ?? ''}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span>✓ {p.locationKind}</span>
                            <button aria-label={`${t('profiles.import')} ${p.id}`} onClick={() => runImport.mutate(p)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">
                              {t('profiles.import')}
                            </button>
                          </div>
                          <div className="break-all font-mono text-[11px] opacity-80" title={t('profiles.locationShown')}>{p.location}</div>
                          <div className="text-[11px]">
                            {p.importedAt ? t('profiles.imported') : t('profiles.notImported')}
                            {(p.importIssueCount ?? 0) > 0 && <span className="ml-1 text-amber-300">· {tf('profiles.skipped', { n: String(p.importIssueCount) })}</span>}
                          </div>
                          {editing?.id === p.id ? (
                            <div className="flex gap-1">
                              <input aria-label={`${t('profiles.location')} ${p.id}`} value={editing.location} onChange={(e) => setEditing({ id: p.id, location: e.target.value })} className={`${field} min-w-0 flex-1 px-1.5 py-0.5 text-xs`} />
                              <button aria-label={`${t('profiles.saveLocation')} ${p.id}`} disabled={saveLocation.isPending || !editing.location.trim()} onClick={() => saveLocation.mutate(editing)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700 disabled:opacity-50">{t('profiles.saveLocation')}</button>
                              <button onClick={() => setEditing(null)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">{t('profiles.cancel')}</button>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <button aria-label={`${t('profiles.editLocation')} ${p.id}`} onClick={() => setEditing({ id: p.id, location: p.location })} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">{t('profiles.editLocation')}</button>
                              {confirmingDelete === p.id ? (
                                <>
                                  <button aria-label={`${t('profiles.confirmDelete')} ${p.id}`} disabled={remove.isPending} onClick={() => remove.mutate(p.id)} className="rounded bg-rose-900 px-1.5 py-0.5 text-rose-100 hover:bg-rose-800 disabled:opacity-50">{t('profiles.confirmDelete')}</button>
                                  <button onClick={() => setConfirmingDelete(null)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">{t('profiles.cancel')}</button>
                                </>
                              ) : (
                                <button aria-label={`${t('profiles.delete')} ${p.id}`} onClick={() => setConfirmingDelete(p.id)} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200 hover:bg-slate-700">{t('profiles.delete')}</button>
                              )}
                            </div>
                          )}
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
        <select aria-label="Pack" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'upstream' | 'own' })} className={field}>
          <option value="upstream">{names.upstream}</option><option value="own">{names.own}</option>
        </select>
        <input aria-label={t('profiles.version')} placeholder={t('profiles.version')} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} className={`${field} w-28`} />
        <select aria-label="Côté" value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })} className={field}>
          <option value="server">server</option><option value="client">client</option>
        </select>
        <select aria-label="État" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className={field}>
          <option>clean</option><option>launched</option><option>candidate</option><option>run</option>
        </select>
        <select aria-label="Type" value={form.locationKind} onChange={(e) => setForm({ ...form, locationKind: e.target.value })} className={field}>
          <option>zip</option><option>folder</option><option>smb</option>
        </select>
        <input aria-label={t('profiles.location')} placeholder={t('profiles.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={`${field} min-w-72 flex-1`} />
        <button type="submit" className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500">{t('profiles.create')}</button>
      </form>
    </section>
  );
}
