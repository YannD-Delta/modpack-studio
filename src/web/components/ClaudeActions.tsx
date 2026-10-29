import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { assistantApi, type ActionId, type RunResult } from '../api-assistant.js';
import { settingsApi } from '../api-settings.js';
import { t, tf, type MessageKey } from '../i18n/index.js';

const action = 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50';
const primary = 'rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50';

type Note = { kind: 'ok' | 'err'; text: string };
type Result = RunResult & { id: ActionId; label: string };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // some app views refuse clipboard access: the caller falls back to a selectable text
  }
}

/** Predefined Claude actions on a comparison: run through the API, or copy a ready-made prompt. */
export function ClaudeActions(props: { base: number | null; other: number | null; actions: ActionId[]; runId?: string | null }) {
  const { base, other, runId } = props;
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const catalogue = useQuery({ queryKey: ['assistant-actions'], queryFn: assistantApi.actions });
  const hasKey = settings.data?.keys?.claude?.configured ?? false;
  const ready = runId !== undefined ? !!runId : base !== null && other !== null;

  const [busy, setBusy] = useState<ActionId | null>(null);
  const [notes, setNotes] = useState<Partial<Record<ActionId, Note>>>({});
  const [manual, setManual] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const setNote = (id: ActionId, note: Note | null) => setNotes((n) => ({ ...n, [id]: note ?? undefined }));

  const run = useMutation({
    mutationFn: (id: ActionId) => (runId ? assistantApi.runRun(runId) : assistantApi.run(id, base!, other!)),
    onMutate: (id) => {
      setBusy(id);
      setNote(id, null);
      setResult(null);
    },
    onSuccess: (r, id) => setResult({ ...r, id, label: catalogue.data?.find((a) => a.id === id)?.label ?? id }),
    onError: (e: Error, id) => setNote(id, { kind: 'err', text: t(`assistant.error.${errorCode(e)}` as MessageKey) }),
    onSettled: () => setBusy(null),
  });

  const copy = useMutation({
    mutationFn: (id: ActionId) => (runId ? assistantApi.promptRun(runId) : assistantApi.prompt(id, base!, other!)),
    onMutate: (id) => setNote(id, null),
    onSuccess: async (p, id) => {
      if (await copyText(p.prompt)) {
        setManual(null);
        setNote(id, { kind: 'ok', text: tf('assistant.copied', { n: String(p.prompt.length) }) });
      } else {
        setManual(p.prompt);
        setNote(id, { kind: 'err', text: t('assistant.copyFailed') });
      }
    },
    onError: (e: Error, id) => setNote(id, { kind: 'err', text: e.message }),
  });

  if (!Array.isArray(catalogue.data)) return null; // not loaded yet, or an unexpected answer: the page works without the buttons
  const items = catalogue.data.filter((a) => props.actions.includes(a.id));

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4" aria-label={t('assistant.title')}>
      <div className="space-y-1">
        <h3 className="font-semibold text-slate-100">{t('assistant.title')}</h3>
        <p className="max-w-3xl text-xs text-slate-400">{t('assistant.intro')}</p>
        {!ready && <p className="text-xs text-amber-300">{t(runId !== undefined ? 'assistant.pickRun' : 'assistant.pickFirst')}</p>}
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((a) => (
          <li key={a.id} className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-100" title={a.tip}>{a.label}</span>
              <span className="flex gap-2">
                <button className={primary} disabled={!ready || !hasKey || run.isPending} title={hasKey ? t('assistant.runTip') : t('assistant.runNoKey')} aria-label={`${t('assistant.run')} : ${a.label}`} onClick={() => run.mutate(a.id)}>
                  {busy === a.id ? t('assistant.running') : t('assistant.run')}
                </button>
                <button className={action} disabled={!ready || copy.isPending} title={t('assistant.copyTip')} aria-label={`${t('assistant.copy')} : ${a.label}`} onClick={() => copy.mutate(a.id)}>
                  {t('assistant.copy')}
                </button>
              </span>
            </div>
            <p className="text-xs text-slate-500">{a.tip}</p>
            {notes[a.id] && <p role="status" className={`text-xs ${notes[a.id]!.kind === 'ok' ? 'text-emerald-400' : 'text-rose-300'}`}>{notes[a.id]!.text}</p>}
          </li>
        ))}
      </ul>

      {manual && (
        <textarea readOnly value={manual} onFocus={(e) => e.currentTarget.select()} aria-label={t('assistant.copy')} className="h-40 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200" />
      )}

      {result && (
        <div className="space-y-2 rounded-lg border border-violet-800/60 bg-slate-950/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-slate-100">{tf('assistant.resultTitle', { label: result.label })}</h4>
            <span className="flex gap-2">
              <button className={action} onClick={async () => { if (!(await copyText(result.text))) setManual(result.text); }}>{t('assistant.copyResult')}</button>
              <button className={action} onClick={() => setResult(null)}>{t('assistant.close')}</button>
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {tf('assistant.meta', { model: result.model, effort: result.effort, inTokens: String(result.inputTokens), outTokens: String(result.outputTokens) })}
            {result.shown < result.rows && ` · ${tf('assistant.truncated', { shown: String(result.shown), rows: String(result.rows) })}`}
          </p>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm text-slate-200">{result.text}</pre>
        </div>
      )}
    </section>
  );
}

/** The API puts a stable `code` in its error answers; the generic `api()` helper keeps only the text, so read it back from the message. */
function errorCode(e: Error): 'not_configured' | 'rejected' | 'rate_limited' | 'unreachable' | 'refused' | 'unexpected' {
  const m = e.message.toLowerCase();
  if (m.includes('declined')) return 'refused';
  if (m.includes('no claude api key')) return 'not_configured';
  if (m.includes('refused the key')) return 'rejected';
  if (m.includes('rate limited')) return 'rate_limited';
  if (m.includes('unreachable')) return 'unreachable';
  return 'unexpected';
}
