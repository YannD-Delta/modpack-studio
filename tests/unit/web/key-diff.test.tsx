// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyDiffData } from '../../../src/web/api-keys.js';
import { KeyDiff, KeyDiffBody } from '../../../src/web/components/KeyDiff.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const data = (over: Partial<KeyDiffData>): KeyDiffData => ({
  path: 'config/game.toml',
  format: 'toml',
  parsable: true,
  baseSize: 10,
  otherSize: 12,
  stale: false,
  diff: { added: [], removed: [], changed: [], moved: [] },
  counts: { added: 0, removed: 0, changed: 0, moved: 0 },
  ...over,
});

describe('KeyDiffBody', () => {
  it('shows changed, moved, added and removed keys', () => {
    render(
      <KeyDiffBody
        data={data({
          diff: {
            changed: [{ key: 'general.speed', old: '1', new: '3' }],
            moved: [{ from: 'old.limit', to: 'new.limit', value: '5' }],
            added: [{ key: 'general.extra', value: 'true' }],
            removed: [{ key: 'general.gone', value: '9' }],
          },
        })}
      />,
    );
    const changed = within(screen.getByTestId('keys-changed'));
    expect(changed.getByText('general.speed')).toBeTruthy();
    expect(changed.getByText('1')).toBeTruthy();
    expect(changed.getByText('3')).toBeTruthy();
    expect(within(screen.getByTestId('keys-moved')).getByText('new.limit')).toBeTruthy();
    expect(within(screen.getByTestId('keys-added')).getByText('general.extra')).toBeTruthy();
    expect(within(screen.getByTestId('keys-removed')).getByText('general.gone')).toBeTruthy();
  });

  it('says so when nothing differs', () => {
    render(<KeyDiffBody data={data({})} />);
    expect(screen.getByText('Aucune clé ne diffère.')).toBeTruthy();
  });

  it('shows the lines fallback message when the file cannot be read key by key', () => {
    render(<KeyDiffBody data={data({ parsable: false, reason: 'unparsable', detail: 'expected a value' })} />);
    expect(screen.getByText(/voyez la comparaison par lignes/)).toBeTruthy();
    expect(screen.queryByTestId('key-diff')).toBeNull();
  });
});

describe('KeyDiff', () => {
  it('loads the key diff of a file', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toContain('/configs/keydiff?base=2&other=3&path=config%2Fgame.toml');
      return new Response(JSON.stringify(data({ diff: { added: [{ key: 'a', value: '1' }], removed: [], changed: [], moved: [] } })), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <KeyDiff base="2" other="3" path="config/game.toml" />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('keys-added')).toBeTruthy();
  });
});
