// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../../src/web/pages/Settings.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: string }[] = [];
let state: { keys: Record<string, { configured: boolean; last4: string | null }>; assistant: { model: string; effort: string } };

const models = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
];

function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = handler(url, init) ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

beforeEach(() => {
  state = { keys: { claude: { configured: false, last4: null }, curseforge: { configured: true, last4: 'wxyz' } }, assistant: { model: 'claude-sonnet-5-5', effort: 'medium' } };
  mockApi((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/settings') && method === 'GET') return { body: { ...state, models, efforts: ['low', 'medium', 'high'] } };
    if (url.endsWith('/settings/keys') && method === 'PUT') {
      const b = JSON.parse(init!.body as string) as { provider: string; key: string };
      state.keys[b.provider] = { configured: true, last4: b.key.slice(-4) };
      return { body: { ok: true } };
    }
    if (url.endsWith('/settings/keys/test')) return { body: { ok: false, code: 'rejected', status: 401 } };
    if (url.includes('/settings/keys/') && method === 'DELETE') {
      state.keys.curseforge = { configured: false, last4: null };
      return { body: { ok: true } };
    }
    if (url.endsWith('/settings/packs')) return { body: { ok: true, packs: JSON.parse(init!.body as string) } };
    if (url.endsWith('/settings/assistant')) {
      state.assistant = JSON.parse(init!.body as string);
      return { body: { ok: true } };
    }
    return { body: {} };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings page', () => {
  it('shows what is configured without ever showing a key', async () => {
    wrap(<Settings />);
    expect(await screen.findByText(/non définie/)).toBeTruthy();
    expect(screen.getByText(/••••wxyz/)).toBeTruthy();
  });

  it('saves a typed key, clears the field and shows only the last 4 characters', async () => {
    wrap(<Settings />);
    const field = (await screen.findByLabelText('Clé API Claude')) as HTMLInputElement;
    expect(field.type).toBe('password');
    await userEvent.type(field, 'sk-test-0123456789abcdef');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la clé Claude' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/settings/keys'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ provider: 'claude', key: 'sk-test-0123456789abcdef' });
    await waitFor(() => expect(field.value).toBe(''));
    expect(await screen.findByText(/••••cdef/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-test-0123456789abcdef');
  });

  it('tests a key and explains a refusal in French', async () => {
    wrap(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tester la clé CurseForge' }));
    expect(await screen.findByText(/refusée/i)).toBeTruthy();
  });

  it('removes a key after an inline confirmation', async () => {
    wrap(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Supprimer la clé CurseForge' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/settings/keys/curseforge'))).toBe(true));
  });

  it('saves the assistant model and effort', async () => {
    wrap(<Settings />);
    await userEvent.selectOptions(await screen.findByLabelText('Modèle'), 'claude-opus-5-5');
    await userEvent.selectOptions(screen.getByLabelText('Effort'), 'high');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer l’assistant' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/settings/assistant'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/settings/assistant'))!.body!)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('renames the two packs from Settings', async () => {
    wrap(<Settings />);
    const own = await screen.findByLabelText('Ton pack');
    expect((own as HTMLInputElement).value).toBe('Own');
    expect((screen.getByLabelText('Pack suivi (référence)') as HTMLInputElement).value).toBe('Base');
    const save = screen.getByRole('button', { name: 'Enregistrer les noms' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.clear(own);
    await userEvent.type(own, 'MonPack');
    await userEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/settings/packs'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/settings/packs'))!.body!)).toEqual({ upstream: 'Base', own: 'MonPack' });
    expect(await screen.findByText('Noms enregistrés')).toBeTruthy();
  });
});
