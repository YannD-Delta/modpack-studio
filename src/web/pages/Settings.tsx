import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../api.js';
import { settingsApi, type Effort, type KeyStatus, type LimitView, type Provider } from '../api-settings.js';
import { t, tf, tOr, type MessageKey } from '../i18n/index.js';

const field = 'rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = 'rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50';
const card = 'space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4';

const NAME: Record<Provider, string> = { claude: 'Claude', curseforge: 'CurseForge' };

function KeyCard(props: { provider: Provider; status: KeyStatus }) {
  const { provider, status } = props;
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings'] });

  const save = useMutation({
    mutationFn: () => settingsApi.setKey(provider, value.trim()),
    onSuccess: () => {
      setValue(''); // the key leaves the page as soon as it is stored
      setNote({ kind: 'ok', text: t('settings.key.saved') });
      void refresh();
    },
    onError: (e: Error) => setNote({ kind: 'err', text: e instanceof ApiError && e.status === 400 ? t('settings.key.invalid') : e.message }),
  });
  const test = useMutation({
    mutationFn: () => settingsApi.testKey(provider),
    onSuccess: (r) => setNote({ kind: r.ok ? 'ok' : 'err', text: tf(`settings.test.${r.code}` as MessageKey, { status: String(r.status ?? '') }) }),
    onError: (e: Error) => setNote({ kind: 'err', text: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => settingsApi.removeKey(provider),
    onSuccess: () => {
      setNote({ kind: 'ok', text: t('settings.key.removed') });
      void refresh();
    },
    onSettled: () => setConfirming(false),
    onError: (e: Error) => setNote({ kind: 'err', text: e.message }),
  });

  const inputId = `key-${provider}`;
  return (
    <section className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-100">{t(`settings.key.${provider}.title` as MessageKey)}</h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${status.configured ? 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300' : 'border-slate-600 bg-slate-800/60 text-slate-300'}`}>
          {status.configured ? tf('settings.key.set', { mask: `••••${status.last4}` }) : t('settings.key.unset')}
        </span>
      </div>
      <p className="text-sm text-slate-400">{t(`settings.key.${provider}.help` as MessageKey)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">{t(`settings.key.${provider}.title` as MessageKey)}</label>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('settings.key.placeholder')}
          className={`${field} min-w-64 flex-1 font-mono`}
        />
        <button className={primary} disabled={!value.trim() || save.isPending} title={t('settings.key.saveTip')} aria-label={`${t('settings.key.save')} la clé ${NAME[provider]}`} onClick={() => save.mutate()}>
          {t('settings.key.save')}
        </button>
        <button className={action} disabled={!status.configured || test.isPending} title={t('settings.key.testTip')} aria-label={`${t('settings.key.test')} la clé ${NAME[provider]}`} onClick={() => test.mutate()}>
          {t('settings.key.test')}
        </button>
        {status.configured && !confirming && (
          <button className={action} title={t('settings.key.removeTip')} aria-label={`${t('settings.key.remove')} la clé ${NAME[provider]}`} onClick={() => setConfirming(true)}>
            {t('settings.key.remove')}
          </button>
        )}
        {confirming && (
          <>
            <button className={`${action} border-rose-700 text-rose-300`} onClick={() => remove.mutate()}>{t('settings.key.confirm')}</button>
            <button className={action} onClick={() => setConfirming(false)}>{t('settings.key.cancel')}</button>
          </>
        )}
      </div>
      {note && <p role="status" className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{note.text}</p>}
    </section>
  );
}

function AssistantCard(props: { model: string; effort: Effort; models: { id: string; label: string }[]; efforts: Effort[] }) {
  const qc = useQueryClient();
  const [model, setModel] = useState(props.model);
  const [effort, setEffort] = useState<Effort>(props.effort);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    setModel(props.model);
    setEffort(props.effort);
  }, [props.model, props.effort]);
  const save = useMutation({
    mutationFn: () => settingsApi.setAssistant(model, effort),
    onSuccess: () => {
      setNote({ kind: 'ok', text: t('settings.assistant.saved') });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: Error) => setNote({ kind: 'err', text: e.message }),
  });
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{t('settings.assistant.title')}</h3>
      <p className="text-sm text-slate-400">{t('settings.assistant.help')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-300">{t('settings.assistant.model')}
          <select value={model} onChange={(e) => setModel(e.target.value)} className={`${field} mt-1 block min-w-48`}>
            {props.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-300" title={t('settings.assistant.effortTip')}>{t('settings.assistant.effort')}
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)} className={`${field} mt-1 block min-w-32`}>
            {props.efforts.map((e) => <option key={e} value={e}>{t(`settings.effort.${e}` as MessageKey)}</option>)}
          </select>
        </label>
        <button className={primary} disabled={save.isPending} onClick={() => save.mutate()}>{t('settings.assistant.save')}</button>
      </div>
      {note && <p role="status" className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{note.text}</p>}
    </section>
  );
}

