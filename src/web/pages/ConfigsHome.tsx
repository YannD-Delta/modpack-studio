import { useState } from 'react';
import { t } from '../i18n/index.js';
import { Configs } from './Configs.js';
import { CustomizationsView } from './ConfigsCustomizations.js';

/** The Configs tab: two ways to look at configs, a free comparison of two profiles, or the player's own changes over three copies. */
export function ConfigsHome() {
  const [mode, setMode] = useState<'custom' | 'pair'>('custom');
  const tab = (id: 'custom' | 'pair', label: string) => (
    <button key={id} aria-pressed={mode === id} onClick={() => setMode(id)} className={`rounded-lg px-3 py-1.5 text-sm ${mode === id ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-100'}`}>{label}</button>
  );
  return (
    <div className="space-y-6">
      <div className="inline-flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1" role="group">
        {tab('custom', t('custom.tab.custom'))}
        {tab('pair', t('custom.tab.pair'))}
      </div>
      {mode === 'custom' ? <CustomizationsView /> : <Configs />}
    </div>
  );
}
