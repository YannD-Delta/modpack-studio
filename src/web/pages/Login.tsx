import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { t } from '../i18n/index.js';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { password } });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.error') : t('common.error'));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-2xl backdrop-blur">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-violet-400">{t('app.title')}</div>
          <h1 className="text-2xl font-semibold text-slate-50">{t('login.title')}</h1>
        </div>
        <label className="block text-sm text-slate-300">
          {t('login.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30"
          />
        </label>
        {error && <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/60 px-3 py-2 text-sm text-rose-300">{error}</p>}
        <button type="submit" className="w-full rounded-lg bg-violet-600 px-4 py-2 font-medium text-white transition hover:bg-violet-500">
          {t('login.submit')}
        </button>
      </form>
    </div>
  );
}
