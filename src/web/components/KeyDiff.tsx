import { useQuery } from '@tanstack/react-query';
import { keysApi, type KeyDiffData } from '../api-keys.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

const box = 'mx-4 mb-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs';
const mono = 'font-mono break-all';

function Section(props: { title: string; tone: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={props.testId}>
      <h4 className={`mb-1 font-semibold ${props.tone}`}>{props.title}</h4>
      <ul className="space-y-0.5">{props.children}</ul>
    </section>
  );
}

/** Pure view of one key diff answer: added, removed, changed (old to new) and moved keys, or the "lines" fallback message. */
export function KeyDiffBody({ data }: { data: KeyDiffData }) {
  if (!data.parsable) {
    const key = `keys.fallback.${data.reason ?? 'unparsable'}` as MessageKey;
    return <p className={`${box} text-slate-400`}>{tf(key, { detail: data.detail ?? '' })}</p>;
  }
  const { added, removed, changed, moved } = data.diff;
  const none = added.length + removed.length + changed.length + moved.length === 0;
  return (
    <div className="mx-4 mb-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs" data-testid="key-diff">
      {data.stale && <p className="text-amber-300">{t('keys.stale')}</p>}
      {none && <p className="text-slate-400">{t('keys.same')}</p>}
      {changed.length > 0 && (
        <Section title={tf('keys.section.changed', { n: String(changed.length) })} tone="text-amber-300" testId="keys-changed">
          {changed.map((c) => (
            <li key={c.key} className={mono}>
              <span className="text-slate-200">{c.key}</span> <span className="text-rose-300">{c.old}</span> <span aria-hidden>→</span> <span className="text-emerald-300">{c.new}</span>
            </li>
          ))}
        </Section>
      )}
      {moved.length > 0 && (
        <Section title={tf('keys.section.moved', { n: String(moved.length) })} tone="text-sky-300" testId="keys-moved">
          {moved.map((m) => (
            <li key={`${m.from}>${m.to}`} className={mono}>
              <span className="text-slate-400">{m.from}</span> <span aria-hidden>{t('keys.moved.arrow')}</span> <span className="text-slate-200">{m.to}</span> <span className="text-slate-500">= {m.value}</span>
            </li>
          ))}
        </Section>
      )}
      {added.length > 0 && (
        <Section title={tf('keys.section.added', { n: String(added.length) })} tone="text-emerald-300" testId="keys-added">
          {added.map((a) => (
            <li key={a.key} className={mono}>
              <span className="text-slate-200">{a.key}</span> <span className="text-emerald-300">{a.value}</span>
            </li>
          ))}
        </Section>
      )}
      {removed.length > 0 && (
        <Section title={tf('keys.section.removed', { n: String(removed.length) })} tone="text-rose-300" testId="keys-removed">
          {removed.map((r) => (
            <li key={r.key} className={mono}>
              <span className="text-slate-200">{r.key}</span> <span className="text-rose-300">{r.value}</span>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

/** Key-by-key comparison of one config file between two profiles. */
export function KeyDiff(props: { base: string; other: string; path: string }) {
  const { base, other, path } = props;
  const q = useQuery({ queryKey: ['configs-keydiff', base, other, path], queryFn: () => keysApi.keyDiff(base, other, path), retry: false });
  if (q.isLoading) return <p className={`${box} text-slate-400`}>{t('keys.loading')}</p>;
  if (q.error) return <p className={`${box} text-rose-300`}>{tf('keys.error', { msg: q.error.message })}</p>;
  return <KeyDiffBody data={q.data!} />;
}
