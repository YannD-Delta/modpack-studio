// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurseForgeUpdates } from '../../../src/web/components/CurseForgeUpdates.js';

const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CurseForgeUpdates profileId={3} /></QueryClientProvider>);
const answer = (status: number, body: unknown) => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return urls;
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CurseForge updates panel', () => {
  it('lists the newer files with a link to the mod page', async () => {
    const urls = answer(200, {
      gameVersion: '1.21.1', loader: 'neoforge', checked: 3, upToDate: 1, noSources: false, failed: [{ projectId: 9, name: 'gamma', code: 'unexpected' }],
      updates: [{ projectId: 1, name: 'alpha', url: 'https://www.curseforge.com/minecraft/mc-mods/alpha', installed: { fileId: 10, fileName: 'alpha-10.jar' }, latest: { id: 11, displayName: 'f', fileName: 'alpha-11.jar', fileDate: '2026-02-01T00:00:00Z', releaseType: 1 } }],
    });
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'Chercher les mises à jour' }));
    expect((await screen.findByTestId('curseforge-summary')).textContent).toBe('3 mods vérifiés : 1 ont une version plus récente, 1 sont à jour, 1 non vérifiés.');
    expect(screen.getByRole('link', { name: 'alpha' }).getAttribute('href')).toBe('https://www.curseforge.com/minecraft/mc-mods/alpha');
    expect(screen.getByText('alpha-11.jar')).toBeTruthy();
    expect(urls[0]).toBe('/api/v1/curseforge/updates?profile=3');
  });

  it('includes pre-releases only when asked', async () => {
    const urls = answer(200, { gameVersion: null, loader: null, checked: 0, upToDate: 0, noSources: true, failed: [], updates: [] });
    wrap();
    await userEvent.click(screen.getByLabelText('Inclure les bêtas et alphas'));
    await userEvent.click(screen.getByRole('button', { name: 'Chercher les mises à jour' }));
    expect(await screen.findByText(/Aucun mod de ce profil n'a de lien CurseForge/)).toBeTruthy();
    expect(urls[0]).toContain('preRelease=1');
  });

  it('tells the user to add the key, and reports a refused key, in French', async () => {
    answer(409, { error: 'no CurseForge key saved: add it in Settings', code: 'no_key' });
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'Chercher les mises à jour' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Ajoute ta clé CurseForge dans Réglages.');
    cleanup();
    answer(502, { error: 'CurseForge refused the key', code: 'rejected' });
    wrap();
    await userEvent.click(screen.getByRole('button', { name: 'Chercher les mises à jour' }));
    expect((await screen.findByRole('alert')).textContent).toBe('CurseForge a refusé la clé.');
  });
});