function PacksCard(props: { upstream: string; own: string }) {
  const qc = useQueryClient();
  const [upstream, setUpstream] = useState(props.upstream);
  const [own, setOwn] = useState(props.own);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    setUpstream(props.upstream);
    setOwn(props.own);
  }, [props.upstream, props.own]);
  const save = useMutation({
    mutationFn: () => settingsApi.setPacks(upstream.trim(), own.trim()),
    onSuccess: () => {
      setNote({ kind: 'ok', text: t('settings.packs.saved') });
      // every page shows the names: refetch what depends on them
      void qc.invalidateQueries();
    },
    onError: (e: Error) => setNote({ kind: 'err', text: e instanceof ApiError && e.status === 400 ? t('settings.packs.invalid') : e.message }),
  });
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{t('settings.packs.title')}</h3>
      <p className="text-sm text-slate-400">{t('settings.packs.help')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-300">{t('settings.packs.upstream')}
          <input value={upstream} maxLength={40} onChange={(e) => setUpstream(e.target.value)} className={`${field} mt-1 block w-56`} />
        </label>
        <label className="text-sm text-slate-300">{t('settings.packs.own')}
          <input value={own} maxLength={40} onChange={(e) => setOwn(e.target.value)} className={`${field} mt-1 block w-56`} />
        </label>
        <button className={primary} disabled={save.isPending || !upstream.trim() || !own.trim() || (upstream.trim() === props.upstream && own.trim() === props.own)} onClick={() => save.mutate()}>{t('settings.packs.save')}</button>
      </div>
      {note && <p role="status" className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{note.text}</p>}
    </section>
  );
}

const limitText = (v: LimitView['value']): string => (Array.isArray(v) ? v.join('\n') : String(v));

/** Every limit, list and pattern the server registers, grouped; saving sends only what changed (a value equal to the default resets it). */
function LimitsCard(props: { limits: LimitView[] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const shown = (l: LimitView) => draft[l.key] ?? limitText(l.value);
  const parse = (l: LimitView, text: string): unknown =>
    l.kind === 'number' ? Number(text) : l.kind === 'list' ? text.split('\n').map((s) => s.trim()).filter(Boolean) : text.trim();
  const changed = props.limits.filter((l) => draft[l.key] !== undefined && draft[l.key] !== limitText(l.value));
  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, unknown> = {};
      for (const l of changed) {
        const next = parse(l, draft[l.key]!);
        values[l.key] = JSON.stringify(next) === JSON.stringify(l.default) ? null : next;
      }
      return settingsApi.setLimits(values);
    },
    onSuccess: () => {
      setDraft({});
      setNote({ kind: 'ok', text: t('settings.limits.saved') });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e: Error) => setNote({ kind: 'err', text: e.message }),
  });
  const groups = [...new Set(props.limits.map((l) => l.group))];
  return (
    <section className={card}>
      <h3 className="font-semibold text-slate-100">{t('settings.limits.title')}</h3>
      <p className="text-sm text-slate-400">{t('settings.limits.help')}</p>
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{tOr(`settings.limits.group.${g}`, g)}</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {props.limits.filter((l) => l.group === g).map((l) => (
              <label key={l.key} className="text-sm text-slate-300">
                {tOr(`settings.limits.${l.key}`, l.label)}
                {l.kind === 'list' ? (
                  <textarea rows={4} value={shown(l)} onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value })} className={`${field} mt-1 block w-full font-mono text-xs`} />
                ) : (
                  <input type={l.kind === 'number' ? 'number' : 'text'} min={l.min} max={l.max} value={shown(l)} onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value })} className={`${field} mt-1 block w-full`} />
                )}
                <span className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  {tf('settings.limits.default', { value: limitText(l.default).replace(/\n/g, ', ') })}
                  {shown(l) !== limitText(l.default) && (
                    <button type="button" className="text-violet-300 hover:underline" onClick={() => setDraft({ ...draft, [l.key]: limitText(l.default) })}>{t('settings.limits.reset')}</button>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <button className={primary} disabled={save.isPending || changed.length === 0} onClick={() => save.mutate()}>{t('settings.limits.save')}</button>
      {note && <p role="status" className={`text-xs ${note.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{note.text}</p>}
    </section>
  );
}

export function Settings() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  if (settings.isLoading) return <p className="text-slate-400">{t('common.loading')}</p>;
  if (!settings.data) return <p className="text-rose-300">{settings.error?.message ?? t('common.error')}</p>;
  const s = settings.data;
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('settings.title')}</h2>
      <p className="max-w-3xl text-sm text-slate-400">{t('settings.intro')}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <KeyCard provider="claude" status={s.keys.claude} />
        <KeyCard provider="curseforge" status={s.keys.curseforge} />
      </div>
      <PacksCard upstream={s.packs?.upstream ?? 'Base'} own={s.packs?.own ?? 'Own'} />
      {s.limits && s.limits.length > 0 && <LimitsCard key={JSON.stringify(s.limits.map((l) => l.value))} limits={s.limits} />}
      <AssistantCard model={s.assistant.model} effort={s.assistant.effort} models={s.models} efforts={s.efforts} />
    </section>
  );
}
