// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeActions } from '../../../src/web/components/ClaudeActions.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: string }[] = [];
let hasKey = true;
let runReply: { status?: number; body: unknown };
let clipboardOk = true;
let copied: string[] = [];

const actions = [
  { id: 'review-updates', label: 'Mises à jour proposées', tip: 'Claude dit pour chaque mod pas à jour si la mise à jour vaut le coup.' },
  { id: 'review-added', label: 'Mods ajoutés', tip: 'Claude dit si les mods que tu as ajoutés sont utiles.' },
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
  hasKey = true;
  clipboardOk = true;
  copied = [];
  runReply = { body: { text: 'Garde alpha, retire beta.', model: 'claude-sonnet-5-5', effort: 'medium', inputTokens: 800, outputTokens: 120, rows: 12, shown: 12 } };
  vi.stubGlobal('navigator', { clipboard: { writeText: async (s: string) => { if (!clipboardOk) throw new Error('denied'); copied.push(s); } } });
  mockApi((url) => {
    if (url.endsWith('/assistant/actions')) return { body: actions };
    if (url.endsWith('/settings')) return { body: { keys: { claude: { configured: hasKey, last4: hasKey ? 'abcd' : null }, curseforge: { configured: false, last4: null } }, assistant: { model: 'claude-sonnet-5-5', effort: 'medium' }, models: [], efforts: [] } };
    if (url.endsWith('/assistant/prompt')) return { body: { action: 'review-updates', title: 'x', prompt: 'PROMPT TEXT with https://www.curseforge.com/projects/7', rows: 3, shown: 3 } };
    if (url.endsWith('/assistant/run')) return runReply;
    return { body: {} };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClaudeActions', () => {
  it('shows only the actions it is given, with their plain explanation', async () => {
    wrap(<ClaudeActions base={1} other={2} actions={['review-added']} />);
    expect(await screen.findByText('Mods ajoutés')).toBeTruthy();
    expect(screen.queryByText('Mises à jour proposées')).toBeNull();
  });

  it('copies a ready-made prompt for the chosen pair and says how long it is', async () => {
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Copier le prompt : Mises à jour proposées' }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('curseforge.com/projects/7');
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/assistant/prompt'))!.body!)).toEqual({ action: 'review-updates', base: 1, other: 2, mode: 'chat' });
    expect(await screen.findByText(/Prompt copié \(\d+ caractères\)/)).toBeTruthy();
  });

  it('falls back to a selectable text when the browser refuses the clipboard', async () => {
    clipboardOk = false;
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Copier le prompt : Mises à jour proposées' }));
    expect(await screen.findByText(/refuse la copie/)).toBeTruthy();
    expect((screen.getByLabelText('Copier le prompt') as HTMLTextAreaElement).value).toContain('PROMPT TEXT');
  });

  it('runs the action through the API and shows the answer with its model and effort', async () => {
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText('Garde alpha, retire beta.')).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/assistant/run'))!.body!)).toEqual({ action: 'review-updates', base: 1, other: 2 });
    expect(screen.getByText(/claude-sonnet-5-5 · effort medium · 800 jetons envoyés, 120 reçus/)).toBeTruthy();
  });

  it('explains a refused key in French', async () => {
    runReply = { status: 502, body: { error: 'the API refused the key', code: 'rejected' } };
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText(/refusé la clé/)).toBeTruthy();
  });

  it('disables the run button without a key but still allows copying', async () => {
    hasKey = false;
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    const run = (await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' })) as HTMLButtonElement;
    await waitFor(() => expect(run.disabled).toBe(true));
    expect(run.getAttribute('title')).toMatch(/clé API Claude dans Réglages/);
    expect((screen.getByRole('button', { name: 'Copier le prompt : Mises à jour proposées' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks for the two profiles first and disables both buttons', async () => {
    wrap(<ClaudeActions base={null} other={null} actions={['review-updates']} />);
    expect(await screen.findByText(/Choisis les deux profils/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Copier le prompt : Mises à jour proposées' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
