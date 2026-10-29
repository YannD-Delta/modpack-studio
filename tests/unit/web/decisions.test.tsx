// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decisions } from '../../../src/web/pages/Decisions.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: string }[] = [];

const memory = {
  decisions: [
    { modId: 'oldmod', kind: 'pin', side: null, reason: 'keep 1.0', createdAt: '2026-03-01T10:00:00.000Z' },
    { modId: 'hud', kind: 'side', side: 'client', reason: '', createdAt: '2026-03-02T10:00:00.000Z' },
  ],
  blacklist: [{ modId: 'mine', origin: 'yann', reason: 'crash', createdAt: null }],
  atmDerivedCount: 7,
};
const info = {
  studioVersion: '0.1.0',
  node: 'v24.0.0',
  platform: 'win32 x64',
  uptimeSeconds: 3725,
  dataDir: 'C:\\synthetic\\data',
  db: { file: 'C:\\synthetic\\data\\studio.db', sizeBytes: 2048, migrations: 1 },
  counts: { profiles: 3, jars: 10, modRows: 12, decisions: { pin: 1, ignore: 0, side: 1 }, blacklist: { yann: 1, atmDerived: 7 }, jobs: { queued: 0, running: 0, done: 1, failed: 1, cancelled: 0, interrupted: 0 }, auditEntries: 4 },
};
const auditPage1 = {
  entries: [
    { id: 9, at: '2026-03-03T10:00:00.000Z', actor: 'user', action: 'decision.set', target: 'oldmod', payload: { kind: 'pin', reason: 'keep 1.0' }, payloadValid: true },
    { id: 8, at: '2026-03-03T09:00:00.000Z', actor: 'user', action: 'weird', target: null, payload: '{oops', payloadValid: false },
  ],
  nextBefore: 8,
};
const auditPage2 = { entries: [{ id: 3, at: '2026-03-01T09:00:00.000Z', actor: 'user', action: 'blacklist.add', target: 'mine', payload: { reason: 'crash' }, payloadValid: true }], nextBefore: null };
const jobs = {
  jobs: [
    { id: 'job-1', type: 'import', status: 'failed', progress: 40, message: 'cannot read synthetic.jar: bad zip header', lockKey: 'profile:1', params: '{"path":"x"}', paramsTruncated: false, createdAt: '2026-03-03T10:00:00.000Z', updatedAt: '2026-03-03T10:01:00.000Z' },
    { id: 'job-2', type: 'export', status: 'done', progress: 100, message: null, lockKey: null, params: 'null', paramsTruncated: false, createdAt: '2026-03-03T09:00:00.000Z', updatedAt: '2026-03-03T09:01:00.000Z' },
  ],
};

