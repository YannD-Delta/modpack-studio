import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, flattenProfiles, profileLabel, type MatrixRow, type Profile } from '../api.js';
import { exportDownloadUrl } from '../api-plan.js';
import { projectsApi, type Choice, type Preview, type PreviewItem, type Proposal, type ProjectExport, type ReplayStatus, type Triad } from '../api-projects.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { t, tf, tfOr, tOr } from '../i18n/index.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = 'rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50';
const card = 'space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4';

const BADGE: Record<ReplayStatus, string> = {
  safe: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300',
  already: 'border-slate-600 bg-slate-800/60 text-slate-300',
  conflict: 'border-rose-700/60 bg-rose-950/50 text-rose-300',
  warning: 'border-amber-700/60 bg-amber-950/50 text-amber-300',
};

function ProfilePick(props: { label: string; value: string; onChange: (v: string) => void; profiles: Profile[]; state: string[] }) {
  return (
    <label className="text-sm text-slate-300">
      {props.label}
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} className={`${field} mt-1 block min-w-60`}>
        <option value="">{t('projects.pick')}</option>
        {props.profiles.filter((p) => props.state.includes(p.state)).map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
      </select>
    </label>
  );
}

function Validate(props: { projectId: number; profiles: Profile[] }) {
  const qc = useQueryClient();
  const [clean, setClean] = useState('');
  const [launched, setLaunched] = useState('');
  const [candidate, setCandidate] = useState('');
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [mods, setMods] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const triad: Triad | null = clean && launched && candidate ? { clean: Number(clean), launched: Number(launched), candidate: Number(candidate) } : null;

  const load = useMutation({
    mutationFn: () => projectsApi.proposal(props.projectId, triad!),
    onSuccess: (p: Proposal) => {
      setFiles(new Set(p.files.filter((f) => !f.validated).map((f) => f.path)));
      setMods(new Set(p.mods.filter((m) => !m.validated).map((m) => m.modId)));
    },
  });
  const save = useMutation({
    mutationFn: () => projectsApi.save(props.projectId, triad!, [...files], [...mods]),
    onSuccess: (r) => {
      setNote(tf('projects.saved', { files: String(r.files), mods: String(r.mods) }));
      void qc.invalidateQueries({ queryKey: ['project', props.projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      load.mutate();
    },
  });
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setter(n);
  };
  const p = load.data;
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{t('projects.validate.title')}</h3>
      <p className="text-sm text-slate-400">{t('projects.validate.help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <ProfilePick label={t('projects.clean')} value={clean} onChange={setClean} profiles={props.profiles} state={['clean']} />
        <ProfilePick label={t('projects.launched')} value={launched} onChange={setLaunched} profiles={props.profiles} state={['launched']} />
        <ProfilePick label={t('projects.candidate')} value={candidate} onChange={setCandidate} profiles={props.profiles} state={['candidate', 'run']} />
        <button className={action} disabled={!triad || load.isPending} onClick={() => { setNote(null); load.mutate(); }}>{t('projects.validate.load')}</button>
      </div>
      {load.isError && <ErrorNotice error={load.error} />}
      {p && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{tf('projects.validate.files', { n: String(p.files.length) })}</h4>
              <ul className="max-h-72 space-y-0.5 overflow-auto text-xs">
                {p.files.map((f) => (
                  <li key={f.path} className="flex items-center gap-2">
                    <input type="checkbox" aria-label={f.path} checked={files.has(f.path)} onChange={() => toggle(files, setFiles, f.path)} />
                    <span className="font-mono">{f.path}</span>
                    <span className="text-slate-500">{tOr(`projects.status.file.${f.status}`, f.status)}</span>
                    {f.validated && <span className="text-emerald-400">{t('projects.alreadyValidated')}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{tf('projects.validate.mods', { n: String(p.mods.length) })}</h4>
              <ul className="max-h-72 space-y-0.5 overflow-auto text-xs">
                {p.mods.map((m) => (
                  <li key={m.modId} className="flex items-center gap-2">
                    <input type="checkbox" aria-label={m.modId} checked={mods.has(m.modId)} onChange={() => toggle(mods, setMods, m.modId)} />
                    <span className="font-mono">{m.modId}</span>
                    <span className="text-slate-500">{tf(`projects.mod.${m.action}`, { from: m.baseVersion ?? '', to: m.version ?? '' })}</span>
                    {m.validated && <span className="text-emerald-400">{t('projects.alreadyValidated')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <button className={primary} disabled={save.isPending || (files.size === 0 && mods.size === 0)} onClick={() => save.mutate()}>{t('projects.validate.save')}</button>
        </>
      )}
      {save.isError && <ErrorNotice error={save.error} />}
      {note && <p role="status" className="text-xs text-emerald-400">{note}</p>}
    </section>
  );
}

function Kept(props: { projectId: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['project', props.projectId], queryFn: () => projectsApi.get(props.projectId) });
  const remove = useMutation({
    mutationFn: (id: number) => projectsApi.removeChange(props.projectId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', props.projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  if (q.isError) return <ErrorNotice error={q.error} />;
  const changes = q.data?.changes ?? [];
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{tf('projects.kept.title', { n: String(changes.length) })}</h3>
      {q.data?.project.baseVersion && <p className="text-xs text-slate-400">{tf('projects.kept.base', { v: q.data.project.baseVersion })}</p>}
      {changes.length === 0 && <p className="text-sm text-slate-400">{t('projects.kept.none')}</p>}
      <ul className="max-h-64 space-y-0.5 overflow-auto text-xs">
        {changes.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="rounded bg-slate-800 px-1.5 text-slate-300">{t(c.kind === 'file' ? 'projects.kind.file' : 'projects.kind.mod')}</span>
            <span className="font-mono">{c.key}</span>
            <button className="text-slate-500 hover:text-rose-300" aria-label={`${t('projects.kept.remove')} ${c.key}`} onClick={() => remove.mutate(c.id)}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CHOICES: Choice[] = ['mine', 'base', 'skip'];
const needsChoice = (i: PreviewItem) => (i.status === 'conflict' || i.status === 'warning') && (i.choice ?? null) === null;

function ExportResultCard({ exported, onClose }: { exported: ProjectExport; onClose: () => void }) {
  const r = exported.result;
  const dry = `.\\apply.ps1 -InstanceDir "<dossier de l’instance>"`;
  return (
    <div className="space-y-2 rounded-lg border border-emerald-700/60 bg-emerald-950/30 p-3 text-sm text-slate-200" data-testid="export-result">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-emerald-300">{t('projects.export.title')}</span>
        <button className={`${action} ml-auto`} onClick={onClose}>{t('plan.result.close')}</button>
      </div>
      <p>{t('plan.result.folder')} <code className="select-all break-all rounded bg-slate-900 px-1 font-mono text-xs">{exported.folder}</code></p>
      <p>{t('projects.export.zip')} <code className="select-all rounded bg-slate-900 px-1 font-mono text-xs">{exported.zip}</code></p>
      <p>{tf('projects.export.counts', { m: String(r.counts.modsUpdated), x: String(r.counts.jarsToRemove), f: String(r.counts.files) })}</p>
      {r.failures.length > 0 && (
        <div>
          <p className="font-medium text-rose-300">{tf('projects.export.missing', { n: String(r.failures.length) })}</p>
          <ul className="ml-4 list-disc text-xs text-rose-200">{r.failures.map((f) => <li key={`${f.kind}:${f.key}`}><span className="font-mono">{f.key}</span> — {f.reason}</li>)}</ul>
        </div>
      )}
      {r.warnings.length > 0 && <ul className="ml-4 list-disc text-xs text-amber-200">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <a className="inline-block rounded-md border border-emerald-600 bg-emerald-700/40 px-2.5 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-700/60" href={exportDownloadUrl(exported.name)} download>{t('plan.result.download')}</a>
      <div className="space-y-1 text-xs text-slate-300">
        <p>{t('plan.result.how')}</p>
        <p>{t('plan.result.howDry')} <code className="select-all rounded bg-slate-900 px-1 font-mono">{dry}</code></p>
        <p>{t('plan.result.howApply')} <code className="select-all rounded bg-slate-900 px-1 font-mono">{`${dry} -Apply`}</code></p>
        <p className="text-slate-400">{t('plan.result.safe')}</p>
      </div>
    </div>
  );
}

function Update(props: { projectId: number; profiles: Profile[] }) {
  const [newClean, setNewClean] = useState('');
  const [oldClean, setOldClean] = useState('');
  const [target, setTarget] = useState('');
  const [pv, setPv] = useState<Preview | undefined>();
  const [exported, setExported] = useState<ProjectExport | null>(null);
  const run = useMutation({
    mutationFn: () => projectsApi.preview(props.projectId, Number(newClean), oldClean ? Number(oldClean) : undefined),
    onSuccess: (p) => {
      setPv(p);
      setExported(null);
    },
  });
  const choose = useMutation({
    mutationFn: (v: { item: PreviewItem; choice: Choice }) => projectsApi.setChoices(props.projectId, Number(newClean), { [`${v.item.kind}:${v.item.key}`]: v.choice }),
    // the server answers with the preview as it now stands, so a reload shows the same choices
    onSuccess: (p) => setPv((old) => (old ? { ...p, baseDiff: old.baseDiff } : p)),
  });
  const pack = useMutation({
    mutationFn: () => projectsApi.exportPack(props.projectId, Number(newClean), target ? Number(target) : undefined),
    onSuccess: setExported,
  });
  const label = (i: PreviewItem) => (i.kind === 'mod' ? tfOr(`projects.mod.${i.action}`, { from: '', to: i.mine.version ?? '' }, i.action) : t('projects.kind.file'));
  const pending = pv ? pv.items.filter(needsChoice).length : 0;
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{t('projects.update.title')}</h3>
      <p className="text-sm text-slate-400">{t('projects.update.help')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <ProfilePick label={t('projects.update.newClean')} value={newClean} onChange={setNewClean} profiles={props.profiles} state={['clean']} />
        <ProfilePick label={t('projects.update.oldClean')} value={oldClean} onChange={setOldClean} profiles={props.profiles} state={['clean']} />
        <button className={primary} disabled={!newClean || run.isPending} onClick={() => run.mutate()}>{t('projects.update.run')}</button>
      </div>
      {run.isError && <ErrorNotice error={run.error} />}
      {pv && (
        <>
          <p className="text-sm text-slate-300" data-testid="preview-summary">
            {tf('projects.update.summary', { safe: String(pv.summary.safe), already: String(pv.summary.already), conflict: String(pv.summary.conflict), warning: String(pv.summary.warning) })}
          </p>
          {pv.baseDiff && <p className="text-xs text-slate-400">{tf('projects.update.baseDiff', { added: String(pv.baseDiff.added), removed: String(pv.baseDiff.removed), updated: String(pv.baseDiff.updated) })}</p>}
          {pv.missing.scan && <p role="note" className="text-xs text-amber-300">{t('projects.update.needScan')}</p>}
          {pv.missing.import && <p role="note" className="text-xs text-amber-300">{t('projects.update.needImport')}</p>}
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-800">
                {pv.items.map((i) => (
                  <tr key={i.id} data-testid="preview-row">
                    <td className="px-3 py-1.5"><span className={`rounded border px-1.5 py-0.5 ${BADGE[i.status]}`}>{t(`projects.status.${i.status}` as 'projects.status.safe')}</span></td>
                    <td className="px-3 py-1.5 text-slate-400">{label(i)}</td>
                    <td className="px-3 py-1.5 font-mono">{i.key}</td>
                    <td className="px-3 py-1.5 text-slate-300">{tfOr(`projects.reason.${i.reason}`, { mine: i.mine.version ?? '', base: i.newBase?.version ?? '' }, i.reason)}</td>
                    <td className="px-3 py-1.5">
                      {(i.status === 'conflict' || i.status === 'warning') && (
                        <div role="group" aria-label={tf('projects.choice.label', { key: i.key })} className="flex gap-1">
                          {CHOICES.map((c) => (
                            <button key={c} type="button" aria-pressed={i.choice === c} disabled={choose.isPending} onClick={() => choose.mutate({ item: i, choice: c })} className={`rounded border px-2 py-0.5 ${i.choice === c ? 'border-violet-500 bg-violet-600 text-white' : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                              {t(`projects.choice.${c}` as 'projects.choice.mine')}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {choose.isError && <ErrorNotice error={choose.error} />}
          <div className="flex flex-wrap items-end gap-3">
            <ProfilePick label={t('projects.export.target')} value={target} onChange={setTarget} profiles={props.profiles} state={['clean', 'launched', 'candidate', 'run']} />
            <button className={primary} disabled={pending > 0 || pv.items.length === 0 || pack.isPending} onClick={() => pack.mutate()}>{t('projects.export.run')}</button>
            <span role="status" data-testid="choice-counter" className={`text-xs ${pending > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>{pending > 0 ? tf('projects.choice.pending', { n: String(pending) }) : t('projects.choice.done')}</span>
          </div>
          {pack.isError && <ErrorNotice error={pack.error} />}
          {exported && <ExportResultCard exported={exported} onClose={() => setExported(null)} />}
        </>
      )}
    </section>
  );
}

export function Projects() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list });
  const matrix = useQuery({ queryKey: ['matrix'], queryFn: () => api<MatrixRow[]>('/profiles/matrix') });
  const create = useMutation({
    mutationFn: () => projectsApi.create(name.trim()),
    onSuccess: (p) => {
      setName('');
      setSelected(p.id);
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const profiles = flattenProfiles(matrix.data ?? []);
  const projects = list.data?.projects ?? [];
  const current = selected ?? projects[0]?.id ?? null;
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-100">{t('projects.title')}</h2>
      <p className="max-w-3xl text-sm text-slate-400">{t('projects.intro')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-slate-300">{t('projects.name')}
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('projects.namePlaceholder')} className={`${field} mt-1 block w-56`} />
        </label>
        <button className={primary} disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>{t('projects.create')}</button>
        {projects.length > 0 && (
          <label className="text-sm text-slate-300">{t('projects.current')}
            <select value={current ?? ''} onChange={(e) => setSelected(Number(e.target.value))} className={`${field} mt-1 block w-56`}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.changes ?? 0})</option>)}
            </select>
          </label>
        )}
      </div>
      {create.isError && <ErrorNotice error={create.error} />}
      {list.isError && <ErrorNotice error={list.error} />}
      {current !== null && (
        <>
          <Validate key={`v${current}`} projectId={current} profiles={profiles} />
          <Kept key={`k${current}`} projectId={current} />
          <Update key={`u${current}`} projectId={current} profiles={profiles} />
        </>
      )}
    </section>
  );
}
