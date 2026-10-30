import { t, tf } from '../i18n/index.js';

/** French message for a failed query or mutation, built from the server's `error` text (ApiError.message). */
export const errorText = (err: unknown): string => tf('common.errorWithMsg', { msg: err instanceof Error ? err.message : String(err) });

/** Inline error line; renders nothing without an error. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="text-sm text-rose-400">{errorText(error)}</p>;
}

/** Loading or error placeholder for a page that cannot render without `query.data`; null once data is there. */
export function QueryGate({ query }: { query: { isError: boolean; error: unknown; data: unknown } }) {
  if (query.data) return null;
  if (query.isError) return <ErrorNotice error={query.error} />;
  return <p className="text-slate-400">{t('common.loading')}</p>;
}
