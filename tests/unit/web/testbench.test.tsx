// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBench } from '../../../src/web/pages/TestBench.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;
let calls: { url: string; method: string; body?: string }[] = [];
let startReply: { status?: number; body: unknown };

const profile = (id: number, side: string, kind = 'folder') => ({ id, pack: 'LMP', version: 'test', side, state: 'launched', locationKind: kind, location: `/x/${id}`, immutable: true });
const matrix = [
  { pack: 'LMP', version: 'test', cells: { 'server-launched': profile(5, 'server'), 'client-launched': profile(6, 'client'), 'server-clean': profile(7, 'server', 'zip'), 'client-clean': null, 'client-run': null, 'server-run': null } },
];
const run = {
  id: '20261029-120000_LMP-test-launched',
  profileId: 5,
  label: 'LMP test · server · launched',
  memoryMb: 8192,
  port: 25570,
  createdAt: '2026-10-29T12:00:00.000Z',
  jobId: 'j1',
  status: 'crashed',
  message: null,
  bootSeconds: null,
  errorLines: 2,
  warnLines: 1,
  crashReports: 1,
};
const detail = {
  meta: { id: run.id, profileId: 5, label: run.label, memoryMb: 8192, port: 25570, createdAt: run.createdAt, jobId: 'j1' },
  status: 'crashed',
  message: null,
  result: { status: 'crashed', bootSeconds: null, exitCode: 1, startedAt: 'a', endedAt: 'b', summary: { bootSeconds: null, errorLines: 2, warnLines: 1, firstErrors: ['[main/ERROR] [mod_x]: Failed to load mod_x'] }, crashReports: ['crash-1.txt'], modJars: 531, disabledMods: [] },
};

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
  startReply = { status: 202, body: { runId: run.id, jobId: 'j1' } };
  mockApi((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/profiles/matrix')) return { body: matrix };
    if (url.endsWith('/testbench/runs')) return { body: [run] };
    if (url.endsWith('/testbench/server') && method === 'POST') return startReply;
    if (url.includes('/log')) return { body: { lines: ['[10:00:01] [main/ERROR] [mod_x]: Failed to load mod_x'], total: 1 } };
    if (url.includes(`/testbench/runs/${run.id}`)) return { body: detail };
    if (url.endsWith('/assistant/actions')) return { body: [{ id: 'analyze-test-run', label: 'Analyser ce test', tip: 'Claude lit le journal du test.' }] };
    if (url.endsWith('/settings')) return { body: { keys: { claude: { configured: true, last4: 'abcd' }, curseforge: { configured: false, last4: null } }, assistant: { model: 'claude-sonnet-5-5', effort: 'medium' }, models: [], efforts: [] } };
    return { body: {} };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TestBench page', () => {
  it('offers only server profiles that are folders, and starts a test with the chosen options', async () => {
    wrap(<TestBench />);
    const select = await screen.findByLabelText('Serveur à tester');
    await screen.findByRole('option', { name: 'LMP test · server · launched' });
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toContain('LMP test · server · launched');
    expect(options).not.toContain('LMP test · client · launched');
    expect(options).not.toContain('LMP test · server · clean'); // a zip cannot be tested yet
    await userEvent.selectOptions(select, '5');
    await userEvent.click(screen.getByLabelText(/Accepter l'EULA/));
    await userEvent.click(screen.getByRole('button', { name: 'Lancer le test' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/testbench/server'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/testbench/server'))!.body!)).toEqual({ profile: 5, acceptEula: true, memoryMb: 8192, port: 25570, timeoutMin: 10 });
    expect(await screen.findByText('Test lancé')).toBeTruthy();
  });

  it('shows the previous runs with their outcome, the first errors and the log of the selected one', async () => {
    wrap(<TestBench />);
    expect((await screen.findAllByText('plantage')).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Rapports de plantage : crash-1.txt/)).toBeTruthy();
    expect(screen.getAllByText(/Failed to load mod_x/).length).toBeGreaterThan(0);
    expect(screen.getByText(/531 jars de mods/)).toBeTruthy();
  });

  it('offers the Claude analysis once the test is finished', async () => {
    wrap(<TestBench />);
    expect(await screen.findByRole('button', { name: 'Copier le prompt : Analyser ce test' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lancer avec Claude : Analyser ce test' })).toBeTruthy();
  });

  it('shows the reason when the server cannot be tested', async () => {
    startReply = { status: 409, body: { error: 'the server folder of this profile cannot be read' } };
    wrap(<TestBench />);
    const select = await screen.findByLabelText('Serveur à tester');
    await screen.findByRole('option', { name: 'LMP test · server · launched' });
    await userEvent.selectOptions(select, '5');
    await userEvent.click(screen.getByRole('button', { name: 'Lancer le test' }));
    expect(await screen.findByText(/cannot be read/)).toBeTruthy();
  });
});
