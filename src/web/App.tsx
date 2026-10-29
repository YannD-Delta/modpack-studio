import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api.js';
import { setPackNames, t } from './i18n/index.js';
import { settingsApi } from './api-settings.js';
import { Blacklist } from './pages/Blacklist.js';
import { ConfigsHome } from './pages/ConfigsHome.js';
import { Decisions } from './pages/Decisions.js';
import { Login } from './pages/Login.js';
import { Mods } from './pages/Mods.js';
import { OldPack } from './pages/OldPack.js';
import { Profiles } from './pages/Profiles.js';
import { Settings } from './pages/Settings.js';
import { TestBench } from './pages/TestBench.js';

const TABS = [
  { id: 'profiles', label: 'nav.profiles', view: Profiles },
  { id: 'mods', label: 'nav.mods', view: Mods },
  { id: 'configs', label: 'nav.configs', view: ConfigsHome },
  { id: 'oldpack', label: 'nav.oldpack', view: OldPack },
  { id: 'testbench', label: 'nav.testbench', view: TestBench },
  { id: 'decisions', label: 'nav.decisions', view: Decisions },
  { id: 'blacklist', label: 'nav.blacklist', view: Blacklist },
  { id: 'settings', label: 'nav.settings', view: Settings },
] as const;

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me'), retry: false });
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get, enabled: me.isSuccess, retry: false });
  if (settings.data?.packs) setPackNames(settings.data.packs); // pages read the names while they render
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('profiles');

  if (me.isLoading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">{t('common.loading')}</div>;
  if (me.isError) return <Login onLoggedIn={() => qc.invalidateQueries({ queryKey: ['me'] })} />;

  const View = TABS.find((x) => x.id === tab)!.view;
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-sm font-bold text-white">M</span>
            <span className="font-semibold tracking-tight text-slate-50">{t('app.title')}</span>
          </div>
          <nav className="flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1">
            {TABS.map((x) => (
              <button key={x.id} onClick={() => setTab(x.id)} aria-current={tab === x.id} className={`rounded-lg px-3.5 py-1.5 text-sm transition ${tab === x.id ? 'bg-violet-600 text-white shadow' : 'text-slate-400 hover:text-slate-100'}`}>
                {t(x.label)}
              </button>
            ))}
          </nav>
          <button
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' });
              qc.invalidateQueries({ queryKey: ['me'] });
            }}
            className="text-sm text-slate-400 hover:text-slate-100"
          >
            {t('nav.logout')}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <View />
      </main>
    </div>
  );
}
