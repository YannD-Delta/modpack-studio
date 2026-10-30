// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/web/App.js';
import { setPackNames } from '../../../src/web/i18n/index.js';
import { Blacklist } from '../../../src/web/pages/Blacklist.js';
import { Login } from '../../../src/web/pages/Login.js';
import { Mods } from '../../../src/web/pages/Mods.js';
import { Profiles } from '../../../src/web/pages/Profiles.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
let calls: { url: string; method: string; body?: string }[] = [];

function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}
const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
afterEach(() => {
  setPackNames({ upstream: 'Base', own: 'Own' });
  cleanup();
  vi.unstubAllGlobals();
});

const profile = (id: number, pack: string, version: string, side: string, state: string, kind = 'folder') => ({ id, packVersionId: 1, pack, version, side, state, locationKind: kind, location: 'x', immutable: true });
const matrix = [
  { pack: 'Base', version: '8.3', cells: { 'server-clean': profile(1, 'Base', '8.3', 'server', 'clean', 'zip'), 'client-clean': profile(2, 'Base', '8.3', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-launched': null, 'server-run': null } },
  { pack: 'Own', version: '1.0', cells: { 'client-clean': profile(3, 'Own', '1.0', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } },
];

describe('Login', () => {
  it('shows a French error on 401', async () => {
    mockApi(() => ({ status: 401, body: { error: 'invalid credentials' } }));
    wrap(<Login onLoggedIn={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('Mot de passe incorrect')).toBeTruthy();
  });
});

describe('Profiles', () => {
  it('renders filled and empty matrix cells', async () => {
    mockApi(() => ({ body: matrix }));
    wrap(<Profiles />);
    expect(await screen.findByText('Base 8.3')).toBeTruthy();
    expect(screen.getAllByTestId('cell-filled').length).toBe(3);
    expect(screen.getAllByTestId('cell-empty').length).toBe(9);
  });
});

describe('Mods', () => {
  const diff = { added: [{ modId: 'mine', version: '1.0', sha256: 's', file: 'mine-1.0.jar' }], removed: [{ modId: 'b', version: '1.0', sha256: 's', file: 'b-1.0.jar' }], updated: [{ modId: 'a', from: { modId: 'a', version: '1.0', sha256: 'x', file: 'a-1.0.jar' }, to: { modId: 'a', version: '1.1', sha256: 'y', file: 'a-1.1.jar' }, direction: 'newer' }], rebuilt: [], unchanged: 4 };

  beforeEach(() => {
    mockApi((url, init) => {
      if (url.includes('/profiles/matrix')) return { body: matrix };
      if (url.includes('/mods/diff')) return { body: diff };
      if (init?.method === 'PUT') return { body: { ok: true } };
      return { body: {} };
    });
  });

  it('labels each row in French and marks a removed ATM mod as an anomaly', async () => {
    wrap(<Mods />);
    await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
    expect(await screen.findByText('plus récent')).toBeTruthy();
    expect(screen.getByText('ajouté')).toBeTruthy();
    expect(screen.getByText('manquant')).toBeTruthy();
  });

  it('says exactly where each mod is missing or out of date', async () => {
    wrap(<Mods />);
    await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
    expect(await screen.findByText(/Manque dans Own 1.0 : présent dans Base 8\.3, absent de Own 1.0\./)).toBeTruthy();
    expect(screen.getByText(/Nouveau dans Own 1.0 : absent de Base 8\.3\./)).toBeTruthy();
    expect(screen.getByText(/Own 1.0 est plus récent que Base 8.3./)).toBeTruthy();
    expect(screen.getByText('a-1.0.jar')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Manquants · 1/ }));
    expect(screen.queryByText('mine')).toBeNull();
  });

  it('sends a decision when the menu action is used', async () => {
    wrap(<Mods />);
    await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
    const accept = await screen.findByRole('button', { name: 'Accepter le retrait b' });
    expect(accept.getAttribute('title')).toMatch(/retiré ce mod exprès/);
    expect(screen.getByText('manquant').getAttribute('title')).toMatch(/bloque la construction/);
    await userEvent.click(accept);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/mods/b/decision'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toMatchObject({ kind: 'ignore' });
  });
});

describe('Blacklist', () => {
  it('adopts the ATM blacklist with a single PUT', async () => {
    mockApi((url, init) => {
      if (url.includes('/profiles/matrix')) return { body: matrix };
      if (url.includes('/blacklist') && (!init?.method || init.method === 'GET')) return { body: [{ modId: 'cli', origin: 'atm_derived', stale: false }, { modId: 'old', origin: 'atm_derived', stale: true }] };
      return { body: { ok: true } };
    });
    wrap(<Blacklist />);
    await userEvent.selectOptions(await screen.findByLabelText('Pack serveur Base'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Client Base'), '2');
    expect(await screen.findByText('périmé')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter tout (Base)' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBe(1));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ action: 'adopt-atm', server: 1, client: 2 });
  });

  it('offers only clean profiles in the adopt selects (the server refuses played copies)', async () => {
    const played = [{ pack: 'Base', version: '8.3', cells: { 'server-clean': profile(1, 'Base', '8.3', 'server', 'clean', 'zip'), 'server-launched': profile(4, 'Base', '8.3', 'server', 'launched'), 'client-clean': profile(2, 'Base', '8.3', 'client', 'clean'), 'client-launched': profile(5, 'Base', '8.3', 'client', 'launched'), 'client-run': profile(6, 'Base', '8.3', 'client', 'run'), 'server-run': null } }];
    mockApi((url) => ({ body: url.includes('/profiles/matrix') ? played : [] }));
    wrap(<Blacklist />);
    const server = await screen.findByLabelText('Pack serveur Base');
    const optionIds = (el: HTMLElement) => [...el.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
    expect(optionIds(server)).toEqual(['1']);
    expect(optionIds(screen.getByLabelText('Client Base'))).toEqual(['2']);
  });
});

describe('Profiles actions', () => {
  const imported = { ...profile(1, 'Base', '8.3', 'server', 'clean', 'zip'), location: '/data/base.zip', importedAt: '2026-10-01T10:00:00Z', importIssueCount: 3 };
  const fresh = { ...profile(2, 'Base', '8.3', 'client', 'clean'), location: '/data/base-client', importedAt: null, importIssueCount: 0 };
  const m = [{ pack: 'Base', version: '8.3', cells: { 'server-clean': imported, 'client-clean': fresh, 'client-launched': null, 'client-run': null, 'server-launched': null, 'server-run': null } }];

  it('creates a profile under the configured pack name, not the built-in default', async () => {
    setPackNames({ upstream: 'Alpha Pack', own: 'Beta Pack' });
    mockApi(() => ({ body: [] }));
    wrap(<Profiles />);
    await userEvent.type(screen.getByLabelText('Version'), '1.0');
    await userEvent.type(screen.getByLabelText('Chemin (zip ou dossier)'), '/x');
    await userEvent.click(screen.getByRole('button', { name: 'Créer le profil' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/profiles'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toMatchObject({ pack: 'Alpha Pack', version: '1.0' });
    await userEvent.selectOptions(screen.getByLabelText('Pack'), 'Beta Pack');
    await userEvent.click(screen.getByRole('button', { name: 'Créer le profil' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(2));
    expect(JSON.parse(calls.filter((c) => c.method === 'POST')[1]!.body!).pack).toBe('Beta Pack');
  });

  it('shows the location, the import state and the skipped jars', async () => {
    mockApi(() => ({ body: m }));
    wrap(<Profiles />);
    expect(await screen.findByText('/data/base.zip')).toBeTruthy();
    expect(screen.getByText('importé')).toBeTruthy();
    expect(screen.getByText(/3 jar ignoré/)).toBeTruthy();
    expect(screen.getByText('pas encore importé')).toBeTruthy();
  });

  it('edits the location with a PATCH', async () => {
    mockApi((_u, init) => ({ body: init?.method === 'PATCH' ? { ok: true } : m }));
    wrap(<Profiles />);
    await userEvent.click(await screen.findByRole('button', { name: 'Modifier le chemin 2' }));
    const input = screen.getByLabelText('Chemin (zip ou dossier) 2');
    await userEvent.clear(input);
    await userEvent.type(input, '/moved');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer 2' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/v1/profiles/2');
    expect(JSON.parse(patch.body!)).toEqual({ location: '/moved' });
  });

  it('deletes only after a second confirmation click and shows the 409 message', async () => {
    mockApi((_u, init) => (init?.method === 'DELETE' ? { status: 409, body: { error: 'a job is running', code: 'job_running' } } : { body: m }));
    wrap(<Profiles />);
    await userEvent.click(await screen.findByRole('button', { name: 'Supprimer 2' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer la suppression 2' }));
    expect(await screen.findByText('Erreur : a job is running')).toBeTruthy();
  });
});

describe('Errors and stale state', () => {
  it('shows a French error instead of loading forever when the matrix fails', async () => {
    mockApi(() => ({ status: 500, body: { error: 'database is locked' } }));
    wrap(<Mods />);
    expect(await screen.findByText('Erreur : database is locked')).toBeTruthy();
    expect(screen.queryByText('Chargement…')).toBeNull();
  });

  it('prints the configured followed-pack name on derived blacklist rows', async () => {
    setPackNames({ upstream: 'Alpha Pack', own: 'Own' });
    mockApi((url) => ({ body: url.includes('/profiles/matrix') ? [{ pack: 'Alpha Pack', version: '1', cells: { 'server-clean': profile(1, 'Alpha Pack', '1', 'server', 'clean') } }] : [{ modId: 'cli', origin: 'atm_derived', stale: false }] }));
    wrap(<Blacklist />);
    await userEvent.selectOptions(await screen.findByLabelText('Pack serveur Alpha Pack'), '1');
    expect(await screen.findByText('Alpha Pack', { selector: 'span.rounded-full' })).toBeTruthy();
  });

  it('refreshes the diff after a decision and resets the filter when the selection changes', async () => {
    const d = { added: [], removed: [], updated: [{ modId: 'a', from: { modId: 'a', version: '1.1', sha256: 'x', file: 'a-1.1.jar' }, to: { modId: 'a', version: '1.0', sha256: 'y', file: 'a-1.0.jar' }, direction: 'older' }], rebuilt: [], unchanged: 0 };
    mockApi((url, init) => {
      if (url.includes('/profiles/matrix')) return { body: matrix };
      if (url.includes('/mods/diff')) return { body: d };
      if (url.includes('/plan?')) return { body: { items: [], decisions: { pins: [], ignored: [], clientOnly: [] } } };
      if (init?.method === 'PUT') return { body: { ok: true } };
      return { body: {} };
    });
    wrap(<Mods />);
    await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
    await userEvent.click(await screen.findByRole('button', { name: /Pas à jour · 1/ }));
    const before = calls.filter((c) => c.url.includes('/mods/diff')).length;
    await userEvent.click(screen.getByRole('button', { name: 'Épingler a' }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/mods/diff')).length).toBeGreaterThan(before));
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
    expect((await screen.findByRole('button', { name: /^Tout · / })).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('App session handling', () => {
  it('falls back to the login form when a page call answers 401', async () => {
    let loggedOut = false;
    mockApi((url) => {
      if (url.includes('/auth/me')) return loggedOut ? { status: 401, body: { error: 'unauthorized' } } : { body: { ok: true } };
      if (url.includes('/settings')) return { body: { packs: { upstream: 'Base', own: 'Own' } } };
      loggedOut = true;
      return { status: 401, body: { error: 'unauthorized' } };
    });
    wrap(<App />);
    expect(await screen.findByLabelText('Mot de passe')).toBeTruthy();
  });
});
