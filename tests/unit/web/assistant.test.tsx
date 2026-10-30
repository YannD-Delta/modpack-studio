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

  it('shows Studio own error text (no code) instead of an API error wording', async () => {
    runReply = { status: 409, body: { error: 'both profiles must be imported first' } };
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText('both profiles must be imported first')).toBeTruthy();
    expect(screen.queryByText(/erreur inattendue/)).toBeNull();
  });

  it('reserves the API wording for the unexpected code', async () => {
    runReply = { status: 502, body: { error: 'the API answered 500', code: 'unexpected' } };
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText(/erreur inattendue/)).toBeTruthy();
  });

  it('says Studio is unreachable when the request itself fails', async () => {
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    const btn = await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    await userEvent.click(btn);
    expect(await screen.findByText(/Studio est injoignable/)).toBeTruthy();
  });

  it('shows an answer cut at max_tokens with a visible marker', async () => {
    runReply = { status: 200, body: { text: 'Début de réponse', model: 'm', effort: 'high', inputTokens: 1, outputTokens: 2, rows: 1, shown: 1, truncated: true, code: 'truncated' } };
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText('Début de réponse')).toBeTruthy();
    expect(screen.getByText(/Réponse coupée/)).toBeTruthy();
  });

  it('shows the server message for an error code it does not know', async () => {
    runReply = { status: 502, body: { error: 'something new happened', code: 'brand_new_code' } };
    wrap(<ClaudeActions base={1} other={2} actions={['review-updates']} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText('something new happened')).toBeTruthy();
  });

  it('clears the answer when the profile pair changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (b: number, o: number) => <QueryClientProvider client={client}><ClaudeActions base={b} other={o} actions={['review-updates']} /></QueryClientProvider>;
    const { rerender } = render(ui(1, 2));
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    expect(await screen.findByText('Garde alpha, retire beta.')).toBeTruthy();
    rerender(ui(1, 3));
    expect(screen.queryByText('Garde alpha, retire beta.')).toBeNull();
  });

  it('ignores an answer that arrives after the pair changed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (b: number, o: number) => <QueryClientProvider client={client}><ClaudeActions base={b} other={o} actions={['review-updates']} /></QueryClientProvider>;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/assistant/run')) await gate;
      return baseFetch(input, init);
    });
    const { rerender } = render(ui(1, 2));
    await userEvent.click(await screen.findByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }));
    rerender(ui(1, 3));
    release();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Lancer avec Claude : Mises à jour proposées' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Garde alpha, retire beta.')).toBeNull();
  });
});
