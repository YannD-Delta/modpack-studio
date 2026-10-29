// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  cleanup();
  vi.unstubAllGlobals();
});

const profile = (id: number, pack: string, version: string, side: string, state: string, kind = 'folder') => ({ id, packVersionId: 1, pack, version, side, state, locationKind: kind, location: 'x', immutable: true });
const matrix = [
  { pack: 'ATM10', version: '8.3', cells: { 'server-clean': profile(1, 'ATM10', '8.3', 'server', 'clean', 'zip'), 'client-clean': profile(2, 'ATM10', '8.3', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-launched': null, 'server-run': null } },
  { pack: 'LMP', version: '1.0', cells: { 'client-clean': profile(3, 'LMP', '1.0', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } },
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
    expect(await screen.findByText('ATM10 8.3')).toBeTruthy();
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
    expect(await screen.findByText(/Manque dans LMP 1.0 : présent dans ATM10 8\.3, absent de LMP 1.0\./)).toBeTruthy();
    expect(screen.getByText(/Nouveau dans LMP 1.0 : absent de ATM10 8\.3\./)).toBeTruthy();
    expect(screen.getByText(/LMP 1.0 est plus récent que ATM10 8.3./)).toBeTruthy();
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
    await userEvent.selectOptions(await screen.findByLabelText('Pack serveur ATM10'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Client ATM10'), '2');
    expect(await screen.findByText('périmé')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter tout (ATM)' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBe(1));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ action: 'adopt-atm', server: 1, client: 2 });
  });
});
