// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../../src/web/api.js';

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

afterEach(() => vi.unstubAllGlobals());

describe('ApiError', () => {
  it('keeps the stable code and the whole body of a failed answer', async () => {
    answer(502, { error: 'the Anthropic API is unreachable', code: 'unreachable', extra: 1 });
    const err = await api('/assistant/review').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(502);
    expect(e.message).toBe('the Anthropic API is unreachable');
    expect(e.code).toBe('unreachable');
    expect(e.body).toMatchObject({ extra: 1 });
  });

  it('has no code when the server sent none', async () => {
    answer(404, { error: 'profile not found' });
    const e = (await api('/profiles/9').catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBeUndefined();
    expect(e.message).toBe('profile not found');
  });
});

describe('session loss', () => {
  it('announces a 401 on any normal call, but not on the auth endpoints', async () => {
    const { UNAUTHORIZED_EVENT } = await import('../../../src/web/api.js');
    let fired = 0;
    const on = () => fired++;
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    answer(401, { error: 'unauthorized' });
    await api('/profiles/matrix').catch(() => undefined);
    expect(fired).toBe(1);
    await api('/auth/me').catch(() => undefined);
    await api('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    expect(fired).toBe(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, on);
  });

  it('never retries a client error, retries other failures a bounded number of times', async () => {
    const { shouldRetry, QUERY_RETRY_LIMIT } = await import('../../../src/web/api.js');
    expect(shouldRetry(0, new ApiError(401, 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, 'x'))).toBe(true);
    expect(shouldRetry(QUERY_RETRY_LIMIT, new ApiError(500, 'x'))).toBe(false);
    expect(shouldRetry(0, new TypeError('network'))).toBe(true);
  });
});