function mockApi(handler: Handler = () => undefined) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = handler(url, init) ?? defaults(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}
function defaults(url: string, init?: RequestInit): { status?: number; body: unknown } {
  if (init?.method && init.method !== 'GET') return { body: { ok: true } };
  if (url.endsWith('/decisions')) return { body: memory };
  if (url.includes('/debug/info')) return { body: info };
  if (url.includes('/debug/audit')) return { body: url.includes('before=8') ? auditPage2 : auditPage1 };
  if (url.includes('/debug/jobs')) return { body: jobs };
  return { body: {} };
}
const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Decisions memory', () => {
  beforeEach(() => mockApi());

  it('shows each section, its rows, French empty states and the intro', async () => {
    wrap(<Decisions />);
    expect(await screen.findByText('oldmod')).toBeTruthy();
    expect(screen.getByText(/Une décision, c'est un choix/)).toBeTruthy();
    for (const title of ['Épinglés', 'Retraits acceptés', 'Côté forcé', 'Liste noire (à toi)']) expect(screen.getByRole('heading', { name: new RegExp(title.replace(/[()]/g, '\\$&')) })).toBeTruthy();
    expect(screen.getByText('Aucun retrait accepté.')).toBeTruthy();
    expect(screen.getByText('hud')).toBeTruthy();
    expect(screen.getByText('client')).toBeTruthy();
    expect(screen.getByText('mine')).toBeTruthy();
    expect(screen.getByText('Date inconnue')).toBeTruthy();
    expect(screen.getByText(/7 mods exclus automatiquement/)).toBeTruthy();
  });

  it('asks an inline confirmation before undoing, and can back out', async () => {
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler oldmod' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Non' }));
    expect(screen.queryByRole('button', { name: 'Confirmer ?' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Annuler oldmod' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer ?' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/decisions/oldmod/pin'));
  });

  it('removes a blacklist entry through its own route', async () => {
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler mine' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer ?' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/blacklist/entry/mine'));
  });

  it('edits a reason inline', async () => {
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: 'keep 1.0' }));
    const input = screen.getByLabelText('Raison');
    await userEvent.clear(input);
    await userEvent.type(input, 'still needed');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put?.url).toBe('/api/v1/decisions/oldmod/pin/reason');
      expect(JSON.parse(put!.body!)).toEqual({ reason: 'still needed' });
    });
  });

  it('shows the server error when an undo fails', async () => {
    mockApi((_url, init) => (init?.method === 'DELETE' ? { status: 409, body: { error: 'comes from ATM10' } } : undefined));
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler mine' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer ?' }));
    expect(await screen.findByText(/Échec : comes from ATM10/)).toBeTruthy();
  });

  it('shows French empty states for an empty memory', async () => {
    mockApi((url) => (url.endsWith('/decisions') ? { body: { decisions: [], blacklist: [], atmDerivedCount: 0 } } : undefined));
    wrap(<Decisions />);
    expect(await screen.findByText('Aucune version épinglée.')).toBeTruthy();
    expect(screen.getByText('Aucun côté forcé.')).toBeTruthy();
    expect(screen.getByText('Aucun mod dans ta liste noire.')).toBeTruthy();
  });

  it('gives every button and badge a hover explanation', async () => {
    wrap(<Decisions />);
    await screen.findByText('oldmod');
    await screen.findByText('v24.0.0');
    await userEvent.click(screen.getByRole('button', { name: 'Annuler oldmod' }));
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('title'), b.textContent ?? '').toBeTruthy();
    for (const badge of document.querySelectorAll('[data-badge]')) expect(badge.getAttribute('title'), badge.textContent ?? '').toBeTruthy();
    expect(document.querySelectorAll('[data-badge]').length).toBeGreaterThan(0);
  });
});

describe('Debug area', () => {
  beforeEach(() => mockApi());

  it('lists app facts and copies them as JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(<Decisions />);
    expect(await screen.findByText('v24.0.0')).toBeTruthy();
    expect(screen.getByText('C:\\synthetic\\data')).toBeTruthy();
    expect(screen.getByText('1 h 2 min 5 s')).toBeTruthy();
    expect(screen.getByText('2,0 Kio')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copier (JSON)' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual(info);
    expect(await screen.findByText('Copié')).toBeTruthy();
  });

  it('shows the journal, expands a payload, searches and loads more', async () => {
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: 'Journal' }));
    expect(await screen.findByText('decision.set')).toBeTruthy();
    await userEvent.click(screen.getAllByText('Détails')[0]!);
    expect(screen.getByText(/"reason": "keep 1.0"/)).toBeTruthy();
    expect(screen.getByText(/JSON invalide/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Charger plus' }));
    expect(await screen.findByText('blacklist.add')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/debug/audit') && c.url.includes('before=8'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Charger plus' })).toBeNull();

    await userEvent.type(screen.getByLabelText('Rechercher dans le journal'), 'mine{Enter}');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/debug/audit') && c.url.includes('q=mine'))).toBe(true));
  });

  it('shows jobs with French statuses, failed messages in full, and refreshes every 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap(<Decisions />);
    fireEvent.click(await screen.findByRole('button', { name: /Tâches/ }));
    const failed = await screen.findByText('cannot read synthetic.jar: bad zip header');
    expect(failed.className).toMatch(/rose/);
    const list = screen.getByTestId('jobs');
    expect(within(list).getByText('en échec')).toBeTruthy();
    expect(within(list).getByText('terminée')).toBeTruthy();
    expect(screen.getByText('1 en échec')).toBeTruthy();

    const before = calls.filter((c) => c.url.includes('/debug/jobs')).length;
    await vi.advanceTimersByTimeAsync(5100);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/debug/jobs')).length).toBeGreaterThan(before));
  });

  it('filters jobs by status', async () => {
    wrap(<Decisions />);
    await userEvent.click(await screen.findByRole('button', { name: /Tâches/ }));
    await userEvent.selectOptions(await screen.findByLabelText('Statut'), 'failed');
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/debug/jobs?status=failed'))).toBe(true));
  });
});
